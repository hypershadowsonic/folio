/**
 * ibkrParser.ts — Pure parser for IBKR CSV exports.
 *
 * Supports two formats automatically detected from the header row:
 *
 * ① English Activity Statement ("Trades" section):
 *   Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,...
 *   Trades,Data,Order,Stocks,USD,VOO,"2026-01-15, 10:30:00",10,450.25,...
 *
 * ② Traditional Chinese Transaction History ("交易歷史" section):
 *   交易歷史,Header,日期,賬戶,說明,交易類型,代碼,交易量,價格,Price Currency,總額,佣金,淨額
 *   交易歷史,Data,2026-03-04,U***50011,VANGUARD S&P 500 ETF,買,VOO,0.2825,633.56,USD,-178.98,-0.35,-179.33
 *
 * No React or Dexie dependencies — this is a pure parsing utility.
 */

export interface IBKRTrade {
  dateTime: Date
  symbol: string
  /** Positive = buy, negative = sell */
  quantity: number
  tradePrice: number
  currency: string
  /** Always positive (absolute value of commission column) */
  commFee: number
  /** 'O' = open/buy, 'C' = close/sell. Empty string for Chinese format. */
  code: string
}

export interface IBKRParseResult {
  trades: IBKRTrade[]
  errors: string[]
  skippedRows: number
}

type IBKRFormat = 'english' | 'chinese-tw'

const TRADE_SECTIONS: Record<string, IBKRFormat> = {
  'Trades':   'english',
  '交易歷史': 'chinese-tw',  // IBKR Traditional Chinese — Activity Statement
  '轉賬歷史': 'chinese-tw',  // IBKR Traditional Chinese — Transaction History export
}

/**
 * Parse a raw IBKR CSV text (Activity Statement or Chinese Transaction History).
 * Returns all BUY/SELL stock trade rows sorted chronologically.
 */
export function parseIBKRActivityCSV(csvText: string): IBKRParseResult {
  const trades: IBKRTrade[] = []
  const errors: string[] = []
  let skippedRows = 0

  // Strip UTF-8 BOM if present (common in Chinese locale exports)
  const cleanText = csvText.replace(/^\uFEFF/, '')
  const lines = cleanText.split(/\r?\n/)

  let colIndex: Map<string, number> | null = null
  let format: IBKRFormat | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    const cols = parseCSVLine(line)
    if (cols.length < 3) continue

    const section = cols[0]?.trim() ?? ''
    const rowType = cols[1]?.trim()

    const sectionFormat = TRADE_SECTIONS[section]
    if (!sectionFormat) continue

    // Header row — build column index and detect format
    if (rowType === 'Header') {
      colIndex = new Map<string, number>()
      for (let j = 0; j < cols.length; j++) {
        colIndex.set(cols[j]!.trim(), j)
      }
      format = sectionFormat
      continue
    }

    // Data rows — only process after we've seen the header
    if (rowType !== 'Data' || !colIndex || !format) continue

    // ── English Activity Statement ──────────────────────────────────────────
    if (format === 'english') {
      const discriminator = cols[colIndex.get('DataDiscriminator') ?? 2]?.trim()
      if (discriminator !== 'Order') { skippedRows++; continue }

      const assetCategory = cols[colIndex.get('Asset Category') ?? 3]?.trim()
      if (assetCategory !== 'Stocks') { skippedRows++; continue }

      const currency  = cols[colIndex.get('Currency')   ?? 4]?.trim() ?? ''
      const symbol    = cols[colIndex.get('Symbol')     ?? 5]?.trim() ?? ''
      const rawDate   = cols[colIndex.get('Date/Time')  ?? 6]?.trim() ?? ''
      const rawQty    = cols[colIndex.get('Quantity')   ?? 7]?.trim() ?? ''
      const rawPrice  = cols[colIndex.get('T. Price')   ?? 8]?.trim() ?? ''
      const rawFee    = cols[colIndex.get('Comm/Fee')   ?? 11]?.trim() ?? ''
      const rawCode   = cols[colIndex.get('Code')       ?? 15]?.trim() ?? ''

      const parsed = parseTrade({ symbol, rawDate, rawQty, rawPrice, rawFee, currency, code: rawCode, rowNum: i + 1 })
      if ('error' in parsed) { errors.push(parsed.error); skippedRows++; continue }
      if ('skip' in parsed)  { skippedRows++; continue }
      trades.push(parsed)

    // ── Traditional Chinese Transaction History ─────────────────────────────
    } else {
      const txType = cols[colIndex.get('交易類型') ?? 5]?.trim()
      // Only process buy (買) and sell (賣) rows
      if (txType !== '買' && txType !== '賣') { skippedRows++; continue }

      const rawDate  = cols[colIndex.get('日期')           ?? 2]?.trim() ?? ''
      const symbol   = cols[colIndex.get('代碼')           ?? 6]?.trim() ?? ''
      const rawQty   = cols[colIndex.get('交易量')         ?? 7]?.trim() ?? ''
      const rawPrice = cols[colIndex.get('價格')           ?? 8]?.trim() ?? ''
      const currency = cols[colIndex.get('Price Currency') ?? 9]?.trim() ?? ''
      const rawFee   = cols[colIndex.get('佣金')           ?? 11]?.trim() ?? ''

      // Skip rows where symbol is '-' (e.g. deposit rows that slip through)
      if (!symbol || symbol === '-') { skippedRows++; continue }

      const parsed = parseTrade({ symbol, rawDate, rawQty, rawPrice, rawFee, currency, code: '', rowNum: i + 1 })
      if ('error' in parsed) { errors.push(parsed.error); skippedRows++; continue }
      if ('skip' in parsed)  { skippedRows++; continue }
      trades.push(parsed)
    }
  }

  if (!colIndex) {
    errors.push(
      'No recognised trade section found. ' +
      'For English exports: Activity Statement CSV with a "Trades" section. ' +
      'For Chinese exports: Transaction History CSV with a "交易歷史" section.',
    )
  }

  // Sort chronologically so operations are created in order
  trades.sort((a, b) => a.dateTime.getTime() - b.dateTime.getTime())

  return { trades, errors, skippedRows }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

interface ParseTradeInput {
  symbol: string
  rawDate: string
  rawQty: string
  rawPrice: string
  rawFee: string
  currency: string
  code: string
  rowNum: number
}

type ParseTradeResult = IBKRTrade | { error: string } | { skip: true }

function parseTrade(p: ParseTradeInput): ParseTradeResult {
  if (!p.symbol) {
    return { error: `Row ${p.rowNum}: missing symbol — skipped` }
  }

  const dateTime = parseIBKRDate(p.rawDate)
  if (!dateTime) {
    return { error: `Row ${p.rowNum} (${p.symbol}): unrecognised date format "${p.rawDate}" — skipped` }
  }

  const quantity   = parseFloat(p.rawQty.replace(/,/g, ''))
  const tradePrice = parseFloat(p.rawPrice.replace(/,/g, ''))
  const commFee    = Math.abs(parseFloat(p.rawFee.replace(/,/g, '')) || 0)

  if (isNaN(quantity) || quantity === 0) {
    return { error: `Row ${p.rowNum} (${p.symbol}): invalid quantity "${p.rawQty}" — skipped` }
  }
  if (isNaN(tradePrice) || tradePrice <= 0) {
    return { error: `Row ${p.rowNum} (${p.symbol}): invalid price "${p.rawPrice}" — skipped` }
  }

  return {
    dateTime,
    symbol: p.symbol,
    quantity,
    tradePrice,
    currency: p.currency,
    commFee,
    code: p.code,
  }
}

/**
 * Parse IBKR date/time string.
 * Accepted formats:
 *   "2026-01-15, 10:30:00"   (English Activity Statement — quoted, comma-separated)
 *   "2026-01-15"             (Chinese Transaction History — date only)
 *   "20260115"               (compact)
 */
function parseIBKRDate(raw: string): Date | null {
  if (!raw) return null

  // "2026-01-15, 10:30:00" or "2026-01-15,10:30:00"
  const withTime = raw.match(/^(\d{4}-\d{2}-\d{2}),?\s*(\d{2}:\d{2}:\d{2})$/)
  if (withTime) {
    const d = new Date(`${withTime[1]}T${withTime[2]}`)
    return isNaN(d.getTime()) ? null : d
  }

  // "2026-01-15" (date only)
  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateOnly) {
    const d = new Date(`${dateOnly[1]}T00:00:00`)
    return isNaN(d.getTime()) ? null : d
  }

  // "20260115" compact
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) {
    const d = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00`)
    return isNaN(d.getTime()) ? null : d
  }

  return null
}

/**
 * Parse a single CSV line respecting quoted fields (RFC 4180).
 * IBKR uses quoted fields for values with commas (e.g. date/time, large numbers).
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote inside quoted field
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}
