import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import { BarChart2, AlertTriangle } from 'lucide-react'
import type { BacktestResult, BacktestDataPoint } from '@/types'

interface LabChartProps {
  resultA?: BacktestResult
  resultB?: BacktestResult
  benchmarkResult?: BacktestResult | null
  isAStale: boolean
  isBStale: boolean
  displayCurrency: 'USD' | 'TWD'
}

const COLOR_A = '#6366f1'     // indigo
const COLOR_B = '#f97316'     // orange
const COLOR_BM = '#94a3b8'    // slate (benchmark)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTick(dateVal: string | Date): string {
  const d = new Date(dateVal)
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}

function fmtPct(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function fmtCurrencyShort(value: number, currency: 'USD' | 'TWD'): string {
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

/** Build the merged Recharts dataset from up to 3 series. */
function buildLabChartData(
  resultA?: BacktestResult,
  resultB?: BacktestResult,
  benchmarkResult?: BacktestResult | null,
) {
  const dateSet = new Set<string>()
  const addSeries = (ts: BacktestDataPoint[]) => {
    for (const pt of ts) {
      dateSet.add(new Date(pt.date).toISOString().slice(0, 10))
    }
  }
  if (resultA) addSeries(resultA.timeSeries)
  if (resultB) addSeries(resultB.timeSeries)
  if (benchmarkResult) addSeries(benchmarkResult.timeSeries)

  const allDates = [...dateSet].sort()
  if (allDates.length === 0) return []

  // Build lookup: series id → (date → totalReturnPct)
  const buildLookup = (result: BacktestResult) => {
    const map = new Map<string, number>()
    for (const pt of result.timeSeries) {
      const d = new Date(pt.date).toISOString().slice(0, 10)
      map.set(d, pt.totalReturnPct)
    }
    return map
  }
  const lookupA = resultA ? buildLookup(resultA) : null
  const lookupB = resultB ? buildLookup(resultB) : null
  const lookupBM = benchmarkResult ? buildLookup(benchmarkResult) : null

  return allDates.map((date) => {
    const entry: Record<string, string | number> = { date }
    if (lookupA) { const v = lookupA.get(date); if (v !== undefined) entry['a'] = v }
    if (lookupB) { const v = lookupB.get(date); if (v !== undefined) entry['b'] = v }
    if (lookupBM) { const v = lookupBM.get(date); if (v !== undefined) entry['bm'] = v }
    return entry
  })
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

interface TooltipProps {
  active?: boolean
  payload?: { dataKey: string; value: number; stroke: string }[]
  label?: string
  displayCurrency: 'USD' | 'TWD'
  resultA?: BacktestResult
  resultB?: BacktestResult
  benchmarkResult?: BacktestResult | null
}

function LabTooltip({ active, payload, label, displayCurrency, resultA, resultB, benchmarkResult }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null

  const sorted = [...payload].sort((a, b) => b.value - a.value)

  const nameFor = (key: string) => {
    if (key === 'a') return resultA ? (resultA.params as { name?: string }).name || 'Build A' : 'Build A'
    if (key === 'b') return resultB ? (resultB.params as { name?: string }).name || 'Build B' : 'Build B'
    return benchmarkResult ? 'Benchmark' : 'Benchmark'
  }

  // Calculate portfolio value at this date
  const valueFor = (key: string, pct: number): string => {
    const result = key === 'a' ? resultA : key === 'b' ? resultB : benchmarkResult
    if (!result) return ''
    const invested = result.summary.totalInvested
    const approxValue = invested * (1 + pct / 100)
    return fmtCurrencyShort(approxValue, displayCurrency)
  }

  return (
    <div className="rounded-lg border bg-background/95 p-2.5 shadow-md text-xs space-y-1.5 min-w-[160px]">
      <p className="font-medium text-foreground">{formatDateTick(label ?? '')}</p>
      <div className="space-y-1">
        {sorted.map((p, rank) => (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span className="text-muted-foreground w-4 shrink-0">#{rank + 1}</span>
            <span
              className="inline-block h-0.5 w-3 rounded shrink-0"
              style={{ background: p.stroke }}
            />
            <span className="flex-1 truncate text-muted-foreground">{nameFor(p.dataKey)}</span>
            <span className="font-medium tabular-nums">
              {fmtPct(p.value)}
              <span className="ml-1 text-muted-foreground">{valueFor(p.dataKey, p.value)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Different start date warning ─────────────────────────────────────────────

function dateDiffMonths(a: string, b: string): number {
  const da = new Date(a)
  const db = new Date(b)
  return Math.abs(
    (da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth()),
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LabChart({
  resultA,
  resultB,
  benchmarkResult,
  isAStale,
  isBStale,
  displayCurrency,
}: LabChartProps) {
  const chartData = buildLabChartData(resultA, resultB, benchmarkResult)
  const hasData = chartData.length > 0

  // Check for different start dates warning
  let diffStartWarning = false
  if (resultA && resultB) {
    const startA = new Date(resultA.params.startDate).toISOString().slice(0, 10)
    const startB = new Date(resultB.params.startDate).toISOString().slice(0, 10)
    diffStartWarning = dateDiffMonths(startA, startB) > 6
  }

  return (
    <Card>
      <CardContent className="pt-4 pb-2 px-2">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <div className="rounded-full bg-muted p-3">
              <BarChart2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">Configure and run a backtest to see results</p>
          </div>
        ) : (
          <>
            {diffStartWarning && (
              <div className="flex items-center gap-1.5 mb-2 px-1 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Different start dates — results reflect different market conditions
              </div>
            )}

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
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip
                  content={
                    <LabTooltip
                      displayCurrency={displayCurrency}
                      resultA={resultA}
                      resultB={resultB}
                      benchmarkResult={benchmarkResult}
                    />
                  }
                />

                {resultA && (
                  <Line
                    type="monotone"
                    dataKey="a"
                    stroke={COLOR_A}
                    strokeWidth={isAStale ? 1.5 : 2}
                    strokeDasharray={isAStale ? '5 4' : undefined}
                    strokeOpacity={isAStale ? 0.5 : 1}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls
                  />
                )}
                {resultB && (
                  <Line
                    type="monotone"
                    dataKey="b"
                    stroke={COLOR_B}
                    strokeWidth={isBStale ? 1.5 : 2}
                    strokeDasharray={isBStale ? '5 4' : undefined}
                    strokeOpacity={isBStale ? 0.5 : 1}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls
                  />
                )}
                {benchmarkResult && (
                  <Line
                    type="monotone"
                    dataKey="bm"
                    stroke={COLOR_BM}
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    dot={false}
                    activeDot={{ r: 3 }}
                    connectNulls
                  />
                )}
              </LineChart>
            </ResponsiveContainer>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 justify-center mt-2 text-xs text-muted-foreground">
              {resultA && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-4 rounded" style={{ background: COLOR_A }} />
                  Build A{isAStale && ' (stale)'}
                </span>
              )}
              {resultB && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-4 rounded" style={{ background: COLOR_B }} />
                  Build B{isBStale && ' (stale)'}
                </span>
              )}
              {benchmarkResult && (
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-px w-4"
                    style={{ background: COLOR_BM, borderTop: '1.5px dashed #94a3b8' }}
                  />
                  Benchmark
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
