import { Star } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Build } from '@/types'

interface BuildCardProps {
  build: Build
  onSelect: () => void
  onFavoriteToggle: () => void
}

export function BuildCard({ build, onSelect, onFavoriteToggle }: BuildCardProps) {
  const result = build.lastBacktestResult
  const totalReturnPct = result?.summary.totalReturnPct ?? null
  const annualizedReturnPct = result?.summary.annualizedReturnPct ?? null

  return (
    <Card
      className="cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={onSelect}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="font-semibold truncate">{build.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {build.holdings.length} holding{build.holdings.length !== 1 ? 's' : ''} ·{' '}
              {build.dcaFrequency} ${build.dcaAmount.toLocaleString()} {build.dcaCurrency}
            </p>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onFavoriteToggle()
            }}
            className="shrink-0 p-1 rounded hover:bg-accent transition-colors"
            aria-label={build.isFavorite ? 'Unpin favorite' : 'Set as favorite'}
          >
            <Star
              className={cn(
                'h-4 w-4 transition-colors',
                build.isFavorite
                  ? 'text-amber-400 fill-amber-400'
                  : 'text-muted-foreground',
              )}
            />
          </button>
        </div>

        {totalReturnPct !== null ? (
          <div className="flex gap-3 mt-2">
            <span
              className={cn(
                'text-sm font-medium',
                totalReturnPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
              )}
            >
              {totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(1)}% total
            </span>
            <span
              className={cn(
                'text-sm font-medium',
                annualizedReturnPct !== null && annualizedReturnPct >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400',
              )}
            >
              {annualizedReturnPct !== null
                ? `${annualizedReturnPct >= 0 ? '+' : ''}${annualizedReturnPct.toFixed(1)}% ann.`
                : '—'}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground mt-2">Not yet run</p>
        )}
      </CardContent>
    </Card>
  )
}
