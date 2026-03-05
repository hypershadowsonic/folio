import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Operation, OperationType } from '@/types'

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<OperationType, string> = {
  BUY:                'Buy',
  SELL:               'Sell',
  REBALANCE:          'Rebalance',
  DCA:                'DCA',
  TACTICAL_ROTATION:  'Tactical Rotation',
  DRAWDOWN_DEPLOY:    'Drawdown Deploy',
  DIVIDEND_REINVEST:  'Dividend Reinvest',
  FX_EXCHANGE:        'FX Exchange',
  CASH_DEPOSIT:       'Cash Deposit',
  CASH_WITHDRAWAL:    'Cash Withdrawal',
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'

const TYPE_VARIANT: Record<OperationType, BadgeVariant> = {
  BUY:                'success',
  SELL:               'destructive',
  REBALANCE:          'default',
  DCA:                'success',
  TACTICAL_ROTATION:  'warning',
  DRAWDOWN_DEPLOY:    'warning',
  DIVIDEND_REINVEST:  'success',
  FX_EXCHANGE:        'secondary',
  CASH_DEPOSIT:       'secondary',
  CASH_WITHDRAWAL:    'secondary',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: Date | string) {
  return new Date(d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount)
}

// ─── Component ────────────────────────────────────────────────────────────────

interface OperationCardProps {
  operation: Operation
  compact?: boolean
}

export function OperationCard({ operation, compact = false }: OperationCardProps) {
  const [expanded, setExpanded] = useState(false)

  const { type, timestamp, rationale, tag, entries, cashFlow, fxTransactionId } = operation

  // Summarise what was transacted
  const summary = (() => {
    if (cashFlow) {
      const sign = cashFlow.amount >= 0 ? '+' : ''
      return `${sign}${formatCurrency(Math.abs(cashFlow.amount), cashFlow.currency)}`
    }
    if (entries.length > 0) {
      return entries
        .map(e => `${e.side === 'BUY' ? '+' : '-'}${e.shares} shares @ ${formatCurrency(e.pricePerShare, e.currency)}`)
        .join(', ')
    }
    if (fxTransactionId) return 'FX conversion'
    return '—'
  })()

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground',
        compact ? 'p-3' : 'p-4',
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Badge variant={TYPE_VARIANT[type]}>{TYPE_LABELS[type]}</Badge>
          {tag && (
            <Badge variant="outline" className="text-xs">
              {tag}
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {formatDate(timestamp)}
        </span>
      </div>

      {/* Summary line */}
      <p className={cn('mt-2 font-mono text-sm font-medium', compact ? '' : 'text-base')}>
        {summary}
      </p>

      {/* Rationale — always shown in full mode, truncated in compact */}
      {compact ? (
        <p className="mt-1 text-xs text-muted-foreground truncate">{rationale}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">{rationale}</p>

          {/* Expandable detail */}
          {entries.length > 0 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? 'Hide detail' : 'Show detail'}
            </button>
          )}

          {expanded && entries.length > 0 && (
            <div className="mt-3 space-y-2">
              {entries.map((e, i) => (
                <div key={i} className="rounded-md bg-muted/50 p-2 text-xs">
                  <div className="flex justify-between">
                    <span className="font-medium">{e.side}</span>
                    <span>{e.shares} shares</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>@ {formatCurrency(e.pricePerShare, e.currency)}</span>
                    <span>fee {formatCurrency(e.fees, e.currency)}</span>
                  </div>
                  {e.fxCostBasis && (
                    <div className="mt-1 text-muted-foreground">
                      FX blended rate: {e.fxCostBasis.blendedRate.toFixed(4)} —
                      cost {formatCurrency(e.fxCostBasis.baseCurrencyCost, 'TWD')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
