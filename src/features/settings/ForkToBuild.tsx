import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { db } from '@/db/database'
import { createEntityLink } from '@/db/entityLinkService'
import { useHoldings } from '@/db/hooks'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore } from '@/stores/uiStore'
import { useModeStore } from '@/stores/modeStore'
import type { Build, BuildHolding } from '@/types'
import type { SnapshotRecord } from '@/db/database'

interface ForkToBuildProps {
  portfolioId: string
}

type SourceType = 'target_allocation' | 'historical_snapshot'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ForkToBuild({ portfolioId }: ForkToBuildProps) {
  const portfolio = usePortfolioStore((s) => s.portfolio)
  const setBuildTab = useUIStore((s) => s.setBuildTab)
  const setMode = useModeStore((s) => s.setMode)

  const holdings = useHoldings(portfolioId)
  const activeHoldings = holdings.filter((h) => h.status === 'active')

  // Load snapshots for historical snapshot option (most recent 20, sorted desc)
  const snapshots = useLiveQuery(
    async () => {
      const all = await db.snapshots
        .where('portfolioId').equals(portfolioId)
        .sortBy('timestamp')
      // De-duplicate by date (keep one per calendar day), newest first
      const seen = new Set<string>()
      const deduped: SnapshotRecord[] = []
      for (let i = all.length - 1; i >= 0; i--) {
        const snap = all[i]
        const day = new Date(snap.timestamp).toISOString().slice(0, 10)
        if (!seen.has(day)) {
          seen.add(day)
          deduped.push(snap)
        }
      }
      return deduped.slice(0, 20) // cap at 20 dates
    },
    [portfolioId],
    [],
  ) ?? []

  const [sourceType, setSourceType] = useState<SourceType>('target_allocation')
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>('')
  const [includeDCA, setIncludeDCA] = useState(true)
  const [includeRebalance, setIncludeRebalance] = useState(true)
  const [buildName, setBuildName] = useState(`${portfolio?.name ?? 'Portfolio'} Fork`)
  const [isForking, setIsForking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const selectedSnapshot = snapshots.find((s) => s.id === selectedSnapshotId) ?? snapshots[0]
  const hasSnapshots = snapshots.length > 0

  const canFork =
    buildName.trim().length > 0 &&
    (sourceType === 'target_allocation' || (sourceType === 'historical_snapshot' && hasSnapshots))

  async function handleFork() {
    if (!portfolio) return
    setIsForking(true)
    setError(null)

    try {
      let buildHoldings: BuildHolding[]
      let snapshotDate: Date | undefined

      if (sourceType === 'target_allocation') {
        buildHoldings = activeHoldings.map((h) => ({
          ticker: h.ticker,
          name: h.name,
          currency: h.currency,
          targetAllocationPct: h.targetAllocationPct,
        }))
      } else {
        const snap = selectedSnapshot
        if (!snap) throw new Error('No snapshot selected.')
        snapshotDate = new Date(snap.timestamp)

        const total = snap.holdings.reduce((sum, sh) => sum + sh.marketValueBase, 0)
        if (total === 0) throw new Error('Snapshot has zero total value — cannot derive allocations.')

        buildHoldings = snap.holdings
          .filter((sh) => sh.marketValueBase > 0)
          .map((sh) => {
            const holding = holdings.find((h) => h.id === sh.holdingId)
            return {
              ticker: holding?.ticker ?? sh.holdingId,
              name: holding?.name ?? sh.holdingId,
              currency: holding?.currency ?? 'USD',
              targetAllocationPct: Math.round((sh.marketValueBase / total) * 10000) / 100,
            }
          })
          // Normalize to exactly 100% (floating point guard)
          .map((bh, _, arr) => {
            const sumSoFar = arr.reduce((s, b) => s + b.targetAllocationPct, 0)
            void sumSoFar // adjustment handled below
            return bh
          })

        // Adjust last holding to ensure sum = 100
        const sum = buildHoldings.reduce((s, h) => s + h.targetAllocationPct, 0)
        if (buildHoldings.length > 0 && Math.abs(sum - 100) < 1) {
          buildHoldings[buildHoldings.length - 1].targetAllocationPct =
            Math.round((buildHoldings[buildHoldings.length - 1].targetAllocationPct + (100 - sum)) * 100) / 100
        }
      }

      const now = new Date()
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

      const newBuild: Build = {
        id: crypto.randomUUID(),
        name: buildName.trim(),
        holdings: buildHoldings,
        dcaAmount: includeDCA ? portfolio.monthlyDCABudget || 1000 : 1000,
        dcaCurrency: includeDCA ? portfolio.monthlyDCABudgetCurrency : 'USD',
        dcaFrequency: 'monthly',
        startDate: oneYearAgo,
        endDate: now,
        rebalanceStrategy: includeRebalance ? portfolio.defaultRebalanceStrategy : 'soft',
        rebalanceTriggers: ['on-dca'],
        isFavorite: false,
        sourceInfo: {
          sourceFolioId: portfolio.id,
          forkType: sourceType,
          snapshotDate,
        },
        createdAt: now,
        updatedAt: now,
      }

      await db.builds.add(newBuild)

      await createEntityLink({
        sourceFolioId: portfolio.id,
        targetBuildId: newBuild.id,
        relationType: 'forked_from',
      })

      setDone(true)
      // Brief delay so user sees success state, then switch mode
      setTimeout(() => {
        setMode('build')
        setBuildTab('builds')
      }, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fork failed. Please try again.')
    } finally {
      setIsForking(false)
    }
  }

  if (done) {
    return (
      <div className="py-8 flex flex-col items-center gap-3 text-center">
        <div className="rounded-full bg-green-100 dark:bg-green-900/30 p-3">
          <GitBranch className="h-5 w-5 text-green-600 dark:text-green-400" />
        </div>
        <p className="text-sm font-medium">Build created! Switching to Build mode…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 pt-2">
      <div>
        <h2 className="text-sm font-semibold">Fork to Build</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Create a Build strategy from this portfolio to backtest variations.
        </p>
      </div>

      {/* Source type */}
      <div className="space-y-2">
        <Label className="text-xs">Source</Label>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: 'target_allocation' as SourceType, label: 'Target Allocation', desc: 'Current target %', disabled: false },
            { value: 'historical_snapshot' as SourceType, label: 'Historical Snapshot', desc: 'From a past date', disabled: !hasSnapshots },
          ]).map(({ value, label, desc, disabled }) => (
            <button
              key={value}
              onClick={() => !disabled && setSourceType(value)}
              disabled={disabled}
              className={cn(
                'p-3 rounded-lg border text-left transition-colors',
                sourceType === value
                  ? 'border-primary bg-primary/5'
                  : 'hover:bg-accent/40',
                disabled && 'opacity-40 cursor-not-allowed',
              )}
            >
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">{disabled ? 'No snapshots yet' : desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Snapshot date picker */}
      {sourceType === 'historical_snapshot' && hasSnapshots && (
        <div className="space-y-1.5">
          <Label className="text-xs">Snapshot date</Label>
          <select
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={selectedSnapshotId || snapshots[0]?.id}
            onChange={(e) => setSelectedSnapshotId(e.target.value)}
          >
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {fmtDate(new Date(s.timestamp))}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Holdings preview */}
      <Card>
        <CardContent className="p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Holdings to include</p>
          {activeHoldings.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active holdings.</p>
          ) : (
            activeHoldings.map((h) => (
              <div key={h.id} className="flex justify-between text-xs">
                <span className="font-mono font-medium">{h.ticker}</span>
                <span className="text-muted-foreground">{h.targetAllocationPct}%</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Options */}
      <div className="space-y-2">
        <Label className="text-xs">Options</Label>
        <div className="space-y-2">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <Checkbox
              checked={includeDCA}
              onCheckedChange={(v) => setIncludeDCA(Boolean(v))}
            />
            <div>
              <p className="text-sm">Include DCA settings</p>
              {portfolio && (
                <p className="text-xs text-muted-foreground">
                  {portfolio.monthlyDCABudgetCurrency} {(portfolio.monthlyDCABudget || 1000).toLocaleString()} · monthly
                </p>
              )}
            </div>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <Checkbox
              checked={includeRebalance}
              onCheckedChange={(v) => setIncludeRebalance(Boolean(v))}
            />
            <div>
              <p className="text-sm">Include rebalance strategy</p>
              {portfolio && (
                <p className="text-xs text-muted-foreground capitalize">
                  {portfolio.defaultRebalanceStrategy} rebalance
                </p>
              )}
            </div>
          </label>
        </div>
      </div>

      {/* Build name */}
      <div className="space-y-1.5">
        <Label htmlFor="fork-name">Build name</Label>
        <Input
          id="fork-name"
          value={buildName}
          onChange={(e) => setBuildName(e.target.value)}
          placeholder="My Portfolio Fork"
        />
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      <Button
        className="w-full"
        onClick={handleFork}
        disabled={!canFork || isForking || activeHoldings.length === 0}
      >
        <GitBranch className="h-4 w-4 mr-2" />
        {isForking ? 'Creating Build…' : 'Fork to Build'}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        You'll be switched to Build mode to configure and run the backtest.
      </p>
    </div>
  )
}
