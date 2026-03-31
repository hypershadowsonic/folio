import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './index'
import type { Build, Benchmark, Compare, PriceCache } from '@/types'

// ─── Builds ───────────────────────────────────────────────────────────────────

/**
 * Returns all builds, favorites first then newest first.
 */
export function useBuilds(): Build[] {
  return useLiveQuery(
    async () => {
      const all = await db.builds.toArray()
      return all.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1
        return b.createdAt.getTime() - a.createdAt.getTime()
      })
    },
    [],
    [],
  ) ?? []
}

// ─── Benchmarks ───────────────────────────────────────────────────────────────

/**
 * Returns all benchmarks, favorites first then newest first.
 */
export function useBenchmarks(): Benchmark[] {
  return useLiveQuery(
    async () => {
      const all = await db.benchmarks.toArray()
      return all.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1
        return b.createdAt.getTime() - a.createdAt.getTime()
      })
    },
    [],
    [],
  ) ?? []
}

// ─── Compares ─────────────────────────────────────────────────────────────────

/**
 * Returns all compares, favorites first then newest first.
 */
export function useCompares(): Compare[] {
  return useLiveQuery(
    async () => {
      const all = await db.compares.toArray()
      return all.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1
        return b.createdAt.getTime() - a.createdAt.getTime()
      })
    },
    [],
    [],
  ) ?? []
}

// ─── Favorite ─────────────────────────────────────────────────────────────────

export type FavoriteItem =
  | { type: 'build'; item: Build }
  | { type: 'benchmark'; item: Benchmark }
  | { type: 'compare'; item: Compare }
  | null

/**
 * Returns the single favorited item across all three collections, or null.
 */
export function useFavorite(): FavoriteItem {
  return useLiveQuery(
    async () => {
      const [build, benchmark, compare] = await Promise.all([
        db.builds.filter((b) => b.isFavorite).first(),
        db.benchmarks.filter((b) => b.isFavorite).first(),
        db.compares.filter((b) => b.isFavorite).first(),
      ])
      if (build) return { type: 'build' as const, item: build }
      if (benchmark) return { type: 'benchmark' as const, item: benchmark }
      if (compare) return { type: 'compare' as const, item: compare }
      return null
    },
    [],
    null,
  ) ?? null
}

// ─── Price cache ──────────────────────────────────────────────────────────────

/**
 * Returns the cached price data for a ticker, or undefined if not cached.
 */
export function usePriceCache(ticker: string | undefined): PriceCache | undefined {
  return useLiveQuery(
    () => {
      if (!ticker) return undefined
      return db.priceCache.get(ticker)
    },
    [ticker],
  )
}
