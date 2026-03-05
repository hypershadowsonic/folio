import { useEffect, useRef } from 'react'
import { TrendingUp, DollarSign, Wallet } from 'lucide-react'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useCashAccounts, useOperations, useSleeves, useHoldings } from '@/db/hooks'
import { Badge } from '@/components/ui/badge'
import { OperationCard } from '@/features/operations/OperationCard'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function AllocationBar({
  label,
  color,
  current,
  target,
}: {
  label: string
  color: string
  current: number
  target: number
}) {
  const drift = current - target
  const driftLabel = drift === 0 ? 'on target' : drift > 0 ? `+${drift.toFixed(1)}%` : `${drift.toFixed(1)}%`
  const driftOk = Math.abs(drift) <= 2

  // Set CSS custom properties imperatively so no JSX style={} prop is needed.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--sleeve-color', color)
    el.style.setProperty('--bar-width', `${Math.min(current, 100)}%`)
    el.style.setProperty('--target-pos', `${Math.min(target, 100)}%`)
  }, [color, current, target])

  return (
    <div ref={ref} className="space-y-1">
      <div className="flex justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--sleeve-color)]" />
          <span className="font-medium">{label}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>{current.toFixed(1)}% / {target}%</span>
          <Badge
            variant={driftOk ? 'secondary' : 'warning'}
            className="text-[10px] px-1 py-0"
          >
            {driftLabel}
          </Badge>
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-muted overflow-hidden">
        <div className="absolute top-0 bottom-0 w-0.5 bg-foreground/30 z-10 left-[var(--target-pos)]" />
        <div className="h-full rounded-full transition-all bg-[var(--sleeve-color)] w-[var(--bar-width)]" />
      </div>
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const portfolio = usePortfolioStore(s => s.portfolio)
  const portfolioId = portfolio?.id

  const cashAccounts = useCashAccounts(portfolioId)
  const operations   = useOperations(portfolioId)
  const sleeves      = useSleeves(portfolioId)
  useHoldings(portfolioId) // subscribed for Phase 3 share-price allocation calc

  if (!portfolio) return null

  const twdBalance = cashAccounts.find(a => a.currency === 'TWD')?.balance ?? 0
  const usdBalance = cashAccounts.find(a => a.currency === 'USD')?.balance ?? 0

  // Latest FX rate from operation snapshots
  const lastFxRate = (() => {
    for (let i = operations.length - 1; i >= 0; i--) {
      const r = operations[i].snapshotAfter?.currentFxRate
      if (r && r > 0) return r
    }
    return null
  })()

  const usdInTwd = lastFxRate != null ? usdBalance * lastFxRate : null
  const totalTwd = usdInTwd != null ? twdBalance + usdInTwd : twdBalance

  const recentOps = operations.slice(0, 3)

  return (
    <div className="px-4 pt-5 pb-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">{portfolio.name}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Dashboard</p>
      </div>

      {/* Cash balances */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={Wallet}      label="TWD Cash" value={fmt(twdBalance, 'TWD')} />
        <StatCard
          icon={DollarSign}
          label="USD Cash"
          value={fmt(usdBalance, 'USD')}
          sub={usdInTwd != null ? `≈ ${fmt(usdInTwd, 'TWD')}` : 'No FX rate yet'}
        />
      </div>

      {/* Total cash row */}
      <div className="rounded-lg border border-border bg-card p-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-wide">Total cash (TWD equiv.)</span>
        </div>
        <p className="text-xl font-bold">{fmt(totalTwd, 'TWD')}</p>
      </div>

      {lastFxRate != null && (
        <p className="text-xs text-muted-foreground -mt-4">
          Rate: 1 USD = {lastFxRate.toFixed(4)} TWD (last FX transaction)
        </p>
      )}

      {/* Sleeve allocation targets */}
      {sleeves.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Sleeve Targets</h2>
          <div className="rounded-lg border border-border bg-card p-4 space-y-4">
            {sleeves.map(sleeve => (
              <AllocationBar
                key={sleeve.id}
                label={sleeve.name}
                color={sleeve.color}
                current={0}   // Phase 3: replace with share-price-weighted actual %
                target={sleeve.targetAllocationPct}
              />
            ))}
            <p className="text-xs text-muted-foreground pt-1">
              Current % requires share prices — available in Phase 3.
            </p>
          </div>
        </div>
      )}

      {/* Recent operations */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Recent Operations</h2>
        {recentOps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No operations yet.</p>
        ) : (
          recentOps.map(op => (
            <OperationCard key={op.id} operation={op} compact />
          ))
        )}
      </div>
    </div>
  )
}
