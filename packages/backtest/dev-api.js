/**
 * Local development API server for Folio Build.
 *
 * Run alongside Vite:
 *   Terminal 1: npm run dev        (Vite on port 5174)
 *   Terminal 2: npm run dev:api    (this server on port 3001)
 *
 * Serves /api/search and /api/prices.
 * No external dependencies — requires Node 18+ (native fetch).
 * For production, Vercel uses api/search.js and api/prices.js instead.
 */

import http from 'node:http'
import { URL } from 'node:url'

const PORT = 3001

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
}

const TYPE_MAP = {
  ETF: 'ETF',
  EQUITY: 'Stock',
  INDEX: 'Index',
  MUTUALFUND: 'Fund',
  CURRENCY: 'Currency',
  CRYPTOCURRENCY: 'Crypto',
  FUTURE: 'Future',
  OPTION: 'Option',
}

async function handleSearch(searchParams, res) {
  const q = searchParams.get('q')
  if (!q) {
    res.writeHead(400, CORS_HEADERS)
    res.end(JSON.stringify({ error: 'q is required' }))
    return
  }
  try {
    const params = new URLSearchParams({
      q,
      lang: 'en-US',
      region: 'US',
      quotesCount: '8',
      newsCount: '0',
      enableFuzzyQuery: 'false',
      enableCb: 'false',
    })
    const response = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?${params}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      },
    )
    if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`)

    const data = await response.json()
    // Yahoo Finance returns quotes at top-level or nested under finance.result[0]
    const quotes = data?.quotes ?? data?.finance?.result?.[0]?.quotes ?? []
    const results = quotes.map((item) => ({
      ticker: item.symbol ?? '',
      name: item.longname ?? item.shortname ?? item.symbol ?? '',
      exchange: item.exchDisp ?? item.exchange ?? '',
      type: TYPE_MAP[item.quoteType] ?? item.quoteType ?? '',
    }))
    res.writeHead(200, CORS_HEADERS)
    res.end(JSON.stringify(results))
  } catch (err) {
    res.writeHead(500, CORS_HEADERS)
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handlePrices(searchParams, res) {
  const ticker = searchParams.get('ticker')
  const start = searchParams.get('start')
  const end = searchParams.get('end')
  if (!ticker || !start || !end) {
    res.writeHead(400, CORS_HEADERS)
    res.end(JSON.stringify({ error: 'ticker, start, and end are required' }))
    return
  }
  try {
    const period1 = Math.floor(new Date(start).getTime() / 1000)
    const period2 = Math.floor(new Date(`${end}T23:59:59`).getTime() / 1000)
    const params = new URLSearchParams({
      interval: '1d',
      period1: String(period1),
      period2: String(period2),
      events: 'div,splits',
      includeAdjustedClose: 'true',
    })
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${params}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      },
    )
    if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`)

    const data = await response.json()
    const result = data?.chart?.result?.[0]
    if (!result) {
      res.writeHead(200, CORS_HEADERS)
      res.end(JSON.stringify([]))
      return
    }

    const timestamps = result.timestamp ?? []
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose ?? []
    const prices = []
    for (let i = 0; i < timestamps.length; i++) {
      const price = adjClose[i]
      if (price == null || isNaN(price)) continue
      prices.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        adjustedClose: Math.round(price * 1_000_000) / 1_000_000,
      })
    }
    res.writeHead(200, CORS_HEADERS)
    res.end(JSON.stringify(prices))
  } catch (err) {
    res.writeHead(500, CORS_HEADERS)
    res.end(JSON.stringify({ error: err.message }))
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'GET') {
    res.writeHead(405, CORS_HEADERS)
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  if (url.pathname === '/api/search') {
    await handleSearch(url.searchParams, res)
  } else if (url.pathname === '/api/prices') {
    await handlePrices(url.searchParams, res)
  } else {
    res.writeHead(404, CORS_HEADERS)
    res.end(JSON.stringify({ error: 'Not found' }))
  }
})

server.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`)
})
