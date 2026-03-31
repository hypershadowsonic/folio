import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Compare } from '@/types'

interface CompareCardProps {
  compare: Compare
  onSelect: () => void
  onFavoriteToggle: () => void
}

function fmtPct(value: number | undefined | null): string {
  if (value == null) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function bestReturn(compare: Compare): number | null {
  const items = compare.lastCompareResult?.items ?? []
  if (items.length === 0) return null
  const returns = items.map((i) => i.result.summary.totalReturnPct)
  return Math.max(...returns)
}

export function CompareCard({ compare, onSelect, onFavoriteToggle }: CompareCardProps) {
  const best = bestReturn(compare)
  const isPositive = (best ?? 0) >= 0
  const n = compare.items.length

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors cursor-pointer"
      onClick={onSelect}
    >
      {/* Name + item count */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm truncate">{compare.name}</p>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">Compare</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{n} item{n !== 1 ? 's' : ''}</p>
      </div>

      {/* Best return */}
      <div className="text-right shrink-0">
        <p className={cn('text-sm font-semibold tabular-nums', best !== null
          ? isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          : 'text-muted-foreground',
        )}>
          {best !== null ? `Best: ${fmtPct(best)}` : '—'}
        </p>
        <p className="text-xs text-muted-foreground">total return</p>
      </div>

      {/* Star */}
      <button
        className="shrink-0 p-1 rounded hover:bg-accent transition-colors"
        onClick={(e) => { e.stopPropagation(); onFavoriteToggle() }}
        aria-label={compare.isFavorite ? 'Unpin favorite' : 'Pin as favorite'}
      >
        <Star
          className={cn(
            'h-4 w-4 transition-colors',
            compare.isFavorite
              ? 'fill-amber-400 text-amber-400'
              : 'text-muted-foreground hover:text-amber-400',
          )}
        />
      </button>
    </div>
  )
}
