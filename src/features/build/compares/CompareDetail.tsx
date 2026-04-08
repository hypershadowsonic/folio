import { useState } from 'react'
import { ArrowLeft, Edit2, BarChart2, Trash2 } from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Compare, CompareResult } from '@/types'

interface CompareDetailProps {
  compare: Compare
  onBack: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
}

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

// ─── Build unified chart data ─────────────────────────────────────────────────

type YAxisMode = 'value' | 'return'

function buildChartData(result: CompareResult, mode: YAxisMode) {
  // Collect all dates across all items
  const dateSet = new Set<string>()
  for (const item of result.items) {
    for (const pt of item.result.timeSeries) {
      dateSet.add(new Date(pt.date).toISOString().slice(0, 10))
    }
  }
  const allDates = [...dateSet].sort()

  // Build lookup maps per item
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

// ─── Custom tooltip ───────────────────────────────────────────────────────────

interface TooltipProps {
  active?: boolean
  payload?: { dataKey: string; value: number; stroke: string }[]
  label?: string
  result: CompareResult
  mode: YAxisMode
}

function CompareTooltip({ active, payload, label, result, mode }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null

  const currency = result.alignedParams.dcaCurrency

  // Sort by value descending for rank display
  const sorted = [...payload].sort((a, b) => b.value - a.value)

  return (
    <div className="rounded-lg border bg-background/95 p-2.5 shadow-md text-xs space-y-1.5 min-w-[160px]">
      <p className="font-medium text-foreground">{formatDateTick(label ?? '')}</p>
      <div className="space-y-1">
        {sorted.map((p, rank) => {
          const item = result.items.find((i) => i.refId === p.dataKey)
          if (!item) return null
          return (
            <div key={p.dataKey} className="flex items-center gap-2">
              <span className="text-muted-foreground w-4 shrink-0">#{rank + 1}</span>
              <span
                className="inline-block h-0.5 w-3 rounded shrink-0"
                style={{ background: p.stroke }}
              />
              <span className="flex-1 truncate text-muted-foreground">{item.name}</span>
              <span className="font-medium tabular-nums">
                {mode === 'value'
                  ? formatCurrencyShort(p.value, currency)
                  : fmtPct(p.value)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Metrics table ────────────────────────────────────────────────────────────

interface MetricRow {
  label: string
  values: (number | null)[]
  format: (v: number | null) => string
  /** true = higher is better (green); false = lower is better (green) */
  higherIsBetter: boolean
}

function MetricsTable({ result }: { result: CompareResult }) {
  const currency = result.alignedParams.dcaCurrency
  const items = result.items

  const rows: MetricRow[] = [
    {
      label: 'Total Return',
      values: items.map((i) => i.result.summary.totalReturnPct),
      format: (v) => fmtPct(v),
      higherIsBetter: true,
    },
    {
      label: 'Annualized Return',
      values: items.map((i) => i.result.summary.annualizedReturnPct),
      format: (v) => fmtPct(v),
      higherIsBetter: true,
    },
    {
      label: 'End Value',
      values: items.map((i) => i.result.summary.endValue),
      format: (v) => v != null ? formatCurrency(v, currency) : '—',
      higherIsBetter: true,
    },
    {
      label: 'Total Invested',
      values: items.map((i) => i.result.summary.totalInvested),
      format: (v) => v != null ? formatCurrency(v, currency) : '—',
      higherIsBetter: true,
    },
    {
      label: 'Max Drawdown',
      values: items.map((i) => i.result.summary.maxDrawdownPct),
      format: (v) => fmtPct(v),
      higherIsBetter: false,  // less negative = better
    },
    {
      label: 'Best Period',
      values: items.map((i) => i.result.summary.bestMonthPct),
      format: (v) => fmtPct(v),
      higherIsBetter: true,
    },
    {
      label: 'Worst Period',
      values: items.map((i) => i.result.summary.worstMonthPct),
      format: (v) => fmtPct(v),
      higherIsBetter: false,
    },
  ]

  function isBest(row: MetricRow, idx: number): boolean {
    const vals = row.values.filter((v) => v != null) as number[]
    if (vals.length === 0) return false
    const best = row.higherIsBetter ? Math.max(...vals) : Math.min(...vals)
    return row.values[idx] === best
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2 pr-3 text-muted-foreground font-medium">Metric</th>
            {items.map((item, i) => (
              <th key={item.refId} className="text-right py-2 px-2 min-w-[80px]">
                <span className="flex items-center justify-end gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ background: SERIES_COLORS[i] }}
                  />
                  <span className="truncate max-w-[80px] text-foreground font-medium">{item.name}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b last:border-0">
              <td className="py-2 pr-3 text-muted-foreground">{row.label}</td>
              {row.values.map((val, idx) => (
                <td
                  key={idx}
                  className={cn(
                    'text-right py-2 px-2 tabular-nums',
                    isBest(row, idx) && 'text-green-600 dark:text-green-400 font-semibold',
                  )}
                >
                  {row.format(val)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CompareDetail({ compare, onBack, onEdit, onDelete }: CompareDetailProps) {
  const [yMode, setYMode] = useState<YAxisMode>('value')

  const result = compare.lastCompareResult
  const chartData = result ? buildChartData(result, yMode) : []
  const currency = result?.alignedParams.dcaCurrency ?? 'USD'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b">
        <button onClick={onBack} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{compare.name}</h1>
          <p className="text-xs text-muted-foreground">{compare.items.length} items</p>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Edit2 className="h-3.5 w-3.5 mr-1" />
          Edit
        </Button>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive px-2">
              <Trash2 className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete "{compare.name}"?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">This cannot be undone.</p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button variant="destructive" onClick={onDelete}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!result ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="rounded-full bg-muted p-4">
                <BarChart2 className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No compare results</p>
              <p className="text-xs text-muted-foreground">Edit the compare and run to see results.</p>
              <Button onClick={onEdit} size="sm">Run Compare</Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Y-axis toggle */}
            <div className="flex items-center justify-end gap-1">
              <div className="flex rounded-md border overflow-hidden text-xs">
                {(['value', 'return'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setYMode(mode)}
                    className={cn(
                      'px-3 py-1.5 font-medium transition-colors',
                      yMode === mode
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {mode === 'value' ? 'Value ($)' : 'Return (%)'}
                  </button>
                ))}
              </div>
            </div>

            {/* Chart */}
            <Card>
              <CardContent className="pt-4 pb-2 px-2">
                <ResponsiveContainer width="100%" height={220}>
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
                        yMode === 'value'
                          ? formatCurrencyShort(v, currency)
                          : `${v.toFixed(0)}%`
                      }
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={52}
                    />
                    <Tooltip content={<CompareTooltip result={result} mode={yMode} />} />
                    {result.items.map((item, i) => (
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

                {/* Legend */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 justify-center mt-2 text-xs text-muted-foreground">
                  {result.items.map((item, i) => (
                    <span key={item.refId} className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-0.5 w-4 rounded"
                        style={{ background: SERIES_COLORS[i] }}
                      />
                      {item.name}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Metrics table */}
            <Card>
              <CardContent className="p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">Comparison metrics</p>
                <MetricsTable result={result} />
              </CardContent>
            </Card>

            {/* Aligned params footnote */}
            <p className="text-xs text-muted-foreground text-center pb-2">
              All items aligned to ${result.alignedParams.dcaAmount.toLocaleString()}{' '}
              {result.alignedParams.dcaCurrency} · {result.alignedParams.dcaFrequency}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
