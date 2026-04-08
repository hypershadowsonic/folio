/**
 * Yahoo Finance API client with IndexedDB price cache.
 *
 * All price fetch calls check the cache first (24h TTL).
 * On network failure, stale cache is returned as a fallback and
 * apiStatus in uiStore is updated accordingly.
 */

import { useEffect, useState } from 'react'
import { db } from '@/db/database'
import { useUIStore } from '@/stores/uiStore'
import { captureSnapshot } from '@/db/snapshotService'
import type { PricePoint, TickerSearchResult, CacheStats, PriceCache, Holding } from '@/types'

const API_BASE = '/api'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000   // 24 hours

// ─── Currency detection ───────────────────────────────────────────────────────

export function detectCurrency(tickerOrResult: string | TickerSearchResult): 'USD' | 'TWD' {
  const ticker = typeof tickerOrResult === 'string' ? tickerOrResult : tickerOrResult.ticker
  const exchange = typeof tickerOrResult === 'string' ? '' : tickerOrResult.exchange
  if (ticker.endsWith('.TW') || exchange.toLowerCase().includes('taiwan')) return 'TWD'
  return 'USD'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isCacheFresh(cache: PriceCache): boolean {
  return Date.now() - cache.fetchedAt.getTime() < CACHE_TTL_MS
}

function cacheCoversRange(cache: PriceCache, start: string, end: string): boolean {
  const cacheStart = cache.startDate instanceof Date
    ? cache.startDate.toISOString().slice(0, 10)
    : String(cache.startDate)
  const cacheEnd = cache.endDate instanceof Date
    ? cache.endDate.toISOString().slice(0, 10)
    : String(cache.endDate)
  return cacheStart <= start && cacheEnd >= end
}

function filterPricesInRange(prices: PricePoint[], start: string, end: string): PricePoint[] {
  return prices.filter((p) => p.date >= start && p.date <= end)
}

/** Merge two price arrays by date, keeping the latest value on collision. */
function mergePrices(existing: PricePoint[], incoming: PricePoint[]): PricePoint[] {
  const map = new Map<string, number>()
  for (const p of existing) map.set(p.date, p.adjustedClose)
  for (const p of incoming) map.set(p.date, p.adjustedClose)
  return Array.from(map.entries())
    .map(([date, adjustedClose]) => ({ date, adjustedClose }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ─── Ticker Search ────────────────────────────────────────────────────────────

/**
 * Search for tickers via the /api/search endpoint.
 * Updates apiStatus in uiStore on success/failure.
 */
export async function searchTickers(
  query: string,
  signal?: AbortSignal,
): Promise<TickerSearchResult[]> {
  const setApiStatus = useUIStore.getState().setApiStatus
  try {
    const res = await fetch(
      `${API_BASE}/search?q=${encodeURIComponent(query)}`,
      { signal },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as TickerSearchResult[]
    setApiStatus('online')
    return data
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    setApiStatus('offline-no-cache')
    return []
  }
}

// ─── Price Fetch ──────────────────────────────────────────────────────────────

/**
 * Fetch adjusted close prices for a ticker over a date range.
 *
 * Cache strategy:
 * 1. If fresh cache exists and covers the range → return from cache
 * 2. Otherwise fetch from API, upsert into cache
 * 3. On network failure → return stale cache if available, else throw
 */
export async function fetchPrices(
  ticker: string,
  start: string,
  end: string,
): Promise<PricePoint[]> {
  const setApiStatus = useUIStore.getState().setApiStatus

  // 1. Check cache
  const cached = await db.priceCaches.get(ticker)
  if (cached && isCacheFresh(cached) && cacheCoversRange(cached, start, end)) {
    return filterPricesInRange(cached.prices, start, end)
  }

  // 2. Fetch from API
  try {
    const res = await fetch(
      `${API_BASE}/prices?ticker=${encodeURIComponent(ticker)}&start=${start}&end=${end}`,
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const incoming = await res.json() as PricePoint[]

    // Merge with any existing cached prices and upsert
    const merged = cached ? mergePrices(cached.prices, incoming) : incoming
    const allDates = merged.map((p) => p.date)
    const newCacheEntry: PriceCache = {
      ticker,
      startDate: allDates.length > 0 ? new Date(allDates[0]) : new Date(start),
      endDate: allDates.length > 0 ? new Date(allDates[allDates.length - 1]) : new Date(end),
      interval: '1d',
      prices: merged,
      fetchedAt: new Date(),
    }
    await db.priceCaches.put(newCacheEntry)

    setApiStatus('online')
    return filterPricesInRange(merged, start, end)
  } catch (err) {
    // 3. Network failure fallback
    if (cached) {
      setApiStatus('offline-cached')
      return filterPricesInRange(cached.prices, start, end)
    }
    setApiStatus('offline-no-cache')
    throw new Error(`Failed to fetch prices for ${ticker}: ${String(err)}`)
  }
}

// ─── Multi-ticker fetch ───────────────────────────────────────────────────────

/**
 * Fetch prices for multiple tickers in parallel.
 * Returns partial results — missing tickers have empty arrays.
 */
export async function fetchMultiplePrices(
  tickers: string[],
  start: string,
  end: string,
): Promise<Record<string, PricePoint[]>> {
  const results = await Promise.all(
    tickers.map((ticker) =>
      fetchPrices(ticker, start, end).catch((): PricePoint[] => []),
    ),
  )
  return Object.fromEntries(tickers.map((t, i) => [t, results[i]]))
}

// ─── FX Rate ─────────────────────────────────────────────────────────────────

/** Fetch USD/TWD exchange rate history (Yahoo Finance ticker USDTWD=X). */
export async function fetchFxRate(start: string, end: string): Promise<PricePoint[]> {
  return fetchPrices('USDTWD=X', start, end)
}

// ─── Portfolio refresh ────────────────────────────────────────────────────────

/**
 * Fetch the latest prices for all active holdings and update
 * `currentPricePerShare` in the database. Captures one snapshot afterwards.
 *
 * Uses a 7-day window so we always get at least one trading day even
 * around weekends/holidays.
 */
export async function refreshAllPrices(
  holdings: Holding[],
  portfolioId: string,
): Promise<void> {
  const end = new Date().toISOString().slice(0, 10)
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - 7)
  const start = startDate.toISOString().slice(0, 10)

  const tickers = [...new Set(holdings.map((h) => h.ticker))]
  const priceMap = await fetchMultiplePrices(tickers, start, end)

  await db.transaction('rw', db.holdings, async () => {
    for (const holding of holdings) {
      const prices = priceMap[holding.ticker]
      if (!prices || prices.length === 0) continue
      const latestPrice = prices[prices.length - 1].adjustedClose
      await db.holdings.update(holding.id, { currentPricePerShare: latestPrice })
    }
  })

  await captureSnapshot(portfolioId)
}

// ─── Latest cached price ──────────────────────────────────────────────────────

/**
 * Return the most recent cached `adjustedClose` for a ticker, or null if
 * no cache entry exists. Does NOT trigger a network request.
 */
export async function getLatestCachedPrice(ticker: string): Promise<number | null> {
  const cached = await db.priceCaches.get(ticker)
  if (!cached || cached.prices.length === 0) return null
  return cached.prices[cached.prices.length - 1].adjustedClose
}

// ─── Cache management ─────────────────────────────────────────────────────────

export async function getCacheStats(): Promise<CacheStats> {
  const all = await db.priceCaches.toArray()
  const totalPricePoints = all.reduce((sum, entry) => sum + entry.prices.length, 0)
  const dates = all.map((e) => e.fetchedAt)
  const oldest = dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null
  return {
    tickerCount: all.length,
    totalPricePoints,
    oldestFetchedAt: oldest,
  }
}

export async function clearCache(): Promise<void> {
  await db.priceCaches.clear()
}

// ─── useTickerSearch hook ─────────────────────────────────────────────────────

interface UseTickerSearchResult {
  results: TickerSearchResult[]
  isLoading: boolean
  error: string | null
}

/**
 * React hook for debounced ticker search with AbortController cleanup.
 * Clears results when query < 2 chars.
 */
export function useTickerSearch(query: string): UseTickerSearchResult {
  const [results, setResults] = useState<TickerSearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      setIsLoading(false)
      setError(null)
      return
    }

    setIsLoading(true)
    setError(null)

    const controller = new AbortController()

    const timer = setTimeout(async () => {
      try {
        const data = await searchTickers(query, controller.signal)
        setResults(data)
        setError(null)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        setError('Search failed. Check your connection.')
        setResults([])
      } finally {
        setIsLoading(false)
      }
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  return { results, isLoading, error }
}
