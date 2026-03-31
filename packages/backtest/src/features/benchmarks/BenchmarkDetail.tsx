import { Fragment, useState } from 'react'
import { ArrowLeft, Edit2, BarChart2, Trash2 } from 'lucide-react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Benchmark, BacktestDataPoint } from '@/types'

interface BenchmarkDetailProps {
  benchmark: Benchmark
  onBack: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
}

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

function fmtPct(value: number | null, decimals = 1): string {
  if (value === null) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

interface ChartPayloadItem { dataKey: string; value: number }
interface TooltipProps {
  active?: boolean
  payload?: ChartPayloadItem[]
  label?: string
  currency: 'USD' | 'TWD'
}

function CustomTooltip({ active, payload, label, currency }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const portfolioVal = payload.find((p) => p.dataKey === 'portfolioValue')?.value ?? 0
  const costVal = payload.find((p) => p.dataKey === 'costBasis')?.value ?? 0
  const returnPct = costVal > 0 ? ((portfolioVal / costVal) - 1) * 100 : 0
  return (
    <div className="rounded-lg border bg-background/95 p-2.5 shadow-md text-xs space-y-1">
      <p className="font-medium text-foreground">{formatDateTick(label ?? '')}</p>
      <div className="space-y-0.5">
        <div className="flex gap-3 justify-between">
          <span className="text-muted-foreground">Portfolio:</span>
          <span className="font-medium">{formatCurrency(portfolioVal, currency)}</span>
        </div>
        <div className="flex gap-3 justify-between">
          <span className="text-muted-foreground">Invested:</span>
          <span>{formatCurrency(costVal, currency)}</span>
        </div>
        <div className="flex gap-3 justify-between">
          <span className="text-muted-foreground">Return:</span>
          <span className={cn(returnPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
            {fmtPct(returnPct)}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Metric card ──────────────────────────────────────────────────────────────

function MetricCard({ label, value, valueClass, sub }: {
  label: string; value: string; valueClass?: string; sub?: string
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn('text-base font-semibold mt-0.5', valueClass)}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BenchmarkDetail({ benchmark, onBack, onEdit, onDelete }: BenchmarkDetailProps) {
  const result = benchmark.lastBacktestResult
  const [dcaVisible, setDcaVisible] = useState(50)
  const chartData = result?.timeSeries.map((pt: BacktestDataPoint) => ({
    date: new Date(pt.date).toISOString().slice(0, 10),
    portfolioValue: pt.portfolioValue,
    costBasis: pt.costBasis,
  })) ?? []

  const s = result?.summary
  const currency = benchmark.currency

  const lastPoint = result && result.timeSeries.length > 0
    ? result.timeSeries[result.timeSeries.length - 1]
    : null

  const dcaRows = result
    ? result.timeSeries.map((pt, i) => {
        const prev = i > 0 ? result.timeSeries[i - 1] : null
        const trades = pt.holdings
          .map((h) => {
            const prevShares = prev?.holdings.find((ph) => ph.ticker === h.ticker)?.shares ?? 0
            const deltaShares = h.shares - prevShares
            const price = h.shares > 0 ? h.value / h.shares : 0
            return {
              ticker: h.ticker,
              deltaShares,
              deltaValue: deltaShares * price,
              noData: h.shares === 0 && prevShares === 0 && h.driftFromTarget < -1e-9,
            }
          })
          .filter((t) => Math.abs(t.deltaShares) > 1e-9 || t.noData)
        return {
          dateStr: new Date(pt.date).toISOString().slice(0, 10),
          invested: i === 0 ? pt.costBasis : pt.costBasis - result.timeSeries[i - 1].costBasis,
          portfolioValue: pt.portfolioValue,
          totalReturnPct: pt.totalReturnPct,
          rebalanceTriggered: pt.rebalanceTriggered,
          trades,
        }
      })
    : []

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b">
        <button onClick={onBack} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{benchmark.ticker}</h1>
          <p className="text-xs text-muted-foreground truncate">{benchmark.name}</p>
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
              <DialogTitle>Delete "{benchmark.name}"?</DialogTitle>
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
              <p className="text-sm font-medium">No backtest results</p>
              <p className="text-xs text-muted-foreground">Edit the benchmark and run to see results.</p>
              <Button onClick={onEdit} size="sm">Run Benchmark</Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Chart */}
            <Card>
              <CardContent className="pt-4 pb-2 px-2">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="bmPortfolioGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tickFormatter={formatDateTick} interval="preserveStartEnd"
                      tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis tickFormatter={(v: number) => formatCurrencyShort(v, currency)}
                      tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={52} />
                    <Tooltip content={<CustomTooltip currency={currency} />} />
                    <Area type="monotone" dataKey="portfolioValue" stroke="hsl(var(--primary))"
                      strokeWidth={2} fill="url(#bmPortfolioGrad)" dot={false} activeDot={{ r: 4 }} />
                    <Area type="monotone" dataKey="costBasis" stroke="hsl(var(--muted-foreground))"
                      strokeWidth={1.5} strokeDasharray="4 2" fill="none" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
                <div className="flex items-center gap-4 justify-center mt-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-4 bg-primary rounded" />
                    Portfolio value
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-4 border-t border-dashed border-muted-foreground" />
                    Cost basis
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Summary metrics */}
            <div className="grid grid-cols-2 gap-3">
              <MetricCard label="Total Return" value={fmtPct(s?.totalReturnPct ?? null)}
                valueClass={(s?.totalReturnPct ?? 0) >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'}
                sub={s ? `${formatCurrency(s.totalReturn, currency)} absolute` : undefined} />
              <MetricCard label="Annualized Return" value={fmtPct(s?.annualizedReturnPct ?? null)}
                valueClass={(s?.annualizedReturnPct ?? 0) >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'} />
              <MetricCard label="End Value" value={s ? formatCurrency(s.endValue, currency) : '—'} />
              <MetricCard label="Total Invested" value={s ? formatCurrency(s.totalInvested, currency) : '—'} />
              <MetricCard label="Max Drawdown" value={fmtPct(s?.maxDrawdownPct ?? null)}
                valueClass="text-red-600 dark:text-red-400" />
              <MetricCard label="Best / Worst Period"
                value={s ? `${fmtPct(s.bestMonthPct)} / ${fmtPct(s.worstMonthPct)}` : '—'} />
            </div>

            {/* YoY / MoM */}
            {(s?.yoyGrowthPct !== null || s?.momGrowthPct !== null) && (
              <div className="grid grid-cols-2 gap-3">
                {s?.yoyGrowthPct !== null && (
                  <MetricCard label="Year-over-Year" value={fmtPct(s.yoyGrowthPct)}
                    valueClass={(s.yoyGrowthPct ?? 0) >= 0
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'} />
                )}
                {s?.momGrowthPct !== null && (
                  <MetricCard label="Month-over-Month" value={fmtPct(s.momGrowthPct)}
                    valueClass={(s.momGrowthPct ?? 0) >= 0
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'} />
                )}
              </div>
            )}

            {/* Holdings */}
            {lastPoint && (
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Holdings</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-1.5 pr-2 text-muted-foreground font-medium">Ticker</th>
                          <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Shares</th>
                          <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Value</th>
                          <th className="text-right py-1.5 pl-2 text-muted-foreground font-medium">Cost (est.)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lastPoint.holdings.filter((h) => h.shares > 0).map((h) => {
                          const estCost = (s?.totalInvested ?? 0) * h.allocationPct / 100
                          return (
                            <tr key={h.ticker} className="border-b last:border-0">
                              <td className="py-1.5 pr-2 font-medium">{h.ticker}</td>
                              <td className="py-1.5 px-2 text-right tabular-nums">{h.shares.toFixed(4)}</td>
                              <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(h.value, currency)}</td>
                              <td className="py-1.5 pl-2 text-right tabular-nums text-muted-foreground">{formatCurrency(estCost, currency)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* DCA History */}
            {dcaRows.length > 0 && (
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">DCA History</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-1.5 pr-2 text-muted-foreground font-medium">Date</th>
                          <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Invested</th>
                          <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Portfolio</th>
                          <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Return</th>
                          <th className="text-right py-1.5 pl-2 text-muted-foreground font-medium">Rebal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dcaRows.slice(0, dcaVisible).map((row, i) => (
                          <Fragment key={i}>
                            <tr className={row.trades.length > 0 ? '' : 'border-b last:border-0'}>
                              <td className="pt-1.5 pb-0.5 pr-2">{row.dateStr}</td>
                              <td className="pt-1.5 pb-0.5 px-2 text-right tabular-nums">{formatCurrency(row.invested, currency)}</td>
                              <td className="pt-1.5 pb-0.5 px-2 text-right tabular-nums">{formatCurrency(row.portfolioValue, currency)}</td>
                              <td className={cn('pt-1.5 pb-0.5 px-2 text-right tabular-nums', row.totalReturnPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
                                {fmtPct(row.totalReturnPct)}
                              </td>
                              <td className="pt-1.5 pb-0.5 pl-2 text-right text-muted-foreground">
                                {row.rebalanceTriggered ? '↺' : '—'}
                              </td>
                            </tr>
                            {row.trades.length > 0 && (
                              <tr className="border-b last:border-0">
                                <td colSpan={5} className="pb-1.5 pr-2">
                                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground pl-0.5">
                                    {row.trades.map((t) => (
                                      <span key={t.ticker} className="flex items-center gap-1">
                                        <span className="font-medium text-foreground">{t.ticker}</span>
                                        {t.noData ? (
                                          <span className="text-[10px] text-muted-foreground/50">no price</span>
                                        ) : (
                                          <>
                                            <span className={t.deltaShares >= 0 ? '' : 'text-red-500 dark:text-red-400'}>
                                              {t.deltaShares >= 0 ? '+' : ''}{t.deltaShares.toFixed(4)} sh
                                            </span>
                                            <span className="text-muted-foreground/70">
                                              (~{formatCurrencyShort(t.deltaValue, currency)})
                                            </span>
                                          </>
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {dcaVisible < dcaRows.length && (
                    <button
                      className="mt-2 w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                      onClick={() => setDcaVisible((v) => v + 50)}
                    >
                      Load 50 more ({dcaRows.length - dcaVisible} remaining)
                    </button>
                  )}
                </CardContent>
              </Card>
            )}

            <p className="text-sm text-muted-foreground text-center pb-2">
              {benchmark.ticker} · monthly $1,000 USD
            </p>
          </>
        )}
      </div>
    </div>
  )
}
