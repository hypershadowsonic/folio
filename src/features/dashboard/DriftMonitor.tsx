/**
 * DriftMonitor.tsx
 *
 * Two-mode allocation drift monitor:
 *  - Compact: embedded in Dashboard — health pill + allocation bars + alert list
 *  - Detailed: full-screen Dialog — sleeve-grouped holding details with visual bars
 *
 * Self-contained: uses useDriftSummary hook for all data loading.
 */

import { useState, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronRight,
  ArrowRight,
} from 'lucide-react'
import { db } from '@/db/database'
import { getLatestFxRate } from '@/engine/fifo'
import { calculateCurrentAllocations } from '@/engine/rebalance'
import { calculateDriftStatus, getRebalanceSuggestion } from '@/engine/drift'
import type {
  DriftStatus,
  SleeveDriftStatus,
  PortfolioDriftSummary,
} from '@/engine/drift'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Sleeve } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SleeveAllocRow {
  sleeve: Sleeve
  actualPct: number
  targetPct: number
}

interface DriftSummaryData {
  summary: PortfolioDriftSummary
  sleeveAllocs: SleeveAllocRow[]
}

// ─── useDriftSummary ──────────────────────────────────────────────────────────

/**
 * Loads portfolio data reactively from Dexie, then runs the allocation and
 * drift calculations. Returns:
 *  - undefined: still loading
 *  - null: no portfolio found
 *  - DriftSummaryData: ready
 */
export function useDriftSummary(
  portfolioId: string | undefined,
): DriftSummaryData | null | undefined {
  return useLiveQuery(async () => {
    if (!portfolioId) return null

    const [portfolio, holdings, sleeves] = await Promise.all([
      db.portfolios.get(portfolioId),
      db.holdings.where('[portfolioId+status]').equals([portfolioId, 'active']).sortBy('ticker'),
      db.sleeves.where('portfolioId').equals(portfolioId).toArray(),
    ])

    if (!portfolio) return null

    // ── FX rate: 4-tier resolution matching snapshotService.resolveCurrentFxRate
    // Inlined here so useLiveQuery tracks fxTransactions + fxLots reactively.
    let fxRate: number
    if (portfolio.fxRateOverride && portfolio.fxRateOverride > 0) {
      fxRate = portfolio.fxRateOverride
    } else {
      const txIds = await db.fxTransactions
        .where('portfolioId').equals(portfolioId).primaryKeys() as string[]

      let resolved: number | null = null
      if (txIds.length > 0) {
        const lots = await db.fxLots
          .where('fxTransactionId').anyOf(txIds).sortBy('timestamp')
        resolved = getLatestFxRate(lots)

        if (resolved == null) {
          const txs = await db.fxTransactions
            .where('portfolioId').equals(portfolioId).sortBy('timestamp')
          const latestTx = txs[txs.length - 1]
          if (latestTx?.rate > 0) resolved = latestTx.rate
        }
      }

      fxRate = resolved ?? (portfolio.initialFxRate ?? 0) > 0
        ? (portfolio.initialFxRate ?? 1)
        : 1
    }
    const holdingStates = calculateCurrentAllocations(holdings, fxRate)

    const summary = calculateDriftStatus(holdingStates, holdings, sleeves)

    // Sleeve allocs for the allocation bars
    let holdingsBase = 0
    for (const h of holdings) {
      const mv = (h.currentShares ?? 0) * (h.currentPricePerShare ?? 0)
      holdingsBase += h.currency === 'USD' ? mv * fxRate : mv
    }
    // Allocation bars use holdings-only denominator (same rule as calculateCurrentAllocations)
    const sleeveAllocs: SleeveAllocRow[] = sleeves
      .map(sleeve => {
        const sleeveHoldings = holdings.filter(h => h.sleeveId === sleeve.id)
        const actualPct = sleeveHoldings.reduce((sum, h) => {
          const mv = (h.currentShares ?? 0) * (h.currentPricePerShare ?? 0)
          const mvBase = h.currency === 'USD' ? mv * fxRate : mv
          return sum + (holdingsBase > 0 ? (mvBase / holdingsBase) * 100 : 0)
        }, 0)
        return { sleeve, actualPct, targetPct: sleeve.targetAllocationPct }
      })
      .filter(row => row.targetPct > 0 || row.actualPct > 0)

    return { summary, sleeveAllocs }
  }, [portfolioId])
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

const SEVERITY_HEX = {
  ok:       '#10b981',
  warning:  '#f59e0b',
  critical: '#ef4444',
} as const

type Severity = DriftStatus['severity']

function severityBadgeVariant(
  severity: Severity,
): 'success' | 'warning' | 'destructive' {
  if (severity === 'ok')      return 'success'
  if (severity === 'warning') return 'warning'
  return 'destructive'
}

// ─── CSS ID helpers ───────────────────────────────────────────────────────────

// Sanitise UUID for use as a CSS identifier component
const sid = (id: string) => `s${id.replace(/-/g, '')}`
const hid = (id: string) => `h${id.replace(/-/g, '')}`

// ─── HealthPill ───────────────────────────────────────────────────────────────

function HealthPill({
  health,
}: {
  health: PortfolioDriftSummary['overallHealth']
}) {
  if (health === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Healthy
      </span>
    )
  }
  if (health === 'attention') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" />
        Attention
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
      <XCircle className="h-3 w-3" />
      Action Needed
    </span>
  )
}

// ─── CompactAlertRow ──────────────────────────────────────────────────────────

function CompactAlertRow({ holding }: { holding: DriftStatus }) {
  const { holdingId, ticker, sleeveName, driftPct, severity } = holding
  const sign = driftPct > 0 ? '+' : ''

  return (
    <div className="flex items-center gap-3 py-1.5">
      {/* Ticker + sleeve badge */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="text-xs font-semibold shrink-0">{ticker}</span>
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-sm dm-hdot-${hid(holdingId)}`}
          />
          {sleeveName}
        </span>
      </div>

      {/* Drift badge */}
      <Badge variant={severityBadgeVariant(severity)} className="text-[10px] px-1 py-0 shrink-0">
        {sign}{driftPct.toFixed(1)}%
      </Badge>

      {/* Mini progress bar: how far drift is toward the threshold */}
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full dm-mini-${hid(holdingId)}`} />
      </div>
    </div>
  )
}

// ─── DetailedHoldingRow ───────────────────────────────────────────────────────

function DetailedHoldingRow({ holding }: { holding: DriftStatus }) {
  const {
    holdingId,
    ticker,
    currentAllocationPct,
    targetAllocationPct,
    driftPct,
    driftThresholdPct,
    severity,
  } = holding
  const sign = driftPct > 0 ? '+' : ''

  return (
    <div className="px-4 py-3 space-y-1.5">
      {/* Header: ticker + drift badge + numbers */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold">{ticker}</span>
          <Badge variant={severityBadgeVariant(severity)} className="text-[10px] px-1 py-0">
            {sign}{driftPct.toFixed(1)}%
          </Badge>
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
          {currentAllocationPct.toFixed(1)}% → {targetAllocationPct.toFixed(1)}%
        </span>
      </div>

      {/* Allocation bar: filled portion = current, vertical marker = target */}
      <div className="relative h-2 w-full overflow-visible rounded-full bg-muted">
        {/* Current fill */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full dm-hfill-${hid(holdingId)}`}
        />
        {/* Target marker */}
        <div
          className={`absolute inset-y-0 w-0.5 -translate-x-px bg-foreground/30 dm-htgt-${hid(holdingId)}`}
        />
      </div>

      {/* Threshold note */}
      <p className="text-[10px] text-muted-foreground">
        Threshold: ±{driftThresholdPct}%
      </p>
    </div>
  )
}

// ─── DetailedSleeveSection ────────────────────────────────────────────────────

function DetailedSleeveSection({
  sleeve,
  collapsed,
  onToggle,
}: {
  sleeve: SleeveDriftStatus
  collapsed: boolean
  onToggle: () => void
}) {
  const driftSign = sleeve.driftPct > 0 ? '+' : ''

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Sleeve header */}
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-sm dm-sdot-${sid(sleeve.sleeveId)}`} />
          <span className="text-sm font-semibold truncate">{sleeve.sleeveName}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {sleeve.currentAllocationPct.toFixed(1)}% / {sleeve.targetAllocationPct.toFixed(1)}%
          </span>
          <Badge
            variant={severityBadgeVariant(sleeve.severity)}
            className="text-[10px] px-1 py-0"
          >
            {sleeve.driftPct === 0 ? '=' : driftSign}{sleeve.driftPct.toFixed(1)}%
          </Badge>
          {collapsed
            ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          }
        </div>
      </button>

      {/* Holdings */}
      {!collapsed && sleeve.holdings.length > 0 && (
        <div className="divide-y divide-border bg-muted/20">
          {sleeve.holdings.map(h => (
            <DetailedHoldingRow key={h.holdingId} holding={h} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── DriftMonitor ─────────────────────────────────────────────────────────────

export function DriftMonitor({
  portfolioId,
  onNavigateToDCA,
}: {
  portfolioId: string
  onNavigateToDCA: () => void
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const [collapsedSleeves, setCollapsedSleeves] = useState<Set<string>>(new Set())

  const data = useDriftSummary(portfolioId)

  // ── Derived: alert holdings (warning + critical) ──────────────────────────
  const alertHoldings = useMemo(
    () => (data?.summary.holdings ?? []).filter(h => h.severity !== 'ok'),
    [data],
  )

  // ── Dynamic CSS for all generated class names ─────────────────────────────
  // One <style> block covers: sleeve bars, dots, mini progress bars, detailed bars
  const dynamicCss = useMemo(() => {
    if (!data) return ''
    const { summary, sleeveAllocs } = data

    // Actual/Target flex bars + sleeve dots (compact bars + detail dots)
    const holdingsTotalPct = sleeveAllocs.reduce((s, a) => s + a.actualPct, 0)
    const actualFlex = (pct: number) =>
      holdingsTotalPct > 0 ? pct / holdingsTotalPct : 0

    const sleeveCss = sleeveAllocs.map(({ sleeve, actualPct, targetPct }) => `
      .dm-abar-${sid(sleeve.id)}{flex:${actualFlex(actualPct)};background-color:${sleeve.color}}
      .dm-tbar-${sid(sleeve.id)}{flex:${Math.max(targetPct, 0)};background-color:${sleeve.color}}
      .dm-sdot-${sid(sleeve.id)}{background-color:${sleeve.color}}
    `).join('')

    // Compact alert row dots (holding-keyed, colored by sleeve)
    // mini progress bars: 0 → threshold = full bar
    const holdingAlertCss = summary.holdings
      .filter(h => h.severity !== 'ok')
      .map(h => {
        const absDrift = Math.abs(h.driftPct)
        const fillPct = Math.min((absDrift / h.driftThresholdPct) * 100, 100)
        return (
          `.dm-hdot-${hid(h.holdingId)}{background-color:${h.sleeveColor}}` +
          `.dm-mini-${hid(h.holdingId)}{width:${fillPct.toFixed(2)}%;background-color:${SEVERITY_HEX[h.severity]}}`
        )
      }).join('')

    // Detailed holding bars: scale so target sits at ~67% of the bar width
    const holdingBarCss = summary.holdings.map(h => {
      const scaleMax = Math.max(h.currentAllocationPct * 1.5, h.targetAllocationPct * 1.5, 2)
      const fillPct = Math.min((h.currentAllocationPct / scaleMax) * 100, 100)
      const tgtPct  = Math.min((h.targetAllocationPct  / scaleMax) * 100, 100)
      const color   = SEVERITY_HEX[h.severity]
      return (
        `.dm-hfill-${hid(h.holdingId)}{width:${fillPct.toFixed(2)}%;background-color:${color}}` +
        `.dm-htgt-${hid(h.holdingId)}{left:${tgtPct.toFixed(2)}%}`
      )
    }).join('')

    // Detail sleeve header dots (sleeveId-keyed)
    const detailSleeveDotsCSS = summary.sleeves.map(s =>
      `.dm-sdot-${sid(s.sleeveId)}{background-color:${s.sleeveColor}}`,
    ).join('')

    return sleeveCss + holdingAlertCss + holdingBarCss + detailSleeveDotsCSS
  }, [data])

  // ── Sleeve toggle helper ──────────────────────────────────────────────────
  const toggleSleeve = (sleeveId: string) => {
    setCollapsedSleeves(prev => {
      const next = new Set(prev)
      if (next.has(sleeveId)) next.delete(sleeveId)
      else next.add(sleeveId)
      return next
    })
  }

  // ── Loading / empty states ────────────────────────────────────────────────
  if (data === undefined) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Allocation</h2>
        </div>
        <div className="h-24 rounded-lg bg-muted animate-pulse" />
      </div>
    )
  }

  if (data === null || data.sleeveAllocs.length === 0) {
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Allocation</h2>
        <p className="text-sm text-muted-foreground">
          Add sleeves and log trades to see allocation data.
        </p>
      </div>
    )
  }

  const { summary, sleeveAllocs } = data
  const holdingsTotalPct = sleeveAllocs.reduce((s, a) => s + a.actualPct, 0)

  return (
    <div className="space-y-3">
      {/* Dynamic CSS injected once, covers all generated class names */}
      {/* eslint-disable-next-line react/no-danger */}
      <style dangerouslySetInnerHTML={{ __html: dynamicCss }} />

      {/* ── Section header: title + health pill + "View all" ──────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Allocation</h2>
          <HealthPill health={summary.overallHealth} />
        </div>
        {summary.holdings.length > 0 && (
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className="flex items-center gap-1 text-xs text-primary hover:underline shrink-0"
          >
            View all <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* ── Actual vs Target stacked bars ─────────────────────────────────── */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Actual
        </p>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {holdingsTotalPct === 0 ? (
            <div className="h-full w-full bg-muted-foreground/20" />
          ) : (
            sleeveAllocs.map(({ sleeve }) => (
              <div key={sleeve.id} className={`h-full dm-abar-${sid(sleeve.id)}`} />
            ))
          )}
        </div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Target
        </p>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {sleeveAllocs.map(({ sleeve }) => (
            <div key={sleeve.id} className={`h-full opacity-50 dm-tbar-${sid(sleeve.id)}`} />
          ))}
        </div>
      </div>

      {/* ── Legend ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {sleeveAllocs.map(({ sleeve }) => (
          <span key={sleeve.id} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className={`h-2 w-2 shrink-0 rounded-sm dm-sdot-${sid(sleeve.id)}`} />
            {sleeve.name}
          </span>
        ))}
      </div>

      {/* ── Compact alert list (warning + critical only) ───────────────────── */}
      {alertHoldings.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          All holdings within target bands
        </p>
      ) : (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {alertHoldings.map(h => (
            <div key={h.holdingId} className="px-3">
              <CompactAlertRow holding={h} />
            </div>
          ))}
        </div>
      )}

      {/* ── Detail Dialog ─────────────────────────────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent
          className={cn(
            'max-w-lg w-full p-0 gap-0',
            'max-h-[90dvh] flex flex-col overflow-hidden',
          )}
        >
          {/* Header */}
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border mb-0 space-y-2 shrink-0">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base">Drift Monitor</DialogTitle>
              <HealthPill health={summary.overallHealth} />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed pr-6">
              {getRebalanceSuggestion(summary)}
            </p>
            {(summary.overallHealth === 'action-needed' ||
              summary.overallHealth === 'attention') && (
              <Button
                size="sm"
                variant={summary.overallHealth === 'action-needed' ? 'default' : 'outline'}
                className="self-start h-7 text-xs"
                onClick={() => {
                  setDetailOpen(false)
                  onNavigateToDCA()
                }}
              >
                Go to DCA Planner
                <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </DialogHeader>

          {/* Scrollable sleeve list */}
          <div className="flex-1 overflow-y-auto divide-y divide-border">
            {summary.sleeves.map(sleeve => (
              <DetailedSleeveSection
                key={sleeve.sleeveId}
                sleeve={sleeve}
                collapsed={collapsedSleeves.has(sleeve.sleeveId)}
                onToggle={() => toggleSleeve(sleeve.sleeveId)}
              />
            ))}
          </div>

          {/* Bottom summary bar */}
          <div className="shrink-0 border-t border-border bg-muted/30 px-5 py-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span>Total: {summary.holdings.length}</span>
            <span className="text-red-600 dark:text-red-400 font-medium">
              Critical: {summary.criticalCount}
            </span>
            <span className="text-amber-600 dark:text-amber-400 font-medium">
              Warning: {summary.warningCount}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
              OK: {summary.holdings.length - summary.criticalCount - summary.warningCount}
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
