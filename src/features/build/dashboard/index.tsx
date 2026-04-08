import { useState } from 'react'
import { Star, ArrowRight } from 'lucide-react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useFavorite } from '@/db/buildHooks'
import { useUIStore } from '@/stores/uiStore'
import type { BacktestResult, CompareResult } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const SERIES_COLORS = ['#6366f1', '#f97316', '#22c55e', '#a855f7']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(value: number, currency: 'USD' | 'TWD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value)
}

function formatCurrencyShort(value: number, currency: 'USD' | 'TWD'): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (currency === 'TWD') {
    if (abs >= 1_000_000) return `${sign}NT$${(abs / 1_000_000).toFixed(1)}M`
    if (abs >= 1_000) return `${sign}NT$${(abs / 1_000).toFixed(0)}K`
    return `${sign}NT$${abs.toFixed(0)}`
  }
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function formatDateTick(dateVal: string | Date): string {
  const d = new Date(dateVal)
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}

function fmtPct(value: number | null | undefined, decimals = 1): string {
  if (value == null) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

// ─── Chart data builders ──────────────────────────────────────────────────────

function buildSingleChartData(result: BacktestResult) {
  return result.timeSeries.map((pt) => ({
    date: new Date(pt.date).toISOString().slice(0, 10),
    portfolioValue: pt.portfolioValue,
    costBasis: pt.costBasis,
  }))
}

type YAxisMode = 'value' | 'return'

function buildCompareChartData(result: CompareResult, mode: YAxisMode) {
  const dateSet = new Set<string>()
  for (const item of result.items) {
    for (const pt of item.result.timeSeries) {
      dateSet.add(new Date(pt.date).toISOString().slice(0, 10))
    }
  }
  const allDates = [...dateSet].sort()

  const lookup: Map<string, Map<string, number>> = new Map()
  for (const item of result.items) {
    const map = new Map<string, number>()
    for (const pt of item.result.timeSeries) {
      const dateStr = new Date(pt.date).toISOString().slice(0, 10)
      map.set(dateStr, mode === 'value' ? pt.portfolioValue : pt.totalReturnPct)
    }
    lookup.set(item.refId, map)
  }

  return allDates.map((date) => {
    const entry: Record<string, string | number> = { date }
    for (const item of result.items) {
      const val = lookup.get(item.refId)?.get(date)
      if (val !== undefined) entry[item.refId] = val
    }
    return entry
  })
}

// ─── Metric card ──────────────────────────────────────────────────────────────

function MetricCard({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <Card>
      <CardContent className="p-3 text-center">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={cn('text-base font-semibold mt-0.5 tabular-nums', valueClass)}>{value}</p>
      </CardContent>
    </Card>
  )
}

// ─── Single tooltip (Build/Benchmark) ────────────────────────────────────────

function SingleTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean
  payload?: { dataKey: string; value: number }[]
  label?: string
  currency: 'USD' | 'TWD'
}) {
  if (!active || !payload || payload.length === 0) return null
  const pv = payload.find((p) => p.dataKey === 'portfolioValue')?.value ?? 0
  const cb = payload.find((p) => p.dataKey === 'costBasis')?.value ?? 0
  const ret = cb > 0 ? ((pv / cb) - 1) * 100 : 0
  return (
    <div className="rounded-lg border bg-background/95 p-2.5 shadow-md text-xs space-y-0.5">
      <p className="font-medium">{formatDateTick(label ?? '')}</p>
      <div className="flex justify-between gap-3">
        <span className="text-muted-foreground">Portfolio</span>
        <span className="font-medium">{formatCurrency(pv, currency)}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-muted-foreground">Return</span>
        <span className={ret >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
          {fmtPct(ret)}
        </span>
      </div>
    </div>
  )
}

// ─── Compare tooltip ──────────────────────────────────────────────────────────

function CompareTooltip({
  active,
  payload,
  label,
  result,
  mode,
}: {
  active?: boolean
  payload?: { dataKey: string; value: number; stroke: string }[]
  label?: string
  result: CompareResult
  mode: YAxisMode
}) {
  if (!active || !payload || payload.length === 0) return null
  const currency = result.alignedParams.dcaCurrency
  const sorted = [...payload].sort((a, b) => b.value - a.value)
  return (
    <div className="rounded-lg border bg-background/95 p-2.5 shadow-md text-xs space-y-1 min-w-[140px]">
      <p className="font-medium">{formatDateTick(label ?? '')}</p>
      {sorted.map((p, rank) => {
        const item = result.items.find((i) => i.refId === p.dataKey)
        if (!item) return null
        return (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span className="text-muted-foreground w-4 shrink-0">#{rank + 1}</span>
            <span className="inline-block h-0.5 w-3 rounded shrink-0" style={{ background: p.stroke }} />
            <span className="flex-1 truncate text-muted-foreground">{item.name}</span>
            <span className="font-medium tabular-nums">
              {mode === 'value' ? formatCurrencyShort(p.value, currency) : fmtPct(p.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Compare metrics table ────────────────────────────────────────────────────

function CompareMetrics({ result }: { result: CompareResult }) {
  const currency = result.alignedParams.dcaCurrency
  const items = result.items

  const rows = [
    {
      label: 'Total Return',
      values: items.map((i) => i.result.summary.totalReturnPct),
      fmt: (v: number | null) => fmtPct(v),
      higher: true,
    },
    {
      label: 'End Value',
      values: items.map((i) => i.result.summary.endValue),
      fmt: (v: number | null) => (v != null ? formatCurrency(v, currency) : '—'),
      higher: true,
    },
    {
      label: 'Max Drawdown',
      values: items.map((i) => i.result.summary.maxDrawdownPct),
      fmt: (v: number | null) => fmtPct(v),
      higher: false,
    },
  ]

  function isBest(values: (number | null)[], idx: number, higher: boolean): boolean {
    const valid = values.filter((v) => v != null) as number[]
    if (valid.length === 0) return false
    const best = higher ? Math.max(...valid) : Math.min(...valid)
    return values[idx] === best
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="text-left py-1.5 pr-3 text-muted-foreground font-medium">Metric</th>
            {items.map((item, i) => (
              <th key={item.refId} className="text-right py-1.5 px-2 min-w-[72px]">
                <span className="flex items-center justify-end gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ background: SERIES_COLORS[i] }} />
                  <span className="truncate max-w-[72px] text-foreground font-medium">{item.name}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b last:border-0">
              <td className="py-1.5 pr-3 text-muted-foreground">{row.label}</td>
              {row.values.map((val, idx) => (
                <td
                  key={idx}
                  className={cn(
                    'text-right py-1.5 px-2 tabular-nums',
                    isBest(row.values, idx, row.higher) && 'text-green-600 dark:text-green-400 font-semibold',
                  )}
                >
                  {row.fmt(val)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Shared header ────────────────────────────────────────────────────────────

function Header({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Your favorite backtest at a glance</p>
      </div>
      <Button variant="outline" size="sm" onClick={onOpen} className="shrink-0">
        Open
        <ArrowRight className="h-3.5 w-3.5 ml-1" />
      </Button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function Dashboard() {
  const [compareMode, setCompareMode] = useState<YAxisMode>('value')

  const favorite = useFavorite()
  const displayCurrency = useUIStore((s) => s.buildDisplayCurrency)
  const setBuildTab = useUIStore((s) => s.setBuildTab)

  function handleOpen() {
    if (!favorite) return
    setBuildTab('builds')
  }

  // ─── No favorite ─────────────────────────────────────────────────────────────

  if (!favorite) {
    return (
      <div className="p-4 space-y-4">
        <div>
          <h1 className="text-xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Your favorite backtest at a glance</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <div className="rounded-full bg-muted p-4">
              <Star className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No favorite set</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Pin a Build, Benchmark, or Compare as your Favorite from the Builds tab to see it here.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ─── Favorite is Build or Benchmark ──────────────────────────────────────────

  if (favorite.type === 'build' || favorite.type === 'benchmark') {
    const item = favorite.item
    const result = item.lastBacktestResult
    const currency = result?.params.dcaCurrency ?? displayCurrency
    const chartData = result ? buildSingleChartData(result) : []
    const summary = result?.summary
    const typeLabel = favorite.type === 'build' ? 'Build' : 'Benchmark'
    const itemName = favorite.type === 'build'
      ? (favorite.item as import('@/types').Build).name
      : `${(favorite.item as import('@/types').Benchmark).ticker} — ${favorite.item.name}`

    return (
      <div className="p-4 space-y-4">
        <Header onOpen={handleOpen} />

        <div className="flex items-center gap-2">
          <p className="font-semibold text-sm truncate">{itemName}</p>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">{typeLabel}</span>
        </div>

        {chartData.length > 0 ? (
          <Card>
            <CardContent className="pt-4 pb-2 px-2">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="dash-pv-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDateTick}
                    interval="preserveStartEnd"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={(v: number) => formatCurrencyShort(v, currency)}
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={52}
                  />
                  <Tooltip content={<SingleTooltip currency={currency} />} />
                  <Area
                    type="monotone"
                    dataKey="costBasis"
                    stroke="hsl(var(--muted-foreground))"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    fill="none"
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="portfolioValue"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#dash-pv-grad)"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-xs text-muted-foreground">
              No backtest data yet. Run a backtest from the Builds tab.
            </CardContent>
          </Card>
        )}

        {summary && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <MetricCard
                label="YoY"
                value={fmtPct(summary.yoyGrowthPct)}
                valueClass={summary.yoyGrowthPct != null
                  ? summary.yoyGrowthPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                  : undefined}
              />
              <MetricCard
                label="MoM"
                value={fmtPct(summary.momGrowthPct)}
                valueClass={summary.momGrowthPct != null
                  ? summary.momGrowthPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                  : undefined}
              />
              <MetricCard
                label="Overall"
                value={fmtPct(summary.totalReturnPct)}
                valueClass={summary.totalReturnPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <MetricCard label="End Value" value={formatCurrency(summary.endValue, currency)} />
              <MetricCard label="Total Invested" value={formatCurrency(summary.totalInvested, currency)} />
            </div>
          </>
        )}
      </div>
    )
  }

  // ─── Favorite is Compare ──────────────────────────────────────────────────────

  const compare = favorite.item
  const compareResult = compare.lastCompareResult
  const currency = compareResult?.alignedParams.dcaCurrency ?? displayCurrency
  const chartData = compareResult ? buildCompareChartData(compareResult, compareMode) : []

  return (
    <div className="p-4 space-y-4">
      <Header onOpen={handleOpen} />

      <div className="flex items-center gap-2">
        <p className="font-semibold text-sm truncate">{compare.name}</p>
        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">Compare</span>
      </div>

      {compareResult && chartData.length > 0 ? (
        <>
          <div className="flex items-center justify-end">
            <div className="flex rounded-md border overflow-hidden text-xs">
              {(['value', 'return'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setCompareMode(mode)}
                  className={cn(
                    'px-3 py-1.5 font-medium transition-colors',
                    compareMode === mode
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent',
                  )}
                >
                  {mode === 'value' ? 'Value ($)' : 'Return (%)'}
                </button>
              ))}
            </div>
          </div>

          <Card>
            <CardContent className="pt-4 pb-2 px-2">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDateTick}
                    interval="preserveStartEnd"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={(v: number) =>
                      compareMode === 'value' ? formatCurrencyShort(v, currency) : `${v.toFixed(0)}%`
                    }
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={52}
                  />
                  <Tooltip content={<CompareTooltip result={compareResult} mode={compareMode} />} />
                  {compareResult.items.map((item, i) => (
                    <Line
                      key={item.refId}
                      type="monotone"
                      dataKey={item.refId}
                      stroke={SERIES_COLORS[i] ?? '#888'}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 justify-center mt-2 text-xs text-muted-foreground">
                {compareResult.items.map((item, i) => (
                  <span key={item.refId} className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-4 rounded" style={{ background: SERIES_COLORS[i] }} />
                    {item.name}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Comparison metrics</p>
              <CompareMetrics result={compareResult} />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-xs text-muted-foreground">
            No compare results yet. Run the compare from the Builds tab.
          </CardContent>
        </Card>
      )}
    </div>
  )
}
