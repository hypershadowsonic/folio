/**
 * Vercel Serverless Function: GET /api/prices
 *
 * Query params:
 *   ticker  - e.g. VOO, 0050.TW, USDTWD=X
 *   start   - YYYY-MM-DD
 *   end     - YYYY-MM-DD
 *
 * Returns JSON array of { date: "YYYY-MM-DD", adjustedClose: number }
 *
 * Uses Yahoo Finance v8 chart API with Unix timestamps.
 * No external npm dependencies — requires Node 18+ (native fetch).
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(204).end()

  const { ticker, start, end } = req.query
  if (!ticker || !start || !end)
    return res.status(400).json({ error: 'ticker, start, and end are required' })

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
    if (!result) return res.status(200).json([])

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

    return res.status(200).json(prices)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
