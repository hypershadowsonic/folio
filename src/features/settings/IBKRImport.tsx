/**
 * IBKRImport — Import trades from an IBKR Activity Statement CSV file.
 *
 * Flow:
 *   1. User picks a .csv file
 *   2. CSV is parsed (pure parser, no network)
 *   3. Preview table shown: Date, Symbol, Side, Qty, Price, Fee, Currency, Match
 *   4. Auto-matched symbols link to existing Holdings by ticker (case-insensitive)
 *   5. Unmatched symbols get a dropdown to select a holding or mark as "Skip"
 *   6. Confirm → create one Operation per row, in chronological order
 *   7. Result summary shown
 *
 * Constraint: FX lot consumption uses current available lots (FIFO order at time
 * of import), not historical lots. A disclaimer is shown to the user.
 */

import { useState, useRef, useMemo, useCallback } from 'react'
import { Upload, AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import { useHoldings } from '@/db/hooks'
import { importIBKRTradesAtomically, type IBKRImportRow } from '@/services/ibkrImportService'
import { parseIBKRActivityCSV } from '@/lib/ibkrParser'
import type { IBKRTrade } from '@/lib/ibkrParser'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TradeRow extends IBKRImportRow {
  trade: IBKRTrade
  /** holdingId assigned by auto-match or user selection. null = skip. undefined = unresolved. */
  holdingId: string | null | undefined
  autoMatched: boolean
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtNumber(n: number, decimals = 2): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)
}

// ─── Encoding detection ───────────────────────────────────────────────────────

/**
 * Decode a CSV file buffer with automatic encoding detection.
 *
 * IBKR exports vary by portal language:
 *   - English portal  → UTF-8 (with or without BOM)
 *   - Chinese portal  → UTF-16 LE (FF FE BOM) or Big5
 *
 * Strategy:
 *   1. FF FE BOM → UTF-16 LE
 *   2. FE FF BOM → UTF-16 BE
 *   3. Many null bytes (no BOM) → UTF-16 LE heuristic
 *   4. EF BB BF  → UTF-8 BOM (TextDecoder handles it, parser strips \uFEFF)
 *   5. Default   → UTF-8
 */
function decodeCSVBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  // UTF-16 LE BOM: FF FE
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(buffer)
  }
  // UTF-16 BE BOM: FE FF
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(buffer)
  }
  // UTF-16 LE without BOM: ASCII chars produce 0x00 high bytes, giving ~50% nulls
  const sample = bytes.slice(0, Math.min(200, bytes.length))
  const nullCount = sample.reduce((n, b) => n + (b === 0 ? 1 : 0), 0)
  if (nullCount > sample.length * 0.25) {
    return new TextDecoder('utf-16le').decode(buffer)
  }
  // UTF-8 (handles BOM — parser strips \uFEFF)
  return new TextDecoder('utf-8').decode(buffer)
}

// ─── IBKRImport ───────────────────────────────────────────────────────────────

interface IBKRImportProps {
  portfolioId: string
}

export function IBKRImport({ portfolioId }: IBKRImportProps) {
  const holdings = useHoldings(portfolioId)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [filename, setFilename] = useState<string | null>(null)
  const [rows, setRows] = useState<TradeRow[]>([])
  const [parseErrors, setParseErrors] = useState<string[]>([])
  const [skippedRows, setSkippedRows] = useState(0)

  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    created: number; skipped: number; newLegacyTickers: string[]
  } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // holdingId → ticker for quick lookup
  const holdingMap = useMemo(
    () => new Map(holdings.map(h => [h.id, h])),
    [holdings],
  )
  // ticker (lowercase) → holdingId for auto-match
  const tickerToHoldingId = useMemo(
    () => new Map(holdings.map(h => [h.ticker.toLowerCase(), h.id])),
    [holdings],
  )

  // ── File handling ──────────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    setImportResult(null)
    setImportError(null)

    const reader = new FileReader()
    reader.onload = (event) => {
      const buffer = event.target?.result as ArrayBuffer
      const text = decodeCSVBuffer(buffer)
      const result = parseIBKRActivityCSV(text)

      setParseErrors(result.errors)
      setSkippedRows(result.skippedRows)

      const parsed: TradeRow[] = result.trades.map(trade => {
        const matchedId = tickerToHoldingId.get(trade.symbol.toLowerCase())
        return {
          trade,
          holdingId: matchedId ?? undefined,  // undefined = user must resolve
          autoMatched: !!matchedId,
        }
      })
      setRows(parsed)
    }
    reader.readAsArrayBuffer(file)

    // Reset file input so re-uploading same file triggers onChange
    e.target.value = ''
  }

  const updateRowHolding = useCallback((index: number, value: string) => {
    setRows(prev => prev.map((r, i) =>
      i === index ? {
        ...r,
        holdingId: value === '__skip__'  ? null
                 : value === '__auto__'  ? undefined
                 : value,
      } : r,
    ))
  }, [])

  // ── Validation ─────────────────────────────────────────────────────────────

  /** undefined = auto-create legacy on import (not a blocker) */
  const autoCreateRows  = rows.filter(r => r.holdingId === undefined)
  const activeRows      = rows.filter(r => r.holdingId !== null && r.holdingId !== undefined)
  const canImport       = (activeRows.length > 0 || autoCreateRows.length > 0) && !importing

  // ── Import ─────────────────────────────────────────────────────────────────

  async function handleImport() {
    if (!canImport) return
    setImporting(true)
    setImportError(null)

    try {
      const result = await importIBKRTradesAtomically(portfolioId, rows, filename ?? undefined)
      setImporting(false)
      setImportResult(result)
      setRows([])
      setFilename(null)
      setParseErrors([])
      setSkippedRows(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setImportError(msg)
      setImporting(false)
    }
  }

  function handleReset() {
    setRows([])
    setFilename(null)
    setParseErrors([])
    setSkippedRows(0)
    setImportResult(null)
    setImportError(null)
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  // Success state
  if (importResult) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Import complete — {importResult.created} operation{importResult.created !== 1 ? 's' : ''} created
              {importResult.skipped > 0 && `, ${importResult.skipped} row${importResult.skipped !== 1 ? 's' : ''} skipped`}
            </p>
            {importResult.newLegacyTickers.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Created {importResult.newLegacyTickers.length} new legacy holding{importResult.newLegacyTickers.length !== 1 ? 's' : ''}: {importResult.newLegacyTickers.join(', ')}.
                Review in Settings → Holdings → Legacy.
              </p>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleReset} className="text-xs">
          Import another file
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">

      {/* File picker */}
      {!filename && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleFileChange}
            aria-label="Select IBKR Activity Statement CSV"
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
            Select Activity Statement CSV
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            English: Activity → Statements → Activity → Download as CSV.<br />
            繁中: 交易 → 交易歷史 → 下載 CSV。
          </p>
        </div>
      )}

      {/* FX lot disclaimer */}
      {rows.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
          <Info className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
            FX lots are consumed in FIFO order at import time, not at the original trade date.
            TWD cost basis for historical USD trades may differ from actual historical rates.
          </p>
        </div>
      )}

      {/* Parse errors */}
      {parseErrors.length > 0 && (
        <div className="space-y-1">
          {parseErrors.map((e, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive leading-relaxed">{e}</p>
            </div>
          ))}
        </div>
      )}

      {/* Preview table */}
      {rows.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {rows.length} trade{rows.length !== 1 ? 's' : ''} found
              {skippedRows > 0 && <span className="text-muted-foreground/60 font-normal normal-case tracking-normal ml-1">({skippedRows} non-stock rows skipped)</span>}
            </p>
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          </div>

          {autoCreateRows.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
              <Info className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                {autoCreateRows.length} symbol{autoCreateRows.length !== 1 ? 's' : ''} not matched.
                They will be auto-created as Legacy holdings in the "Unassigned" sleeve.
                Override or skip using the dropdown.
              </p>
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-xs min-w-[620px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="py-2 pl-3 pr-2 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Date</th>
                  <th className="py-2 px-2 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Symbol</th>
                  <th className="py-2 px-2 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Side</th>
                  <th className="py-2 px-2 text-right font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Qty</th>
                  <th className="py-2 px-2 text-right font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Price</th>
                  <th className="py-2 px-2 text-right font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Fee</th>
                  <th className="py-2 px-2 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">CCY</th>
                  <th className="py-2 px-2 pr-3 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Holding</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const { trade } = row
                  const side = trade.quantity > 0 ? 'BUY' : 'SELL'
                  const isSkipped    = row.holdingId === null
                  const isAutoCreate = row.holdingId === undefined

                  return (
                    <tr
                      key={i}
                      className={cn(
                        'border-b border-border/60 last:border-b-0',
                        isSkipped && 'opacity-40',
                      )}
                    >
                      <td className="py-2 pl-3 pr-2 align-middle text-muted-foreground tabular-nums whitespace-nowrap">
                        {fmtDate(trade.dateTime)}
                      </td>
                      <td className="py-2 px-2 align-middle font-mono font-semibold">
                        {trade.symbol}
                      </td>
                      <td className="py-2 px-2 align-middle">
                        {side === 'BUY'
                          ? <Badge variant="success"     className="text-[10px] py-0">BUY</Badge>
                          : <Badge variant="destructive" className="text-[10px] py-0">SELL</Badge>
                        }
                      </td>
                      <td className="py-2 px-2 align-middle text-right tabular-nums">
                        {fmtNumber(Math.abs(trade.quantity), 4).replace(/\.?0+$/, '')}
                      </td>
                      <td className="py-2 px-2 align-middle text-right tabular-nums">
                        {fmtNumber(trade.tradePrice)}
                      </td>
                      <td className="py-2 px-2 align-middle text-right tabular-nums text-muted-foreground">
                        {trade.commFee > 0 ? fmtNumber(trade.commFee) : '—'}
                      </td>
                      <td className="py-2 px-2 align-middle text-muted-foreground uppercase">
                        {trade.currency}
                      </td>
                      <td className="py-2 px-2 pr-3 align-middle">
                        {row.autoMatched && row.holdingId ? (
                          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                            <span className="truncate max-w-[100px]">
                              {holdingMap.get(row.holdingId)?.ticker ?? row.holdingId}
                            </span>
                          </span>
                        ) : (
                          <Select
                            value={
                              row.holdingId === null      ? '__skip__'
                              : row.holdingId === undefined ? '__auto__'
                              : row.holdingId
                            }
                            onValueChange={v => updateRowHolding(i, v)}
                          >
                            <SelectTrigger
                              className={cn(
                                'h-7 w-40 text-xs',
                                isAutoCreate && 'border-amber-400 dark:border-amber-600',
                              )}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__auto__" className="text-xs text-amber-700 dark:text-amber-400">
                                Auto-create "{trade.symbol}" as Legacy
                              </SelectItem>
                              {holdings.map(h => (
                                <SelectItem key={h.id} value={h.id} className="text-xs">
                                  {h.ticker} — {h.name}
                                </SelectItem>
                              ))}
                              <SelectItem value="__skip__" className="text-xs text-muted-foreground">
                                Skip this trade
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {importError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive leading-relaxed">{importError}</p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              className="gap-2 text-xs"
              disabled={!canImport}
              onClick={handleImport}
            >
              {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {importing
                ? 'Importing…'
                : `Import ${activeRows.length + autoCreateRows.length} trade${activeRows.length + autoCreateRows.length !== 1 ? 's' : ''}`
              }
            </Button>
            <p className="text-xs text-muted-foreground">
              {activeRows.length} to import{rows.filter(r => r.holdingId === null).length > 0 && `, ${rows.filter(r => r.holdingId === null).length} skipped`}
            </p>
          </div>
        </div>
      )}

      {rows.length === 0 && filename && parseErrors.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No trade rows found in "{filename}". Make sure this is an IBKR Activity Statement (Trades section) or Transaction History CSV (交易歷史 section).
        </p>
      )}

    </div>
  )
}
