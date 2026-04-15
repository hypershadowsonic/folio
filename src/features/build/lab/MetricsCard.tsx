import { cn } from '@/lib/utils'
import type { BacktestResult } from '@/types'

interface MetricsCardProps {
  side: 'A' | 'B'
  result?: BacktestResult
  isStale: boolean
  isRunning: boolean
  displayCurrency: 'USD' | 'TWD'
}

const SIDE_COLORS = {
  A: 'bg-indigo-500',
  B: 'bg-orange-500',
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}%`
}

function fmtCurrency(v: number | null | undefined, currency: 'USD' | 'TWD'): string {
  if (v == null) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(v)
}

export function MetricsCard({ side, result, isStale, isRunning, displayCurrency }: MetricsCardProps) {
  const summary = result?.summary

  const metrics = [
    {
      label: 'Ann. Return',
      value: fmtPct(summary?.annualizedReturnPct),
      positive: (summary?.annualizedReturnPct ?? 0) >= 0,
    },
    {
      label: 'Max DD',
      value: fmtPct(summary?.maxDrawdownPct),
      positive: false,
    },
    {
      label: 'Cost Basis',
      value: fmtCurrency(summary?.totalInvested, displayCurrency),
      positive: null,
    },
    {
      label: 'End Value',
      value: fmtCurrency(summary?.endValue, displayCurrency),
      positive: (summary?.endValue ?? 0) >= (summary?.totalInvested ?? 0),
    },
  ]

  return (
    <div className="rounded-lg border bg-card p-3">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2.5">
        <span className={cn('inline-block h-2.5 w-2.5 rounded-full shrink-0', SIDE_COLORS[side])} />
        <span className="text-xs font-semibold text-foreground">Build {side}</span>
        {isRunning && (
          <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
            Running…
          </span>
        )}
        {!isRunning && isStale && result && (
          <span className="ml-auto text-xs text-amber-600 dark:text-amber-400">
            Parameters changed — re-run
          </span>
        )}
      </div>

      {/* Metrics row */}
      {!result && !isRunning ? (
        <p className="text-xs text-muted-foreground text-center py-1">
          Run backtest to see metrics
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1">
          {metrics.map(({ label, value, positive }) => (
            <div key={label} className="flex flex-col items-center">
              <span className="text-[10px] text-muted-foreground leading-tight">{label}</span>
              <span
                className={cn(
                  'text-xs font-semibold tabular-nums mt-0.5',
                  isStale && 'opacity-40',
                  positive === true && !isStale && 'text-green-600 dark:text-green-400',
                  positive === false && label === 'Max DD' && !isStale && 'text-red-600 dark:text-red-400',
                )}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
