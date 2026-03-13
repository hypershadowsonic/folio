/**
 * PerformancePage.tsx — Performance Analytics tab (Phase 6).
 *
 * Sections:
 *   1. Sticky header: time range pills + currency toggle + Prices button
 *   2. Dual-axis hero chart (Portfolio Value left, PnL right; optional benchmark)
 *   3. 6 metric cards: Portfolio Value, Unrealized P&L, Realized P&L, Total P&L, TWR, MWR
 *   4. Month-over-month growth bar chart (last 12 months)
 *   5. Sleeve attribution (expandable holding breakdown)
 *   6. Benchmark comparison card
 *   7. Period summary
 */

import { useState, useMemo } from 'react'
import {
  ComposedChart,
  Area,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { useLiveQuery } from 'dexie-react-hooks'
import Dexie from 'dexie'
import { Info, ChevronDown, ChevronRight, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react'
import { db } from '@/db/database'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore, type DisplayCurrency } from '@/stores/uiStore'
import { useHoldings } from '@/db/hooks'
import { PriceUpdateDialog } from '@/features/dashboard/PriceUpdateDialog'
import { Button } from '@/components/ui/button'
import {
  calculateTWR,
  calculateMWR,
  calculateSleeveAttribution,
  calculateBenchmarkComparison,
  calculateRealizedPnL,
  calculateUnrealizedPnL,
  calculateMoMGrowth,
  buildPerformanceChartData,
  annualizeTWR,
} from '@/engine/performance'
import { cn } from '@/lib/utils'
import type { PortfolioSnapshot, Operation, Holding, Sleeve } from '@/types'
import type { SleeveAttribution, MoMDataPoint, PerfChartPoint } from '@/engine/performance'

// ─── Types ────────────────────────────────────────────────────────────────────

type RangePreset = '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL' | 'Custom'

const RANGE_PRESETS: RangePreset[] = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL', 'Custom']

interface PeriodSummary {
  startValue: number
  endValue: number
  totalDeposits: number
  totalWithdrawals: number
  netGain: number
  operationCount: number
}

interface PerformanceData {
  snapshots: PortfolioSnapshot[]
  // Returns
  twrPct: number
  annualizedTwrPct: number | null
  mwrAnnualizedPct: number
  mwrSimplePct: number
  // Current metrics
  currentPortfolioValue: number   // holdings only, in valueCurrency
  unrealizedPnL: number
  realizedPnL: number
  totalPnL: number
  // Charts
  perfChartData: PerfChartPoint[]
  momData: MoMDataPoint[]
  // Attribution + period
  sleeveAttribution: SleeveAttribution[]
  periodSummary: PeriodSummary
  hasSufficientData: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPresetDates(range: RangePreset): { start: Date; end: Date } {
  const end   = new Date()
  const start = new Date()
  if (range === '1M')  start.setMonth(start.getMonth() - 1)
  else if (range === '3M')  start.setMonth(start.getMonth() - 3)
  else if (range === '6M')  start.setMonth(start.getMonth() - 6)
  else if (range === 'YTD') { start.setMonth(0); start.setDate(1); start.setHours(0, 0, 0, 0) }
  else if (range === '1Y')  start.setFullYear(start.getFullYear() - 1)
  else if (range === 'ALL') start.setFullYear(2000)
  return { start, end }
}

function toDisplay(valueBase: number, currency: DisplayCurrency, fxRate: number): number {
  if (currency === 'TWD') return valueBase
  return fxRate > 0 ? valueBase / fxRate : 0
}

function fmtCurrency(v: number, currency: DisplayCurrency): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'TWD' ? 0 : 2,
  }).format(v)
}

function fmtCompact(v: number, currency: DisplayCurrency): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(v)
}

function fmtPct(v: number, showSign = true): string {
  const sign = showSign && v > 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(2)}%`
}

function daysBetween(a: Date, b: Date): number {
  return Math.round(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

// ─── usePerformanceData ───────────────────────────────────────────────────────

function usePerformanceData(
  portfolioId: string | undefined,
  startDate: Date,
  endDate: Date,
  currency: DisplayCurrency,
): PerformanceData | undefined {
  const raw = useLiveQuery(async () => {
    if (!portfolioId) return null

    const [snaps, ops, holdings, sleeves] = await Promise.all([
      db.snapshots
        .where('[portfolioId+timestamp]')
        .between([portfolioId, Dexie.minKey], [portfolioId, Dexie.maxKey])
        .toArray(),
      db.operations
        .where('[portfolioId+timestamp]')
        .between([portfolioId, Dexie.minKey], [portfolioId, Dexie.maxKey])
        .toArray(),
      db.holdings.where('portfolioId').equals(portfolioId).toArray(),
      db.sleeves.where('portfolioId').equals(portfolioId).toArray(),
    ])

    return { snaps, ops, holdings, sleeves }
  }, [portfolioId])

  return useMemo(() => {
    if (!raw) return undefined

    const { snaps, ops, holdings, sleeves } = raw

    // Use the fxRate from the most recent snapshot; fall back to 1
    const latestSnap = snaps.length > 0
      ? snaps.reduce((a, b) => new Date(a.timestamp) > new Date(b.timestamp) ? a : b)
      : null
    const fxRate = latestSnap?.currentFxRate ?? 1

    const startMs = startDate.getTime()
    const endMs   = endDate.getTime()

    const periodSnaps = snaps
      .filter(s => {
        const t = new Date(s.timestamp).getTime()
        return t >= startMs && t <= endMs
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    const periodOps = ops.filter(op => {
      const t = new Date(op.timestamp).getTime()
      return t >= startMs && t <= endMs
    })

    const hasSufficientData = periodSnaps.length >= 2

    // ── TWR ──────────────────────────────────────────────────────────────────
    const { twrPct } = hasSufficientData
      ? calculateTWR(periodSnaps as PortfolioSnapshot[], ops as Operation[], startDate, endDate, currency, fxRate)
      : { twrPct: 0 }

    const days = daysBetween(startDate, endDate)
    const annualizedTwrPct = days >= 365 ? annualizeTWR(twrPct, days) : null

    // ── MWR ──────────────────────────────────────────────────────────────────
    const currentValue = latestSnap ? toDisplay(latestSnap.totalValueBase, currency, fxRate) : 0
    const { annualizedPct: mwrAnnualizedPct, mwrPct: mwrSimplePct } = calculateMWR(
      ops as Operation[], currentValue, endDate, startDate, currency, fxRate,
    )

    // ── Current portfolio value (holdings only, live DB fields) ───────────────
    const currentPortfolioValue = holdings.reduce((s, h) => {
      const mv     = (h.currentShares ?? 0) * (h.currentPricePerShare ?? 0)
      const mvBase = h.currency === 'USD' ? mv * fxRate : mv
      return s + (currency === 'TWD' ? mvBase : (fxRate > 0 ? mvBase / fxRate : 0))
    }, 0)

    // ── P&L metrics ──────────────────────────────────────────────────────────
    const unrealizedPnL = calculateUnrealizedPnL(holdings as Holding[], currency, fxRate)
    const realizedPnL   = calculateRealizedPnL(
      ops as Operation[], startDate, endDate, holdings as Holding[], currency, fxRate,
    )
    const totalPnL = unrealizedPnL + realizedPnL

    // ── Sleeve attribution ────────────────────────────────────────────────────
    const snapshotStart = periodSnaps[0]
    const snapshotEnd   = periodSnaps[periodSnaps.length - 1]
    const sleeveAttribution = hasSufficientData
      ? calculateSleeveAttribution(
          snapshotStart as PortfolioSnapshot,
          snapshotEnd   as PortfolioSnapshot,
          sleeves as Sleeve[],
          holdings as Holding[],
          currency,
          fxRate,
        )
      : []

    // ── Chart data ────────────────────────────────────────────────────────────
    const perfChartData = buildPerformanceChartData(
      periodSnaps as PortfolioSnapshot[],
      ops as Operation[],
      currency,
      fxRate,
    )

    const momData = calculateMoMGrowth(snaps as PortfolioSnapshot[], 12, currency, fxRate)

    // ── Period summary ────────────────────────────────────────────────────────
    const startValue = snapshotStart ? toDisplay(snapshotStart.totalValueBase, currency, fxRate) : 0
    const endValue   = snapshotEnd   ? toDisplay(snapshotEnd.totalValueBase,   currency, fxRate) : 0

    let totalDeposits    = 0
    let totalWithdrawals = 0
    for (const op of periodOps) {
      if (!op.cashFlow) continue
      const amt = op.cashFlow.currency === currency
        ? op.cashFlow.amount
        : currency === 'TWD' ? op.cashFlow.amount * fxRate : op.cashFlow.amount / fxRate
      if (op.type === 'CASH_DEPOSIT')    totalDeposits    += Math.abs(amt)
      if (op.type === 'CASH_WITHDRAWAL') totalWithdrawals += Math.abs(amt)
    }

    const netGain = (endValue - startValue) - (totalDeposits - totalWithdrawals)

    return {
      snapshots: periodSnaps as PortfolioSnapshot[],
      twrPct,
      annualizedTwrPct,
      mwrAnnualizedPct,
      mwrSimplePct,
      currentPortfolioValue,
      unrealizedPnL,
      realizedPnL,
      totalPnL,
      perfChartData,
      momData,
      sleeveAttribution,
      periodSummary: { startValue, endValue, totalDeposits, totalWithdrawals, netGain, operationCount: periodOps.length },
      hasSufficientData,
    }
  }, [raw, startDate.getTime(), endDate.getTime(), currency])  // eslint-disable-line react-hooks/exhaustive-deps
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
          type="button"
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

// ─── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({
  title,
  value,
  subLabel,
  positive,
  tooltip,
}: {
  title: string
  value: string
  subLabel?: string
  /** true = green, false = red, null = neutral */
  positive?: boolean | null
  tooltip?: string
}) {
  const [showTip, setShowTip] = useState(false)

  const colorClass =
    positive === true  ? 'text-emerald-600 dark:text-emerald-400' :
    positive === false ? 'text-red-500' :
    'text-foreground'

  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-medium text-muted-foreground truncate">{title}</span>
        {tooltip && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground shrink-0"
            onClick={() => setShowTip(v => !v)}
            aria-label="More info"
          >
            <Info className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
      {showTip && tooltip && (
        <p className="text-[10px] text-muted-foreground bg-muted rounded px-2 py-1 leading-relaxed">
          {tooltip}
        </p>
      )}
      <p className={cn('text-base font-bold tabular-nums truncate', colorClass)}>
        {value}
      </p>
      {subLabel && (
        <p className="text-[10px] text-muted-foreground truncate">{subLabel}</p>
      )}
    </div>
  )
}

// ─── ReturnCard ───────────────────────────────────────────────────────────────

function ReturnCard({
  title,
  returnPct,
  subtitle,
  tooltip,
}: {
  title: string
  returnPct: number | null
  subtitle?: string
  tooltip: string
}) {
  const [showTip, setShowTip] = useState(false)
  const positive = (returnPct ?? 0) >= 0

  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-medium text-muted-foreground truncate">{title}</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={() => setShowTip(v => !v)}
          aria-label="More info"
        >
          <Info className="h-2.5 w-2.5" />
        </button>
      </div>
      {showTip && (
        <p className="text-[10px] text-muted-foreground bg-muted rounded px-2 py-1 leading-relaxed">
          {tooltip}
        </p>
      )}
      {returnPct === null ? (
        <div className="h-6 w-20 rounded bg-muted animate-pulse" />
      ) : (
        <div className={cn(
          'text-base font-bold tabular-nums flex items-center gap-1',
          positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
        )}>
          {positive
            ? <TrendingUp className="h-3.5 w-3.5 shrink-0" />
            : <TrendingDown className="h-3.5 w-3.5 shrink-0" />
          }
          {fmtPct(returnPct)}
        </div>
      )}
      {subtitle && (
        <p className="text-[10px] text-muted-foreground truncate">{subtitle}</p>
      )}
    </div>
  )
}

// ─── HeroChartTooltip ─────────────────────────────────────────────────────────

function HeroChartTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean
  payload?: { value: number; name: string; color: string }[]
  label?: string
  currency: DisplayCurrency
}) {
  if (!active || !payload?.length) return null

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md space-y-1">
      {label && <p className="text-muted-foreground mb-1">{label}</p>}
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          {/* dynamic color from Recharts series — no static Tailwind equivalent */}
          {/* eslint-disable-next-line react/forbid-dom-props */}
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold tabular-nums">{fmtCurrency(p.value, currency)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── MoMChartTooltip ──────────────────────────────────────────────────────────

function MoMChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { value: number }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const pct = payload[0].value
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      {label && <p className="text-muted-foreground">{label}</p>}
      <p className={cn('font-semibold tabular-nums', pct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
        {pct >= 0 ? '+' : ''}{(pct * 100).toFixed(2)}%
      </p>
    </div>
  )
}

// ─── SleeveAttributionSection ─────────────────────────────────────────────────

function SleeveAttributionSection({
  attribution,
  currency,
}: {
  attribution: SleeveAttribution[]
  currency: DisplayCurrency
}) {
  const [expandedSleeve, setExpandedSleeve] = useState<string | null>(null)

  if (attribution.length === 0) return null

  const maxAbs = Math.max(...attribution.map(s => Math.abs(s.absoluteReturn)), 1)

  return (
    <div className="space-y-2">
      {attribution.map(sleeve => {
        const expanded    = expandedSleeve === sleeve.sleeveId
        const isPositive  = sleeve.absoluteReturn >= 0
        const barWidthPct = Math.abs(sleeve.absoluteReturn) / maxAbs * 100

        return (
          <div key={sleeve.sleeveId} className="rounded-lg border border-border bg-card overflow-hidden">
            <button
              type="button"
              className="w-full px-4 py-3 text-left"
              onClick={() => setExpandedSleeve(expanded ? null : sleeve.sleeveId)}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  {expanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  }
                  {/* dynamic sleeve color — no static Tailwind equivalent */}
                  {/* eslint-disable-next-line react/forbid-dom-props */}
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: sleeve.sleeveColor }} />
                  <span className="text-sm font-medium truncate">{sleeve.sleeveName}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 tabular-nums text-xs">
                  <span className={cn('font-semibold', isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                    {isPositive ? '+' : ''}{fmtCurrency(sleeve.absoluteReturn, currency)}
                  </span>
                  {sleeve.returnPct !== null && (
                    <span className={cn('text-muted-foreground', isPositive ? 'text-emerald-600/70 dark:text-emerald-400/70' : 'text-red-400')}>
                      {fmtPct(sleeve.returnPct / 100)}
                    </span>
                  )}
                </div>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                {/* eslint-disable-next-line react/forbid-dom-props -- dynamic color/width require inline style */}
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${barWidthPct}%`, background: sleeve.sleeveColor, opacity: isPositive ? 1 : 0.6 }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {sleeve.contributionPct.toFixed(1)}% of total portfolio return
              </p>
            </button>

            {expanded && sleeve.holdings.length > 0 && (
              <div className="border-t border-border/60 divide-y divide-border/40">
                {sleeve.holdings.map(h => {
                  const hPositive = h.absoluteReturn >= 0
                  const hBarPct   = Math.abs(h.absoluteReturn) /
                    Math.max(...sleeve.holdings.map(hh => Math.abs(hh.absoluteReturn)), 1) * 100
                  return (
                    <div key={h.holdingId} className="px-4 py-2.5 bg-muted/30">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-xs font-medium text-muted-foreground pl-6">{h.ticker}</span>
                        <div className="flex items-center gap-3 tabular-nums text-xs">
                          <span className={cn('font-medium', hPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                            {hPositive ? '+' : ''}{fmtCurrency(h.absoluteReturn, currency)}
                          </span>
                          {h.returnPct !== null && (
                            <span className="text-muted-foreground text-[10px]">{fmtPct(h.returnPct / 100)}</span>
                          )}
                        </div>
                      </div>
                      <div className="h-1 bg-muted rounded-full overflow-hidden ml-6">
                        {/* eslint-disable-next-line react/forbid-dom-props -- dynamic width requires inline style */}
                        <div
                          className={cn('h-full rounded-full', hPositive ? 'bg-emerald-500' : 'bg-red-400')}
                          style={{ width: `${hBarPct}%` }}
                        />
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
  )
}

// ─── PerformancePage ──────────────────────────────────────────────────────────

export default function PerformancePage() {
  const portfolio   = usePortfolioStore(s => s.portfolio)
  const currency    = useUIStore(s => s.dashboardCurrency)
  const setCurrency = useUIStore(s => s.setDashboardCurrency)
  const holdings    = useHoldings(portfolio?.id)
  const [priceOpen, setPriceOpen] = useState(false)

  // ── Date range state ──────────────────────────────────────────────────────
  const [preset, setPreset]           = useState<RangePreset>('1Y')
  const [customStart, setCustomStart] = useState('')
  const [customEnd,   setCustomEnd]   = useState('')

  const { start: startDate, end: endDate } = useMemo(() => {
    if (preset === 'Custom') {
      const s = customStart ? new Date(customStart) : new Date(Date.now() - 365 * 86400_000)
      const e = customEnd   ? new Date(customEnd)   : new Date()
      return { start: s, end: e }
    }
    return getPresetDates(preset)
  }, [preset, customStart, customEnd])

  // ── Data ──────────────────────────────────────────────────────────────────
  const data = usePerformanceData(portfolio?.id, startDate, endDate, currency)

  const bm = useMemo(() => {
    const cfg = portfolio?.benchmarkConfig
    if (!data || !cfg) return null
    if (cfg.startPrice <= 0 || cfg.currentPrice <= 0) return null
    return calculateBenchmarkComparison(data.twrPct, cfg.ticker, cfg.startPrice, cfg.currentPrice)
  }, [data?.twrPct, portfolio?.benchmarkConfig])  // eslint-disable-line react-hooks/exhaustive-deps

  const days = daysBetween(startDate, endDate)

  if (!portfolio) return null

  if (data === undefined) {
    return (
      <div className="px-4 pt-5 space-y-3">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 w-full bg-muted animate-pulse rounded-lg" />
        <div className="h-48 w-full bg-muted animate-pulse rounded-lg" />
      </div>
    )
  }

  const mwrDisplay = !isNaN(data.mwrAnnualizedPct) ? data.mwrAnnualizedPct : data.mwrSimplePct
  const mwrIsNaN   = isNaN(data.mwrAnnualizedPct)

  const hasBenchmarkLine = (portfolio.benchmarkConfig?.startPrice ?? 0) > 0 &&
                           (portfolio.benchmarkConfig?.currentPrice ?? 0) > 0

  // Rebuild chart data with benchmark if configured
  const perfChartWithBm = useMemo(() => {
    if (!hasBenchmarkLine || data.perfChartData.length === 0) return data.perfChartData
    const cfg = portfolio.benchmarkConfig!
    const n   = data.perfChartData.length
    const startPV = data.perfChartData[0].portfolioValue
    const bmReturn = (cfg.currentPrice / cfg.startPrice) - 1
    return data.perfChartData.map((p, i) => ({
      ...p,
      benchmarkValue: startPV * (1 + bmReturn * (i / Math.max(n - 1, 1))),
    }))
  }, [data.perfChartData, hasBenchmarkLine, portfolio.benchmarkConfig])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col pb-28">

      {/* ── 1. Sticky header ────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 pt-5 pb-3">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h1 className="text-xl font-semibold">Performance</h1>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setPriceOpen(true)}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="text-xs">Prices</span>
            </Button>
            <CurrencyToggle value={currency} onChange={setCurrency} />
          </div>
        </div>

        {/* Range pills */}
        <div className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map(r => (
            <button
              key={r}
              type="button"
              onClick={() => setPreset(r)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                preset === r
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Custom date inputs */}
        {preset === 'Custom' && (
          <div className="flex gap-2 mt-3">
            <div className="flex-1">
              <label htmlFor="perf-date-from" className="text-[10px] text-muted-foreground block mb-1">From</label>
              <input
                id="perf-date-from"
                type="date"
                title="Period start date"
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label htmlFor="perf-date-to" className="text-[10px] text-muted-foreground block mb-1">To</label>
              <input
                id="perf-date-to"
                type="date"
                title="Period end date"
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      <div className="px-4 pt-4 space-y-5">

        {/* ── 2. Hero chart ────────────────────────────────────────────────── */}
        {perfChartWithBm.length >= 2 ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-1">Portfolio Performance</h2>
            <p className="text-[10px] text-muted-foreground mb-3">Holdings value (left) · P&L (right)</p>
            <div className="h-[48vw] min-h-[180px] max-h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={perfChartWithBm} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="pvGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="hsl(var(--primary))" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis
                    yAxisId="left"
                    orientation="left"
                    tick={{ fontSize: 9 }}
                    tickLine={false}
                    axisLine={false}
                    width={54}
                    tickFormatter={v => fmtCompact(v, currency)}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 9 }}
                    tickLine={false}
                    axisLine={false}
                    width={54}
                    tickFormatter={v => fmtCompact(v, currency)}
                  />
                  <Tooltip content={<HeroChartTooltip currency={currency} />} />
                  <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '6px' }} />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="portfolioValue"
                    name="Portfolio"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#pvGrad)"
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                  {hasBenchmarkLine && (
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="benchmarkValue"
                      name={portfolio.benchmarkConfig?.ticker ?? 'Benchmark'}
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                  )}
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="unrealizedPnL"
                    name="Unrealized P&L"
                    stroke="hsl(142 71% 45%)"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="totalPnL"
                    name="Total P&L"
                    stroke="hsl(217 91% 60%)"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-5 text-center">
            <p className="text-xs text-muted-foreground">
              Not enough snapshots in this period to draw a chart.
            </p>
          </div>
        )}

        {/* ── 3. 6 metric cards ────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3">
          <MetricCard
            title="Portfolio Value"
            value={fmtCurrency(data.currentPortfolioValue, currency)}
            subLabel="Holdings only · excl. cash"
            positive={null}
            tooltip="Current market value of all holdings. Cash balances are excluded."
          />
          <MetricCard
            title="Unrealized P&L"
            value={fmtCurrency(data.unrealizedPnL, currency)}
            subLabel="Open positions"
            positive={data.unrealizedPnL >= 0}
            tooltip="(Current price − avg cost) × shares for all open holdings."
          />
          <MetricCard
            title="Realized P&L"
            value={fmtCurrency(data.realizedPnL, currency)}
            subLabel="From sells in period"
            positive={data.realizedPnL >= 0}
            tooltip="(Sell price − current avg cost) × shares for all sells in the selected period. Uses current average cost as an approximation."
          />
          <MetricCard
            title="Total P&L"
            value={fmtCurrency(data.totalPnL, currency)}
            subLabel="Realized + Unrealized"
            positive={data.totalPnL >= 0}
            tooltip="Sum of realized and unrealized P&L."
          />
          <ReturnCard
            title="TWR"
            returnPct={data.hasSufficientData ? data.twrPct : null}
            subtitle={
              !data.hasSufficientData
                ? 'Need ≥2 snapshots'
                : data.annualizedTwrPct !== null
                  ? `Annualized: ${fmtPct(data.annualizedTwrPct)}`
                  : `${days}d · not annualized`
            }
            tooltip="Time-Weighted Return isolates investment skill from cash flow timing."
          />
          <ReturnCard
            title="MWR (XIRR)"
            returnPct={mwrIsNaN ? null : mwrDisplay}
            subtitle={
              mwrIsNaN
                ? 'Insufficient data'
                : !isNaN(data.mwrAnnualizedPct)
                  ? 'Annualized'
                  : 'Simple ratio'
            }
            tooltip="Money-Weighted Return (XIRR) reflects the timing of your deposits and withdrawals."
          />
        </div>

        {/* TWR/MWR divergence insight */}
        {data.hasSufficientData && !mwrIsNaN && Math.abs(data.twrPct - mwrDisplay) > 0.02 && (
          <div className="rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
            Your MWR is{' '}
            <span className={cn('font-medium', mwrDisplay > data.twrPct ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
              {mwrDisplay > data.twrPct ? 'higher' : 'lower'}
            </span>{' '}
            than TWR — your cash flow timing{' '}
            <span className="font-medium">{mwrDisplay > data.twrPct ? 'helped' : 'hurt'}</span>{' '}
            your returns by{' '}
            <span className="font-medium">{fmtPct(Math.abs(data.twrPct - mwrDisplay))}</span>.
          </div>
        )}

        {/* ── 4. Month-over-month growth ───────────────────────────────────── */}
        {data.momData.length >= 2 && (
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-1">Monthly Growth</h2>
            <p className="text-[10px] text-muted-foreground mb-3">Holdings value · month-over-month %</p>
            <div className="h-[36vw] min-h-[130px] max-h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.momData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <XAxis dataKey="month" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    tickFormatter={v => `${(v * 100).toFixed(0)}%`}
                  />
                  <Tooltip content={<MoMChartTooltip />} />
                  <Bar dataKey="growthPct" radius={[2, 2, 0, 0]}>
                    {data.momData.map((entry, i) => (
                      <Cell
                        key={`cell-${i}`}
                        fill={(entry.growthPct ?? 0) >= 0 ? 'hsl(142 71% 45%)' : 'hsl(0 72% 51%)'}
                        opacity={entry.growthPct === null ? 0.3 : 0.85}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ── 5. Sleeve attribution ────────────────────────────────────────── */}
        {data.sleeveAttribution.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold mb-3">Return by Sleeve</h2>
            <SleeveAttributionSection attribution={data.sleeveAttribution} currency={currency} />
          </div>
        )}

        {/* ── 6. Benchmark comparison ──────────────────────────────────────── */}
        {bm ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Benchmark Comparison</h2>
              <span className="text-[10px] text-muted-foreground">vs {bm.benchmarkTicker}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-muted/50 p-2">
                <p className="text-[10px] text-muted-foreground mb-0.5">Portfolio</p>
                <p className={cn('text-sm font-bold tabular-nums', bm.outperformed ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground')}>
                  {fmtPct(data.twrPct)}
                </p>
              </div>
              <div className="rounded-md bg-muted/50 p-2">
                <p className="text-[10px] text-muted-foreground mb-0.5">{bm.benchmarkTicker}</p>
                <p className="text-sm font-bold tabular-nums">{fmtPct(bm.benchmarkReturnPct)}</p>
              </div>
              <div className={cn('rounded-md p-2', bm.outperformed ? 'bg-emerald-50 dark:bg-emerald-950/40' : 'bg-red-50 dark:bg-red-950/40')}>
                <p className="text-[10px] text-muted-foreground mb-0.5">Alpha</p>
                <p className={cn('text-sm font-bold tabular-nums', bm.outperformed ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                  {fmtPct(bm.alphaPct)}
                </p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground text-center mt-2">
              Prices updated manually · Configure in Settings → Benchmark
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-5 text-center">
            <p className="text-xs text-muted-foreground">
              No benchmark configured.{' '}
              <span className="text-foreground font-medium">Settings → Benchmark</span>{' '}
              to set a ticker and prices.
            </p>
          </div>
        )}

        {/* ── 7. Period summary ────────────────────────────────────────────── */}
        {data.hasSufficientData && (
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3">Period Summary</h2>
            <div className="space-y-2 text-xs">
              {[
                { label: 'Starting total value',  value: fmtCurrency(data.periodSummary.startValue, currency) },
                { label: 'Ending total value',    value: fmtCurrency(data.periodSummary.endValue, currency) },
                { label: 'Total deposits',        value: fmtCurrency(data.periodSummary.totalDeposits, currency) },
                { label: 'Total withdrawals',     value: fmtCurrency(data.periodSummary.totalWithdrawals, currency) },
                { label: 'Operations',            value: String(data.periodSummary.operationCount) },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between items-center">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium tabular-nums">{value}</span>
                </div>
              ))}
              <div className="border-t border-border pt-2 flex justify-between items-center">
                <span className="text-muted-foreground font-medium">Net investment gain</span>
                <span className={cn(
                  'font-semibold tabular-nums',
                  data.periodSummary.netGain >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
                )}>
                  {data.periodSummary.netGain >= 0 ? '+' : ''}
                  {fmtCurrency(data.periodSummary.netGain, currency)}
                </span>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* ── Price Update Dialog ─────────────────────────────────────────────── */}
      {portfolio?.id && (
        <PriceUpdateDialog
          open={priceOpen}
          onOpenChange={setPriceOpen}
          holdings={holdings}
          portfolioId={portfolio.id}
          benchmarkConfig={portfolio.benchmarkConfig}
        />
      )}
    </div>
  )
}
