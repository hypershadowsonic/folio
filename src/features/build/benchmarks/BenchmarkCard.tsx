import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Benchmark } from '@/types'

interface BenchmarkCardProps {
  benchmark: Benchmark
  onSelect: () => void
  onFavoriteToggle: () => void
}

function fmtPct(value: number | undefined | null): string {
  if (value == null) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

export function BenchmarkCard({ benchmark, onSelect, onFavoriteToggle }: BenchmarkCardProps) {
  const s = benchmark.lastBacktestResult?.summary
  const totalReturnPct = s?.totalReturnPct ?? null
  const annualizedReturnPct = s?.annualizedReturnPct ?? null
  const isPositive = (totalReturnPct ?? 0) >= 0

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors cursor-pointer"
      onClick={onSelect}
    >
      {/* Ticker + name */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm text-primary">{benchmark.ticker}</span>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Benchmark</span>
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{benchmark.name}</p>
      </div>

      {/* Return metrics */}
      <div className="text-right shrink-0">
        <p className={cn('text-sm font-semibold tabular-nums', s
          ? isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          : 'text-muted-foreground',
        )}>
          {fmtPct(totalReturnPct)}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {fmtPct(annualizedReturnPct)} /yr
        </p>
      </div>

      {/* Star */}
      <button
        className="shrink-0 p-1 rounded hover:bg-accent transition-colors"
        onClick={(e) => { e.stopPropagation(); onFavoriteToggle() }}
        aria-label={benchmark.isFavorite ? 'Unpin favorite' : 'Pin as favorite'}
      >
        <Star
          className={cn(
            'h-4 w-4 transition-colors',
            benchmark.isFavorite
              ? 'fill-amber-400 text-amber-400'
              : 'text-muted-foreground hover:text-amber-400',
          )}
        />
      </button>
    </div>
  )
}
