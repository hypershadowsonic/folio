/**
 * OperationHistory — searchable, filterable, paginated operation log.
 *
 * Architecture:
 *   - DB query: fetch all ops for portfolio (date range applied at index level)
 *   - In-memory: type multi-select, tag, sleeve, and text-search filters
 *   - Pagination: 20 rows at a time with "Load more"
 *   - CSV export: downloads the currently filtered set
 */

import { useState, useMemo, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import Dexie from 'dexie'
import {
  Search, SlidersHorizontal, X, Download, ChevronDown, ChevronUp,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { db } from '@/db'
import { useHoldings, useSleeves } from '@/db/hooks'
import type { Holding, Operation, OperationType, Sleeve, HoldingSnapshot } from '@/types'

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<OperationType, string> = {
  BUY:                'Buy',
  SELL:               'Sell',
  REBALANCE:          'Rebalance',
  DCA:                'DCA',
  TACTICAL_ROTATION:  'Rotation',
  DRAWDOWN_DEPLOY:    'Deploy',
  DIVIDEND_REINVEST:  'Dividend',
  FX_EXCHANGE:        'FX',
  CASH_DEPOSIT:       'Deposit',
  CASH_WITHDRAWAL:    'Withdrawal',
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'

const TYPE_BADGE: Record<OperationType, BadgeVariant> = {
  BUY:                'success',
  SELL:               'destructive',
  REBALANCE:          'default',
  DCA:                'default',
  TACTICAL_ROTATION:  'warning',
  DRAWDOWN_DEPLOY:    'warning',
  DIVIDEND_REINVEST:  'success',
  FX_EXCHANGE:        'secondary',
  CASH_DEPOSIT:       'secondary',
  CASH_WITHDRAWAL:    'secondary',
}

// Left border color by type (Tailwind border-l-* classes — must be complete strings for purge)
const TYPE_ACCENT: Record<OperationType, string> = {
  BUY:                'border-l-emerald-500',
  SELL:               'border-l-red-500',
  REBALANCE:          'border-l-blue-500',
  DCA:                'border-l-blue-500',
  TACTICAL_ROTATION:  'border-l-orange-500',
  DRAWDOWN_DEPLOY:    'border-l-amber-500',
  DIVIDEND_REINVEST:  'border-l-emerald-400',
  FX_EXCHANGE:        'border-l-purple-500',
  CASH_DEPOSIT:       'border-l-slate-400',
  CASH_WITHDRAWAL:    'border-l-slate-400',
}

const ALL_TYPES = Object.keys(TYPE_LABELS) as OperationType[]
const PAGE_SIZE = 20

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeDate(d: Date | string): string {
  const now = Date.now()
  const ts  = new Date(d).getTime()
  const diff = now - ts
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)

  if (mins  <  1)  return 'just now'
  if (mins  < 60)  return `${mins}m ago`
  if (hours < 24)  return `${hours}h ago`
  if (days  <  7)  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function exactDate(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtNum(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtCur(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    maximumFractionDigits: currency === 'TWD' ? 0 : 2,
  }).format(amount)
}

/** One-line summary of an operation for the collapsed row. */
function buildSummary(op: Operation, holdingMap: Map<string, Holding>): string {
  const { type, entries, cashFlow, snapshotBefore, snapshotAfter } = op

  if (cashFlow) {
    const sign = cashFlow.amount >= 0 ? '+' : ''
    return `${sign}${fmtCur(Math.abs(cashFlow.amount), cashFlow.currency)}`
  }

  if (type === 'FX_EXCHANGE') {
    const twdBefore = snapshotBefore.cashBalances.find(b => b.currency === 'TWD')?.balance ?? 0
    const twdAfter  = snapshotAfter.cashBalances.find(b => b.currency === 'TWD')?.balance ?? 0
    const usdAfter  = snapshotAfter.cashBalances.find(b => b.currency === 'USD')?.balance ?? 0
    const usdBefore = snapshotBefore.cashBalances.find(b => b.currency === 'USD')?.balance ?? 0
    const twdSpent  = twdBefore - twdAfter
    const usdGained = usdAfter - usdBefore
    if (twdSpent > 0 && usdGained > 0) {
      const rate = twdSpent / usdGained
      return `TWD ${fmtNum(twdSpent, 0)} → USD ${fmtNum(usdGained, 2)} @ ${fmtNum(rate, 4)}`
    }
    return 'FX Exchange'
  }

  if (entries.length === 0) return '—'

  if (type === 'TACTICAL_ROTATION' && entries.length === 2) {
    const sell = entries.find(e => e.side === 'SELL')
    const buy  = entries.find(e => e.side === 'BUY')
    const sellTicker = holdingMap.get(sell?.holdingId ?? '')?.ticker ?? '?'
    const buyTicker  = holdingMap.get(buy?.holdingId  ?? '')?.ticker ?? '?'
    return `${sellTicker} → ${buyTicker}`
  }

  // Standard: list up to 2 entries
  return entries.slice(0, 2).map(e => {
    const ticker = holdingMap.get(e.holdingId)?.ticker ?? '?'
    const sign   = e.side === 'BUY' ? '+' : '−'
    return `${ticker} ${sign}${fmtNum(e.shares, e.shares % 1 === 0 ? 0 : 3)} @ ${fmtCur(e.pricePerShare, e.currency)}`
  }).join(', ') + (entries.length > 2 ? ` +${entries.length - 2} more` : '')
}

/** Total operation value (gross proceeds or cost) for the collapsed row. */
function buildTotalValue(op: Operation): string | null {
  if (op.cashFlow) return fmtCur(Math.abs(op.cashFlow.amount), op.cashFlow.currency)

  if (op.entries.length === 0) return null

  // If entries span multiple currencies, skip the total
  const currencies = [...new Set(op.entries.map(e => e.currency))]
  if (currencies.length > 1) return null

  const total = op.entries.reduce((sum, e) => sum + e.shares * e.pricePerShare + e.fees, 0)
  return fmtCur(total, currencies[0])
}

/** Realized P&L for a SELL, derived from snapshotBefore cost basis. */
function buildRealizedPnl(op: Operation, holdingMap: Map<string, Holding>): string | null {
  if (op.type !== 'SELL' || op.entries.length !== 1) return null
  const e = op.entries[0]
  const snap = op.snapshotBefore.holdings.find(h => h.holdingId === e.holdingId)
  if (!snap || snap.shares <= 0) return null

  const costPerShare = snap.costBasis / snap.shares
  const proceeds     = e.shares * e.pricePerShare - e.fees
  const cost         = costPerShare * e.shares
  const pnl          = proceeds - cost

  const currency = holdingMap.get(e.holdingId)?.currency ?? e.currency
  const sign = pnl >= 0 ? '+' : ''
  return `${sign}${fmtCur(pnl, currency)} P&L`
}

// ─── CSV builder ──────────────────────────────────────────────────────────────

function buildCsvRow(values: (string | number | undefined)[]): string {
  return values.map(v => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }).join(',')
}

function downloadCsv(ops: Operation[], holdingMap: Map<string, Holding>) {
  const header = buildCsvRow([
    'date', 'type', 'ticker', 'side', 'shares', 'pricePerShare', 'fees',
    'currency', 'rationale', 'tag', 'fxBlendedRate', 'twdCost',
  ])

  const rows: string[] = []

  for (const op of ops) {
    const base = [
      new Date(op.timestamp).toISOString(),
      op.type,
    ]
    if (op.entries.length > 0) {
      for (const e of op.entries) {
        const ticker = holdingMap.get(e.holdingId)?.ticker ?? e.holdingId
        rows.push(buildCsvRow([
          ...base, ticker, e.side, e.shares, e.pricePerShare, e.fees,
          e.currency, op.rationale, op.tag ?? '',
          e.fxCostBasis?.blendedRate ?? '',
          e.fxCostBasis?.baseCurrencyCost ?? '',
        ]))
      }
    } else if (op.cashFlow) {
      rows.push(buildCsvRow([
        ...base, '', op.cashFlow.amount >= 0 ? 'IN' : 'OUT',
        '', '', Math.abs(op.cashFlow.amount), op.cashFlow.currency,
        op.rationale, op.tag ?? '', '', '',
      ]))
    } else {
      rows.push(buildCsvRow([
        ...base, 'FX', 'EXCHANGE', '', '', '', 'TWD/USD',
        op.rationale, op.tag ?? '', '', '',
      ]))
    }
  }

  const csv  = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `operations-${new Date().toISOString().slice(0, 10)}.csv`,
  })
  a.click()
  URL.revokeObjectURL(url)
}

// ─── HistoryRow ───────────────────────────────────────────────────────────────

interface HistoryRowProps {
  op: Operation
  holdingMap: Map<string, Holding>
}

function HistoryRow({ op, holdingMap }: HistoryRowProps) {
  const [expanded, setExpanded] = useState(false)

  const summary    = buildSummary(op, holdingMap)
  const totalValue = buildTotalValue(op)
  const realizedPnl = buildRealizedPnl(op, holdingMap)

  // Affected holding IDs (for snapshot diff)
  const affectedIds = useMemo(
    () => new Set(op.entries.map(e => e.holdingId)),
    [op.entries],
  )

  // Snapshot diff: before vs after for each affected holding
  const snapDiff = useMemo(() => {
    if (affectedIds.size === 0) return []
    return [...affectedIds].map(id => {
      const before = op.snapshotBefore.holdings.find(h => h.holdingId === id)
      const after  = op.snapshotAfter.holdings.find(h => h.holdingId === id)
      if (!before && !after) return null
      return { id, before: before ?? null, after: after ?? null }
    }).filter(Boolean) as { id: string; before: HoldingSnapshot | null; after: HoldingSnapshot | null }[]
  }, [op, affectedIds])

  // Cash balance diff for all operation types
  const cashDiff = useMemo(() => {
    const currencies = ['TWD', 'USD'] as const
    return currencies.map(cur => {
      const before = op.snapshotBefore.cashBalances.find(b => b.currency === cur)?.balance ?? 0
      const after  = op.snapshotAfter.cashBalances.find(b => b.currency === cur)?.balance ?? 0
      const delta  = after - before
      if (delta === 0) return null
      return { currency: cur, before, after, delta }
    }).filter(Boolean) as { currency: string; before: number; after: number; delta: number }[]
  }, [op])

  return (
    <div
      className={cn(
        'rounded-lg border-l-4 border border-border bg-card text-card-foreground overflow-hidden',
        TYPE_ACCENT[op.type],
      )}
    >
      {/* ── Collapsed header (always visible) ──────────────────────────── */}
      <button
        className="w-full text-left px-3 py-3"
        onClick={() => setExpanded(v => !v)}
      >
        {/* Row 1: type badge + date + value */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant={TYPE_BADGE[op.type]} className="shrink-0 text-xs">
              {TYPE_LABELS[op.type]}
            </Badge>
            {op.tag && (
              <span className="text-xs text-muted-foreground truncate max-w-[80px]">
                #{op.tag}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">{relativeDate(op.timestamp)}</span>
            {expanded
              ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
              : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            }
          </div>
        </div>

        {/* Row 2: summary + total value */}
        <div className="flex items-baseline justify-between gap-2 mt-1.5">
          <p className="text-sm font-medium font-mono truncate">{summary}</p>
          {totalValue && (
            <span className="text-sm font-medium tabular-nums shrink-0">{totalValue}</span>
          )}
        </div>

        {/* Row 3: rationale (truncated) + P&L */}
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-xs text-muted-foreground truncate">{op.rationale}</p>
          {realizedPnl && (
            <span className={cn(
              'text-xs font-medium tabular-nums shrink-0',
              realizedPnl.startsWith('+') ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
            )}>
              {realizedPnl}
            </span>
          )}
        </div>
      </button>

      {/* ── Expanded detail ─────────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-3 space-y-4 text-sm">

          {/* Rationale */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Rationale</p>
            <p className="text-sm">{op.rationale}</p>
            {op.tag && (
              <p className="text-xs text-muted-foreground mt-1">Tag: <span className="font-medium">#{op.tag}</span></p>
            )}
          </div>

          {/* Trade entries */}
          {op.entries.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Entries</p>
              <div className="space-y-2">
                {op.entries.map((e, i) => {
                  const h = holdingMap.get(e.holdingId)
                  return (
                    <div key={i} className="rounded-md bg-muted/50 p-2.5 space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={e.side === 'BUY' ? 'success' : 'destructive'}
                            className="text-xs py-0"
                          >
                            {e.side}
                          </Badge>
                          <span className="font-medium">{h?.ticker ?? e.holdingId}</span>
                          {h && <span className="text-xs text-muted-foreground">{h.name}</span>}
                        </div>
                        <span className="font-mono text-xs tabular-nums">
                          {fmtNum(e.shares, 6).replace(/\.?0+$/, '')} shares
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>@ {fmtCur(e.pricePerShare, e.currency)}</span>
                        <span>fees {fmtCur(e.fees, e.currency)}</span>
                        <span className="font-medium text-foreground">
                          = {fmtCur(e.shares * e.pricePerShare + e.fees, e.currency)}
                        </span>
                      </div>
                      {e.fxCostBasis && (
                        <div className="pt-1 border-t border-border/50 text-xs text-muted-foreground">
                          <span>FX blended rate: </span>
                          <span className="font-medium text-foreground tabular-nums">
                            {fmtNum(e.fxCostBasis.blendedRate, 4)}
                          </span>
                          <span className="mx-1">·</span>
                          <span>TWD cost: </span>
                          <span className="font-medium text-foreground tabular-nums">
                            {fmtCur(e.fxCostBasis.baseCurrencyCost, 'TWD')}
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Cash balance diff */}
          {cashDiff && cashDiff.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Cash Changes</p>
              <div className="space-y-1">
                {cashDiff.map(({ currency, before, after, delta }) => (
                  <div key={currency} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{currency}</span>
                    <div className="flex items-center gap-2 tabular-nums">
                      <span className="text-muted-foreground">{fmtCur(before, currency)}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-medium">{fmtCur(after, currency)}</span>
                      <span className={cn(
                        'font-medium',
                        delta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
                      )}>
                        ({delta >= 0 ? '+' : ''}{fmtCur(delta, currency)})
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Snapshot: allocation before/after for affected holdings */}
          {snapDiff.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Portfolio Impact</p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Holding</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Before</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">After</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Drift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapDiff.map(({ id, before, after }) => {
                      const h = holdingMap.get(id)
                      const afterDrift = after?.driftFromTarget ?? 0
                      return (
                        <tr key={id} className="border-t border-border">
                          <td className="px-2 py-1.5 font-medium">{h?.ticker ?? id}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                            {before ? `${fmtNum(before.allocationPct, 1)}%` : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                            {after ? `${fmtNum(after.allocationPct, 1)}%` : '—'}
                          </td>
                          <td className={cn(
                            'px-2 py-1.5 text-right tabular-nums',
                            Math.abs(afterDrift) > (h?.driftThresholdPct ?? 2)
                              ? 'text-destructive font-medium'
                              : afterDrift > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                          )}>
                            {afterDrift >= 0 ? '+' : ''}{fmtNum(afterDrift, 1)}%
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Exact timestamp */}
          <p className="text-xs text-muted-foreground">
            Logged at {exactDate(op.timestamp)}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── OperationHistory ─────────────────────────────────────────────────────────

interface OperationHistoryProps {
  portfolioId: string
}

export function OperationHistory({ portfolioId }: OperationHistoryProps) {

  // ── Filter state ─────────────────────────────────────────────────────────────
  const [textSearch,     setTextSearch]     = useState('')
  const [selectedTypes,  setSelectedTypes]  = useState<OperationType[]>([])
  const [selectedTag,    setSelectedTag]    = useState<string>('')
  const [selectedSleeve, setSelectedSleeve] = useState<string>('')
  const [dateFrom,       setDateFrom]       = useState('')   // YYYY-MM-DD string
  const [dateTo,         setDateTo]         = useState('')
  const [showFilters,    setShowFilters]    = useState(false)
  const [visibleCount,   setVisibleCount]   = useState(PAGE_SIZE)

  // ── DB queries ────────────────────────────────────────────────────────────────
  const holdings = useHoldings(portfolioId)
  const sleeves  = useSleeves(portfolioId)

  const prevTags = useLiveQuery(async () => {
    const ops = await db.operations.where('portfolioId').equals(portfolioId).toArray()
    const tags = ops.map(o => o.tag).filter((t): t is string => Boolean(t))
    return [...new Set(tags)].sort()
  }, [portfolioId], []) as string[]

  // Main operation query — date range at DB level; everything else in-memory
  const allOps = useLiveQuery(
    async () => {
      const from = dateFrom ? new Date(dateFrom) : Dexie.minKey
      const to   = dateTo   ? new Date(dateTo + 'T23:59:59') : Dexie.maxKey

      return db.operations
        .where('[portfolioId+timestamp]')
        .between([portfolioId, from], [portfolioId, to], true, true)
        .reverse()
        .toArray()
    },
    [portfolioId, dateFrom, dateTo],
    [],
  ) as Operation[]

  // ── Derived ──────────────────────────────────────────────────────────────────
  const holdingMap = useMemo(
    () => new Map<string, Holding>(holdings.map(h => [h.id, h])),
    [holdings],
  )

  const sleeveHoldingIds = useMemo(() => {
    if (!selectedSleeve) return null
    return new Set(holdings.filter(h => h.sleeveId === selectedSleeve).map(h => h.id))
  }, [selectedSleeve, holdings])

  const filteredOps = useMemo(() => {
    let ops = allOps

    // Multi-type filter
    if (selectedTypes.length > 0) {
      ops = ops.filter(op => selectedTypes.includes(op.type))
    }

    // Tag filter
    if (selectedTag) {
      ops = ops.filter(op => op.tag === selectedTag)
    }

    // Sleeve filter (any entry touches a holding in this sleeve)
    if (sleeveHoldingIds) {
      ops = ops.filter(op =>
        op.entries.some(e => sleeveHoldingIds.has(e.holdingId))
      )
    }

    // Text search: rationale, tag, ticker, holding name
    const q = textSearch.trim().toLowerCase()
    if (q) {
      ops = ops.filter(op => {
        if (op.rationale.toLowerCase().includes(q))   return true
        if (op.tag?.toLowerCase().includes(q))         return true
        return op.entries.some(e => {
          const h = holdingMap.get(e.holdingId)
          return h?.ticker.toLowerCase().includes(q) || h?.name.toLowerCase().includes(q)
        })
      })
    }

    return ops
  }, [allOps, selectedTypes, selectedTag, sleeveHoldingIds, textSearch, holdingMap])

  const visibleOps = filteredOps.slice(0, visibleCount)

  // Reset pagination when filters change
  const resetPagination = useCallback(() => setVisibleCount(PAGE_SIZE), [])

  function toggleType(type: OperationType) {
    setSelectedTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    )
    resetPagination()
  }

  const activeFilterCount =
    selectedTypes.length +
    (selectedTag     ? 1 : 0) +
    (selectedSleeve  ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0)

  function clearAllFilters() {
    setSelectedTypes([])
    setSelectedTag('')
    setSelectedSleeve('')
    setDateFrom('')
    setDateTo('')
    setTextSearch('')
    resetPagination()
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* ── Sticky filter bar ─────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 pt-5 pb-3 space-y-3 border-b border-border">

        {/* Title row */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Operations</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {filteredOps.length === allOps.length
                ? `${allOps.length} total`
                : `${filteredOps.length} of ${allOps.length}`}
            </p>
          </div>
          <Button
            variant="ghost" size="sm"
            className="h-8 gap-1.5 text-muted-foreground"
            onClick={() => downloadCsv(filteredOps, holdingMap)}
            disabled={filteredOps.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </Button>
        </div>

        {/* Search + filter toggle */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-9 h-9"
              placeholder="Search rationale, ticker, tag…"
              value={textSearch}
              onChange={e => { setTextSearch(e.target.value); resetPagination() }}
            />
            {textSearch && (
              <button
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => { setTextSearch(''); resetPagination() }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            variant={showFilters ? 'default' : 'outline'}
            size="sm"
            className="h-9 gap-1.5 shrink-0"
            onClick={() => setShowFilters(v => !v)}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 rounded-full bg-primary-foreground text-primary w-4 h-4 flex items-center justify-center text-[10px] font-bold">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>

        {/* Expanded filter panel */}
        {showFilters && (
          <div className="space-y-3 pt-1">
            {/* Type toggle pills */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Operation type</Label>
              <div className="flex gap-1.5 flex-wrap">
                {ALL_TYPES.map(type => (
                  <button
                    key={type}
                    onClick={() => toggleType(type)}
                    className={cn(
                      'px-2.5 py-1 rounded-full text-xs border transition-colors',
                      selectedTypes.includes(type)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
                    )}
                  >
                    {TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>

            {/* Tag + Sleeve row */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Tag</Label>
                <Select value={selectedTag || '_all'} onValueChange={v => { setSelectedTag(v === '_all' ? '' : v); resetPagination() }}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="All tags" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all">All tags</SelectItem>
                    {prevTags.map(t => <SelectItem key={t} value={t}>#{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sleeve</Label>
                <Select value={selectedSleeve || '_all'} onValueChange={v => { setSelectedSleeve(v === '_all' ? '' : v); resetPagination() }}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="All sleeves" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all">All sleeves</SelectItem>
                    {sleeves.map((s: Sleeve) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Date range */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">From</Label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => { setDateFrom(e.target.value); resetPagination() }}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">To</Label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={e => { setDateTo(e.target.value); resetPagination() }}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </div>
          </div>
        )}

        {/* Active filter chips */}
        {activeFilterCount > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center">
            {selectedTypes.map(type => (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-primary/10 text-primary text-xs border border-primary/20 hover:bg-primary/20 transition-colors"
              >
                {TYPE_LABELS[type]}
                <X className="h-3 w-3" />
              </button>
            ))}
            {selectedTag && (
              <button
                onClick={() => { setSelectedTag(''); resetPagination() }}
                className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-primary/10 text-primary text-xs border border-primary/20 hover:bg-primary/20 transition-colors"
              >
                #{selectedTag}
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedSleeve && (
              <button
                onClick={() => { setSelectedSleeve(''); resetPagination() }}
                className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-primary/10 text-primary text-xs border border-primary/20 hover:bg-primary/20 transition-colors"
              >
                {sleeves.find((s: Sleeve) => s.id === selectedSleeve)?.name ?? 'Sleeve'}
                <X className="h-3 w-3" />
              </button>
            )}
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(''); setDateTo(''); resetPagination() }}
                className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-primary/10 text-primary text-xs border border-primary/20 hover:bg-primary/20 transition-colors"
              >
                {dateFrom || '…'} – {dateTo || '…'}
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearAllFilters}
              className="text-xs text-muted-foreground hover:text-foreground underline ml-1"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* ── Operation list ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 pb-24 space-y-2">
        {filteredOps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            {allOps.length === 0 ? (
              <>
                <p className="text-sm font-medium">No operations yet.</p>
                <p className="text-xs mt-1">Tap the + button to log your first operation.</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">No operations match your filters.</p>
                <button
                  className="text-xs text-primary mt-2 underline"
                  onClick={clearAllFilters}
                >
                  Clear filters
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            {visibleOps.map(op => (
              <HistoryRow key={op.id} op={op} holdingMap={holdingMap} />
            ))}

            {/* Load more */}
            {visibleCount < filteredOps.length && (
              <div className="pt-2 pb-4 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
                >
                  Load {Math.min(PAGE_SIZE, filteredOps.length - visibleCount)} more
                  <span className="ml-1 text-muted-foreground text-xs">
                    ({filteredOps.length - visibleCount} remaining)
                  </span>
                </Button>
              </div>
            )}

            {/* All shown indicator */}
            {visibleCount >= filteredOps.length && filteredOps.length > PAGE_SIZE && (
              <p className="text-center text-xs text-muted-foreground py-4">
                All {filteredOps.length} operations shown
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
