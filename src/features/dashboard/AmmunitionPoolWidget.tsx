/**
 * AmmunitionPoolWidget.tsx
 *
 * Compact dashboard card displaying the two-tier ammunition pool status.
 * Self-contained: uses useLiveQuery for all data loading.
 *
 * Shows:
 *  - Current drawdown from all-time high
 *  - Per-tier gauge (proximity to deploy trigger), status badge, and current value
 *  - "Not configured" prompt when no pool record exists in DB
 */

import { useLiveQuery } from 'dexie-react-hooks'
import { CheckCircle2, Shield, ArrowRight } from 'lucide-react'
import { db } from '@/db/database'
import { resolveCurrentFxRate } from '@/db/snapshotService'
import { calculateCurrentAllocations } from '@/engine/rebalance'
import { calculateAmmunitionStatus } from '@/engine/ammunition'
import type { AmmunitionTier, AmmunitionPoolStatus } from '@/engine/ammunition'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtTWD(v: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'TWD',
    maximumFractionDigits: 0,
  }).format(v)
}

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_BADGE: Record<AmmunitionTier['status'], { label: string; variant: 'secondary' | 'warning' | 'default' | 'destructive' }> = {
  standby:   { label: 'Standby',   variant: 'secondary'   },
  ready:     { label: 'Ready',     variant: 'warning'     },
  deploying: { label: 'Deploying', variant: 'default'     },
  depleted:  { label: 'Depleted',  variant: 'destructive' },
}

const STATUS_BAR_COLOR: Record<AmmunitionTier['status'], string> = {
  standby:   'bg-muted-foreground/40',
  ready:     'bg-amber-500',
  deploying: 'bg-blue-500',
  depleted:  'bg-red-400',
}

// ─── TierRow ─────────────────────────────────────────────────────────────────

function TierRow({
  tier,
  proximity,
}: {
  tier: AmmunitionTier
  proximity: number
}) {
  const isConfigured = tier.holdingId !== null
  const { label, variant } = STATUS_BADGE[tier.status]
  const fillPct = Math.min(proximity, 100)

  return (
    <div className="space-y-1.5">
      {/* Header: label + ticker + value + badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium shrink-0">{tier.label}</span>
          {tier.holdingTicker && (
            <span className="text-[11px] text-muted-foreground shrink-0">· {tier.holdingTicker}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isConfigured && tier.currentValueBase > 0 && (
            <span className="tabular-nums text-xs font-medium">
              {fmtTWD(tier.currentValueBase)}
            </span>
          )}
          <Badge variant={variant} className="text-[10px] px-1 py-0">
            {label}
          </Badge>
        </div>
      </div>

      {/* Gauge + caption */}
      {isConfigured ? (
        <>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all duration-300', STATUS_BAR_COLOR[tier.status])}
              style={{ width: `${fillPct}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {tier.status === 'ready' && (
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                ACTIVE — drawdown reached trigger ({tier.deployTriggerPct}%)
              </span>
            )}
            {tier.status === 'deploying' && (
              <span className="text-blue-600 dark:text-blue-400 font-medium">
                Deploying — reserve partially used
              </span>
            )}
            {tier.status === 'depleted' && (
              <span className="text-red-500 dark:text-red-400 font-medium">Fully deployed</span>
            )}
            {tier.status === 'standby' && (
              <>
                Deploys at {tier.deployTriggerPct}% drawdown
                {proximity > 0 && (
                  <span className="ml-1">· {proximity.toFixed(0)}% of the way there</span>
                )}
              </>
            )}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">Not configured</p>
      )}
    </div>
  )
}

// ─── useAmmunitionStatus ──────────────────────────────────────────────────────

function useAmmunitionStatus(portfolioId: string | undefined): AmmunitionPoolStatus | null | undefined {
  return useLiveQuery(async () => {
    if (!portfolioId) return null

    const [holdings, cashAccounts, ammoPool] = await Promise.all([
      db.holdings.where('portfolioId').equals(portfolioId).toArray(),
      db.cashAccounts.where('portfolioId').equals(portfolioId).toArray(),
      db.ammunitionPools.get(portfolioId),
    ])

    if (!ammoPool) return null

    const fxRate = await resolveCurrentFxRate(portfolioId)

    // ATH from all operation snapshots
    const ops = await db.operations
      .where('portfolioId').equals(portfolioId)
      .toArray()
    const snapshots = ops.map(op => op.snapshotAfter)

    const holdingStates = calculateCurrentAllocations(holdings, fxRate)
    const cashBalances = {
      twd: cashAccounts.find(a => a.currency === 'TWD')?.balance ?? 0,
      usd: cashAccounts.find(a => a.currency === 'USD')?.balance ?? 0,
    }

    return calculateAmmunitionStatus(ammoPool, holdingStates, cashBalances, snapshots, fxRate)
  }, [portfolioId])
}

// ─── AmmunitionPoolWidget ─────────────────────────────────────────────────────

export function AmmunitionPoolWidget({
  portfolioId,
  onNavigateToSettings,
}: {
  portfolioId: string
  onNavigateToSettings: () => void
}) {
  const status = useAmmunitionStatus(portfolioId)

  // Loading
  if (status === undefined) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          Ammunition Pool
        </h2>
        <div className="h-16 rounded bg-muted animate-pulse" />
      </div>
    )
  }

  // Not configured
  if (status === null) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          Ammunition Pool
        </h2>
        <button
          type="button"
          onClick={onNavigateToSettings}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Set up your ammunition pool in Settings
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    )
  }

  const { tier1, tier2, currentDrawdownPct, portfolioATH, totalReserveBase, tier1Proximity, tier2Proximity } = status
  const atATH = currentDrawdownPct >= -0.01

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          Ammunition Pool
        </h2>
        {totalReserveBase > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            Reserve: {fmtTWD(totalReserveBase)}
          </span>
        )}
      </div>

      {/* Drawdown indicator */}
      <div className={cn(
        'flex items-center gap-1.5 text-xs',
        atATH
          ? 'text-emerald-600 dark:text-emerald-400'
          : currentDrawdownPct <= tier1.deployTriggerPct
            ? 'text-amber-600 dark:text-amber-400 font-medium'
            : 'text-muted-foreground',
      )}>
        {atATH
          ? <><CheckCircle2 className="h-3 w-3 shrink-0" /> At all-time high</>
          : (
            <>
              Drawdown:{' '}
              <span className="tabular-nums font-medium">
                {currentDrawdownPct.toFixed(2)}%
              </span>
              {' '}from ATH ({fmtTWD(portfolioATH)})
            </>
          )
        }
      </div>

      {/* Tier gauges */}
      <div className="space-y-3">
        <TierRow tier={tier1} proximity={tier1Proximity} />
        <div className="border-t border-border/50" />
        <TierRow tier={tier2} proximity={tier2Proximity} />
      </div>
    </div>
  )
}
