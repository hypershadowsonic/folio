/**
 * Vercel Serverless Function: GET /api/search
 *
 * Query params:
 *   q - search query (e.g. "voo", "0050", "apple")
 *
 * Returns JSON array of { ticker, name, exchange, type }
 */

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(204).end()

  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'q is required' })

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

    return res.status(200).json(results)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
