import { useState, useMemo, useEffect, useCallback } from 'react'
import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { TrendingUp, TrendingDown, ArrowRight, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore, type DisplayCurrency } from '@/stores/uiStore'
import { useCashAccounts, useHoldings, useSleeves } from '@/db/hooks'
import { db } from '@/db/database'
import { captureSnapshot } from '@/db/snapshotService'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { OperationCard } from '@/features/operations/OperationCard'
import type { Operation, HoldingSnapshot, Sleeve, Holding } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Range = '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL'

const RANGES: Range[] = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL']

interface SleeveAlloc {
  sleeve: Sleeve
  actualPct: number
  targetPct: number
  holdingRows: { snapshot: HoldingSnapshot; ticker: string; name: string }[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFromDate(range: Range): Date | null {
  if (range === 'ALL') return null
  const d = new Date()
  if (range === '1M') d.setMonth(d.getMonth() - 1)
  else if (range === '3M') d.setMonth(d.getMonth() - 3)
  else if (range === '6M') d.setMonth(d.getMonth() - 6)
  else if (range === 'YTD') { d.setMonth(0); d.setDate(1); d.setHours(0, 0, 0, 0) }
  else if (range === '1Y') d.setFullYear(d.getFullYear() - 1)
  return d
}

function toDisplay(valueBase: number, fxRate: number, currency: DisplayCurrency): number {
  if (currency === 'TWD') return valueBase
  return fxRate > 0 ? valueBase / fxRate : 0
}

function fmtFull(v: number, currency: DisplayCurrency): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'TWD' ? 0 : 2,
  }).format(v)
}

function fmtCompact(v: number, currency: DisplayCurrency): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(v)
}

function fmtDate(ts: Date | string): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ─── CurrencyToggle ───────────────────────────────────────────────────────────

function CurrencyToggle({
  value,
  onChange,
}: {
  value: DisplayCurrency
  onChange: (c: DisplayCurrency) => void
}) {
  return (
    <div className="flex items-center rounded-full border border-border bg-muted p-0.5 text-xs font-medium">
      {(['TWD', 'USD'] as const).map(c => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={cn(
            'rounded-full px-3 py-1 transition-colors',
            value === c
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {c}
        </button>
      ))}
    </div>
  )
}

// ─── ChartTooltip ─────────────────────────────────────────────────────────────

interface TooltipProps {
  active?: boolean
  payload?: { value: number }[]
  label?: string
  currency: DisplayCurrency
}

function ChartTooltip({ active, payload, label, currency }: TooltipProps) {
  if (!active || !payload?.[0]) return null
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-1.5 text-xs shadow-md">
      {label && <p className="text-muted-foreground mb-0.5">{label}</p>}
      <p className="font-semibold">{fmtFull(payload[0].value, currency)}</p>
    </div>
  )
}

// ─── AllocationSection ────────────────────────────────────────────────────────

function AllocationSection({
  allocs,
  currency,
  fxRate,
}: {
  allocs: SleeveAlloc[]
  currency: DisplayCurrency
  fxRate: number
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      {/* Stacked bars */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Actual
        </p>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {allocs.map(({ sleeve, actualPct }) => (
            <div
              key={sleeve.id}
              style={{ width: `${Math.max(actualPct, 0)}%`, backgroundColor: sleeve.color }}
              className="h-full"
            />
          ))}
        </div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Target
        </p>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {allocs.map(({ sleeve, targetPct }) => (
            <div
              key={sleeve.id}
              style={{ width: `${Math.max(targetPct, 0)}%`, backgroundColor: sleeve.color }}
              className="h-full opacity-50"
            />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {allocs.map(({ sleeve }) => (
          <span key={sleeve.id} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-2 w-2 rounded-sm shrink-0" style={{ backgroundColor: sleeve.color }} />
            {sleeve.name}
          </span>
        ))}
      </div>

      {/* Per-sleeve rows */}
      <div className="space-y-1.5">
        {allocs.map(({ sleeve, actualPct, targetPct, holdingRows }) => {
          const drift = actualPct - targetPct
          const driftAbs = Math.abs(drift)
          const driftVariant: 'secondary' | 'success' | 'warning' | 'destructive' =
            driftAbs <= 0.1 ? 'secondary'
            : driftAbs <= 2  ? 'success'
            : driftAbs <= 5  ? 'warning'
            : 'destructive'
          const isExpanded = expandedId === sleeve.id

          return (
            <div key={sleeve.id} className="rounded-lg border border-border bg-card overflow-hidden">
              <button
                className="flex w-full items-center justify-between px-3 py-2.5 text-left"
                onClick={() => setExpandedId(isExpanded ? null : sleeve.id)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: sleeve.color }}
                  />
                  <span className="text-sm font-medium truncate">{sleeve.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {actualPct.toFixed(1)}% / {targetPct}%
                  </span>
                  <Badge variant={driftVariant} className="text-[10px] px-1 py-0">
                    {drift === 0 ? '=' : (drift > 0 ? '+' : '')}{drift.toFixed(1)}%
                  </Badge>
                  {holdingRows.length > 0 && (
                    isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
              </button>

              {isExpanded && holdingRows.length > 0 && (
                <div className="border-t border-border bg-muted/30 divide-y divide-border">
                  {holdingRows.map(({ snapshot: hs, ticker, name }) => {
                    const mv = toDisplay(hs.marketValueBase, fxRate, currency)
                    return (
                      <div
                        key={hs.holdingId}
                        className="flex items-center justify-between px-4 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="font-medium">{ticker}</span>
                          <span className="ml-1.5 text-muted-foreground">{name}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 tabular-nums">
                          <span className="text-muted-foreground">
                            {hs.shares > 0 ? `${hs.shares.toFixed(3)} sh` : '—'}
                          </span>
                          <span>{fmtCompact(mv, currency)}</span>
                          <span className="text-muted-foreground">{hs.allocationPct.toFixed(1)}%</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── PriceUpdateDialog ────────────────────────────────────────────────────────

/**
 * Bulk "mark to market" form: shows all holdings with their current price and
 * lets the user update them all in one pass. After saving, a single new
 * PortfolioSnapshot is captured so the chart and stats update immediately.
 */
function PriceUpdateDialog({
  open,
  onOpenChange,
  holdings,
  portfolioId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  holdings: Holding[]
  portfolioId: string
}) {
  // Local price state: holdingId → string (user input)
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // Re-initialise prices whenever dialog opens or holdings change
  useEffect(() => {
    if (!open) return
    const init: Record<string, string> = {}
    for (const h of holdings) {
      init[h.id] = h.currentPricePerShare != null ? String(h.currentPricePerShare) : ''
    }
    setPrices(init)
    setError(null)
  }, [open, holdings])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      // Update each holding that has a valid, changed price
      for (const h of holdings) {
        const raw    = prices[h.id] ?? ''
        const parsed = parseFloat(raw)
        if (!isNaN(parsed) && parsed > 0 && parsed !== h.currentPricePerShare) {
          await db.holdings.update(h.id, { currentPricePerShare: parsed })
        }
      }
      // Single snapshot after all price updates
      const snap = await captureSnapshot(portfolioId)
      await db.snapshots.add({
        id:          crypto.randomUUID(),
        portfolioId,
        ...snap,
      })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save prices')
    } finally {
      setSaving(false)
    }
  }, [holdings, prices, portfolioId, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Update Prices</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground -mt-2 mb-3">
          Enter the latest execution or market price for each holding. One snapshot
          is captured after saving.
        </p>

        <div className="space-y-3">
          {holdings.length === 0 && (
            <p className="text-sm text-muted-foreground">No holdings to update.</p>
          )}
          {holdings.map(h => (
            <div key={h.id} className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{h.ticker}</p>
                <p className="text-xs text-muted-foreground">{h.name}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs text-muted-foreground w-8 text-right">{h.currency}</span>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  className="h-8 w-28 text-right tabular-nums"
                  placeholder="0.00"
                  value={prices[h.id] ?? ''}
                  onChange={e =>
                    setPrices(prev => ({ ...prev, [h.id]: e.target.value }))
                  }
                />
              </div>
            </div>
          ))}
        </div>

        {error && (
          <p className="mt-2 text-sm text-destructive">{error}</p>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Prices'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const portfolio    = usePortfolioStore(s => s.portfolio)
  const currency     = useUIStore(s => s.dashboardCurrency)
  const setCurrency  = useUIStore(s => s.setDashboardCurrency)
  const setActiveTab = useUIStore(s => s.setActiveTab)

  const portfolioId  = portfolio?.id
  const cashAccounts = useCashAccounts(portfolioId)
  const holdings     = useHoldings(portfolioId)
  const sleeves      = useSleeves(portfolioId)

  const [range, setRange]       = useState<Range>('1Y')
  const [priceOpen, setPriceOpen] = useState(false)

  // All operations newest-first
  const allOps =
    useLiveQuery(
      async (): Promise<Operation[]> => {
        if (!portfolioId) return []
        return db.operations
          .where('[portfolioId+timestamp]')
          .between([portfolioId, Dexie.minKey], [portfolioId, Dexie.maxKey])
          .reverse()
          .toArray()
      },
      [portfolioId],
    ) ?? []

  // ── Derived: latest snapshot ────────────────────────────────────────────────

  const latestSnapshot = allOps[0]?.snapshotAfter ?? null
  const fxRate =
    latestSnapshot?.currentFxRate ??
    portfolio?.fxRateOverride ??
    portfolio?.initialFxRate ??
    0

  // Cash
  const twdCash = cashAccounts.find(a => a.currency === 'TWD')?.balance ?? 0
  const usdCash = cashAccounts.find(a => a.currency === 'USD')?.balance ?? 0
  const cashInDisplay =
    currency === 'TWD'
      ? twdCash + usdCash * fxRate
      : usdCash + (fxRate > 0 ? twdCash / fxRate : 0)

  // ── Current-state metrics computed directly from live holdings ───────────────
  // Using db.holdings (via useHoldings) instead of latestSnapshot means these
  // values update immediately after "Update Prices" — without needing a new
  // operation record.
  const { totalValueBase, unrealizedBase, costBasisBase } = useMemo(() => {
    let holdingsBase = 0
    let unrealized   = 0
    let costBasis    = 0
    for (const h of holdings) {
      const shares   = h.currentShares ?? 0
      const price    = h.currentPricePerShare ?? 0
      const mv       = shares * price
      const mvBase   = h.currency === 'USD' ? mv * fxRate : mv
      const cbBase   = shares * (h.averageCostBasisBase ?? 0)
      holdingsBase  += mvBase
      unrealized    += mvBase - cbBase
      costBasis     += cbBase
    }
    const totalValue = holdingsBase + twdCash + usdCash * fxRate
    return { totalValueBase: totalValue, unrealizedBase: unrealized, costBasisBase: costBasis }
  }, [holdings, fxRate, twdCash, usdCash])

  const totalValueDisplay = toDisplay(totalValueBase, fxRate, currency)

  const unrealizedDisplay = toDisplay(unrealizedBase, fxRate, currency)
  const costBasisDisplay  = toDisplay(costBasisBase, fxRate, currency)
  const unrealizedPct     = costBasisBase > 0 ? (unrealizedBase / costBasisBase) * 100 : 0

  // ── Chart data (filtered by selected range, oldest-first for chart) ─────────

  const chartData = useMemo(() => {
    if (!allOps.length) return []
    const fromDate = getFromDate(range)
    return [...allOps]
      .reverse()  // oldest first
      .filter(op => fromDate == null || new Date(op.timestamp) >= fromDate)
      .map(op => ({
        date:  fmtDate(op.timestamp),
        value: toDisplay(
          op.snapshotAfter.totalValueBase,
          op.snapshotAfter.currentFxRate,
          currency,
        ),
      }))
  }, [allOps, range, currency])

  // Period change vs first data point in range
  const periodChange = useMemo(() => {
    if (chartData.length < 2) return null
    const start   = chartData[0].value
    const current = chartData[chartData.length - 1].value
    const delta   = current - start
    const pct     = start > 0 ? (delta / start) * 100 : 0
    return { delta, pct }
  }, [chartData])

  // ── Sleeve allocations — derived from live holdings, not snapshot ────────────
  // Recomputes whenever holdings (prices/shares) or cash/fxRate changes.

  const sleeveAllocs = useMemo((): SleeveAlloc[] => {
    if (!sleeves.length) return []

    // Re-derive total for allocation % (same formula as totalValueBase above)
    let holdingsBase = 0
    for (const h of holdings) {
      const mv     = (h.currentShares ?? 0) * (h.currentPricePerShare ?? 0)
      holdingsBase += h.currency === 'USD' ? mv * fxRate : mv
    }
    const total = holdingsBase + twdCash + usdCash * fxRate

    return sleeves.map(sleeve => {
      const sleeveHoldings = holdings.filter(h => h.sleeveId === sleeve.id)
      const holdingRows = sleeveHoldings.map(h => {
        const shares       = h.currentShares ?? 0
        const price        = h.currentPricePerShare ?? 0
        const mv           = shares * price
        const mvBase       = h.currency === 'USD' ? mv * fxRate : mv
        const allocationPct= total > 0 ? (mvBase / total) * 100 : 0
        const snapshot: HoldingSnapshot = {
          holdingId:      h.id,
          shares,
          pricePerShare:  price,
          marketValue:    mv,
          marketValueBase: mvBase,
          costBasis:      shares * (h.averageCostBasis ?? 0),
          costBasisBase:  shares * (h.averageCostBasisBase ?? 0),
          allocationPct,
          driftFromTarget: allocationPct - h.targetAllocationPct,
        }
        return { snapshot, ticker: h.ticker, name: h.name }
      })
      const actualPct = holdingRows.reduce((s, r) => s + r.snapshot.allocationPct, 0)
      return { sleeve, actualPct, targetPct: sleeve.targetAllocationPct, holdingRows }
    })
  }, [sleeves, holdings, fxRate, twdCash, usdCash])

  if (!portfolio) return null

  // Gradient color depends on selected currency
  const gradientId    = currency === 'TWD' ? 'grad-twd' : 'grad-usd'
  const strokeColor   = currency === 'TWD' ? '#3b82f6' : '#10b981'
  const isUp          = (periodChange?.delta ?? 0) >= 0
  const pnlUp         = unrealizedDisplay >= 0

  return (
    <div className="px-4 pt-4 pb-8 space-y-5">

      {/* ── Header + Currency Toggle ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">{portfolio.name}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Dashboard</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setPriceOpen(true)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="text-xs">Prices</span>
          </Button>
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </div>
      </div>

      {/* ── Hero Chart ───────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4">
        {/* Value + period change */}
        <div className="mb-3">
          <p className="text-3xl font-bold tabular-nums">
            {fmtFull(totalValueDisplay, currency)}
          </p>
          {periodChange && (
            <div
              className={cn(
                'flex items-center gap-1.5 mt-1 text-sm font-medium',
                isUp
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400',
              )}
            >
              {isUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              <span>
                {isUp ? '+' : ''}{fmtFull(periodChange.delta, currency)}
              </span>
              <span className="font-normal text-xs text-muted-foreground">
                ({isUp ? '+' : ''}{periodChange.pct.toFixed(2)}%)
              </span>
              <span className="font-normal text-xs text-muted-foreground ml-1">
                {range}
              </span>
            </div>
          )}
        </div>

        {/* Chart area */}
        {chartData.length < 2 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground text-center px-4">
            Log some operations to see your portfolio chart.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={strokeColor} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={strokeColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmtCompact(v, currency)}
                width={58}
              />
              <Tooltip
                content={(props) => (
                  <ChartTooltip
                    active={props.active}
                    payload={props.payload as { value: number }[] | undefined}
                    label={props.label as string | undefined}
                    currency={currency}
                  />
                )}
                cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={strokeColor}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                activeDot={{ r: 3, fill: strokeColor }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}

        {/* Time range pills */}
        <div className="mt-3 flex items-center justify-center gap-1">
          {RANGES.map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                r === range
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* ── Quick Stats ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2">
        {/* Unrealized P&L */}
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Unreal. P&L
          </p>
          <p
            className={cn(
              'mt-1 text-base font-bold tabular-nums truncate',
              pnlUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
            )}
          >
            {pnlUp ? '+' : ''}{fmtCompact(unrealizedDisplay, currency)}
          </p>
          <p
            className={cn(
              'text-xs tabular-nums',
              pnlUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
            )}
          >
            {pnlUp ? '+' : ''}{unrealizedPct.toFixed(1)}%
          </p>
        </div>

        {/* Cost basis */}
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Cost Basis
          </p>
          <p className="mt-1 text-base font-bold tabular-nums truncate">
            {fmtCompact(costBasisDisplay, currency)}
          </p>
        </div>

        {/* Cash */}
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Cash
          </p>
          <p className="mt-1 text-base font-bold tabular-nums truncate">
            {fmtCompact(cashInDisplay, currency)}
          </p>
        </div>
      </div>

      {/* ── Allocation Overview ───────────────────────────────────────────────── */}
      {sleeves.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Allocation</h2>
          {sleeveAllocs.length > 0 ? (
            <AllocationSection allocs={sleeveAllocs} currency={currency} fxRate={fxRate} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Log trades to see allocation data.
            </p>
          )}
        </div>
      )}

      {/* ── Cash Balances ─────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold mb-3">Cash</h2>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">TWD</span>
            <span className="font-medium tabular-nums">
              {new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: 'TWD',
                maximumFractionDigits: 0,
              }).format(twdCash)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">USD</span>
            <div className="text-right">
              <span className="font-medium tabular-nums">
                {new Intl.NumberFormat(undefined, {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 2,
                }).format(usdCash)}
              </span>
              {fxRate > 0 && (
                <span className="block text-[11px] text-muted-foreground tabular-nums">
                  ≈{new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: 'TWD',
                    maximumFractionDigits: 0,
                  }).format(usdCash * fxRate)}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-2 font-semibold">
            <span>Total ({currency})</span>
            <span className="tabular-nums">{fmtFull(cashInDisplay, currency)}</span>
          </div>
        </div>
        {fxRate > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Rate: 1 USD = {fxRate.toFixed(4)} TWD
          </p>
        )}
      </div>

      {/* ── Recent Operations ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent Operations</h2>
          <button
            onClick={() => setActiveTab('operations')}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            View all <ArrowRight className="h-3 w-3" />
          </button>
        </div>
        {allOps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No operations yet. Tap + to log your first.
          </p>
        ) : (
          allOps.slice(0, 3).map(op => (
            <OperationCard key={op.id} operation={op} compact />
          ))
        )}
      </div>

      {/* ── Price Update Dialog ───────────────────────────────────────────────── */}
      {portfolioId && (
        <PriceUpdateDialog
          open={priceOpen}
          onOpenChange={setPriceOpen}
          holdings={holdings}
          portfolioId={portfolioId}
        />
      )}

    </div>
  )
}
