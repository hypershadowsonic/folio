import { useState, useMemo, useCallback } from 'react'
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
import { TrendingUp, TrendingDown, ArrowRight, RefreshCw, ChevronDown, ChevronRight, Package, SlidersHorizontal } from 'lucide-react'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore, type DisplayCurrency } from '@/stores/uiStore'
import { refreshAllPrices } from '@/services/yahooFinance'
import { useCashAccounts, useHoldings, useLegacyHoldings } from '@/db/hooks'
import type { Holding } from '@/types'
import { DriftMonitor } from './DriftMonitor'
import { AmmunitionPoolWidget } from './AmmunitionPoolWidget'
import { PriceUpdateDialog } from './PriceUpdateDialog'
import { db } from '@/db/database'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { OperationCard } from '@/features/operations/OperationCard'
import type { Operation } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Range = '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL'

const RANGES: Range[] = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL']

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

// ─── LegacyHoldingsSection ────────────────────────────────────────────────────

interface LegacyHoldingsSectionProps {
  holdings: Holding[]
  fxRate: number
  currency: DisplayCurrency
}

function LegacyHoldingsSection({ holdings, fxRate, currency }: LegacyHoldingsSectionProps) {
  const [open, setOpen] = useState(false)

  if (holdings.length === 0) return null

  const totalBase = holdings.reduce((sum, h) => {
    const mv = (h.currentShares ?? 0) * (h.currentPricePerShare ?? 0)
    return sum + (h.currency === 'USD' ? mv * fxRate : mv)
  }, 0)
  const totalDisplay = currency === 'TWD' ? totalBase : (fxRate > 0 ? totalBase / fxRate : 0)

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Legacy Holdings</span>
          <span className="text-xs text-muted-foreground font-normal">
            ({holdings.length})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums text-muted-foreground">
            {new Intl.NumberFormat(undefined, {
              style: 'currency', currency,
              maximumFractionDigits: currency === 'TWD' ? 0 : 2,
              notation: 'compact',
            }).format(totalDisplay)}
          </span>
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-border divide-y divide-border/60">
          {holdings.map(h => {
            const shares    = h.currentShares ?? 0
            const price     = h.currentPricePerShare ?? 0
            const mv        = shares * price
            const mvBase    = h.currency === 'USD' ? mv * fxRate : mv
            const cbBase    = shares * (h.averageCostBasisBase ?? 0)
            const pnlBase   = mvBase - cbBase
            const pnlPct    = cbBase > 0 ? (pnlBase / cbBase) * 100 : 0
            const mvDisplay = currency === 'TWD' ? mvBase : (fxRate > 0 ? mvBase / fxRate : 0)
            const pnlDisplay= currency === 'TWD' ? pnlBase : (fxRate > 0 ? pnlBase / fxRate : 0)
            const pnlUp     = pnlDisplay >= 0

            return (
              <div key={h.id} className="flex items-center justify-between px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium font-mono">{h.ticker}</p>
                  <p className="text-xs text-muted-foreground">{shares.toFixed(4)} shares @ {h.currency}{price.toFixed(2)}</p>
                </div>
                <div className="text-right shrink-0 ml-4">
                  <p className="text-sm font-medium tabular-nums">
                    {new Intl.NumberFormat(undefined, {
                      style: 'currency', currency,
                      maximumFractionDigits: currency === 'TWD' ? 0 : 2,
                    }).format(mvDisplay)}
                  </p>
                  <p className={cn('text-xs tabular-nums', pnlUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                    {pnlUp ? '+' : ''}{new Intl.NumberFormat(undefined, {
                      style: 'currency', currency,
                      maximumFractionDigits: currency === 'TWD' ? 0 : 2,
                      notation: 'compact',
                    }).format(pnlDisplay)} ({pnlUp ? '+' : ''}{pnlPct.toFixed(1)}%)
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const portfolio    = usePortfolioStore(s => s.portfolio)
  const currency     = useUIStore(s => s.dashboardCurrency)
  const setCurrency  = useUIStore(s => s.setDashboardCurrency)
  const setActiveTab = useUIStore(s => s.setActiveTab)

  const portfolioId    = portfolio?.id
  const cashAccounts   = useCashAccounts(portfolioId)
  const holdings       = useHoldings(portfolioId)
  const legacyHoldings = useLegacyHoldings(portfolioId)

  const [range, setRange]           = useState<Range>('1Y')
  const [priceOpen, setPriceOpen]   = useState(false)
  const [bmUpdatedTicker, setBmUpdatedTicker] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const apiStatus = useUIStore((s) => s.apiStatus)

  const handleRefreshPrices = useCallback(async () => {
    if (!portfolioId || !holdings || isRefreshing) return
    setIsRefreshing(true)
    try {
      await refreshAllPrices(holdings, portfolioId)
    } finally {
      setIsRefreshing(false)
    }
  }, [portfolioId, holdings, isRefreshing])

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

  // All snapshots oldest-first — drives the portfolio value chart
  const allSnaps =
    useLiveQuery(
      async () => {
        if (!portfolioId) return []
        return db.snapshots
          .where('[portfolioId+timestamp]')
          .between([portfolioId, Dexie.minKey], [portfolioId, Dexie.maxKey])
          .toArray()
      },
      [portfolioId],
    ) ?? []

  // Most recent trade timestamp per holding — for "Last Updated" in PriceUpdateDialog
  const lastUpdatedByHolding = useMemo(() => {
    const map = new Map<string, Date>()
    for (const op of allOps) {
      const ts = new Date(op.timestamp)
      for (const entry of op.entries) {
        const existing = map.get(entry.holdingId)
        if (!existing || ts > existing) map.set(entry.holdingId, ts)
      }
    }
    return map
  }, [allOps])

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
    const totalValue = holdingsBase
    return { totalValueBase: totalValue, unrealizedBase: unrealized, costBasisBase: costBasis }
  }, [holdings, fxRate, twdCash, usdCash])

  const totalValueDisplay = toDisplay(totalValueBase, fxRate, currency)

  const unrealizedDisplay = toDisplay(unrealizedBase, fxRate, currency)
  const costBasisDisplay  = toDisplay(costBasisBase, fxRate, currency)
  const unrealizedPct     = costBasisBase > 0 ? (unrealizedBase / costBasisBase) * 100 : 0

  // ── Chart data (filtered by selected range, oldest-first for chart) ─────────
  // Reads from db.snapshots — same source as Performance tab — so both charts
  // always show the same Portfolio Value line.

  const chartData = useMemo(() => {
    if (!allSnaps.length) return []
    const fromDate = getFromDate(range)
    return allSnaps
      .filter(s => fromDate == null || new Date(s.timestamp) >= fromDate)
      .map(s => ({
        date:  fmtDate(s.timestamp),
        value: toDisplay(
          s.holdings.reduce((sum, h) => sum + h.marketValueBase, 0),
          s.currentFxRate,
          currency,
        ),
      }))
  }, [allSnaps, range, currency])

  // Period change vs first data point in range
  const periodChange = useMemo(() => {
    if (chartData.length < 2) return null
    const start   = chartData[0].value
    const current = chartData[chartData.length - 1].value
    const delta   = current - start
    const pct     = start > 0 ? (delta / start) * 100 : 0
    return { delta, pct }
  }, [chartData])

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
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              disabled={isRefreshing}
              onClick={() => void handleRefreshPrices()}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
              <span className="text-xs">{isRefreshing ? 'Updating…' : 'Refresh Prices'}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Manual price entry"
              onClick={() => setPriceOpen(true)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="sr-only">Manual price entry</span>
            </Button>
          </div>
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </div>
      </div>

      {/* ── API status banner ───────────────────────────────────────────────── */}
      {apiStatus !== 'online' && (
        <p className="text-xs text-muted-foreground text-center">
          {apiStatus === 'offline-cached'
            ? 'Offline — showing cached prices'
            : 'Offline — no cached prices available'}
        </p>
      )}

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
              type="button"
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

      {/* ── Allocation + Drift Monitor ────────────────────────────────────────── */}
      <DriftMonitor
        portfolioId={portfolio.id}
        onNavigateToDCA={() => setActiveTab('dca-planner')}
      />

      {/* ── Legacy Holdings ───────────────────────────────────────────────────── */}
      <LegacyHoldingsSection
        holdings={legacyHoldings}
        fxRate={fxRate}
        currency={currency}
      />

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

      {/* ── Ammunition Pool ───────────────────────────────────────────────────── */}
      <AmmunitionPoolWidget
        portfolioId={portfolio.id}
        onNavigateToSettings={() => setActiveTab('settings')}
      />

      {/* ── Recent Operations ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent Operations</h2>
          <button
            type="button"
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
          onOpenChange={open => {
            setPriceOpen(open)
            if (!open) setTimeout(() => setBmUpdatedTicker(null), 3000)
          }}
          holdings={holdings}
          portfolioId={portfolioId}
          benchmarkConfig={portfolio?.benchmarkConfig}
          onBenchmarkUpdated={ticker => setBmUpdatedTicker(ticker)}
          lastUpdatedByHolding={lastUpdatedByHolding}
        />
      )}

      {/* ── Benchmark sync note ──────────────────────────────────────────────── */}
      {bmUpdatedTicker && (
        <div className="fixed bottom-20 left-4 right-4 z-50 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md text-center text-muted-foreground animate-in fade-in">
          Benchmark ({bmUpdatedTicker}) price also updated.
        </div>
      )}

    </div>
  )
}
