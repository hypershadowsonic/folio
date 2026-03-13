/**
 * drift.ts — pure drift-monitoring calculation module.
 *
 * No React, no Dexie. All functions are pure: same inputs → same outputs.
 *
 * Exported types:
 *   DriftStatus          — per-holding drift state
 *   SleeveDriftStatus    — per-sleeve aggregate drift state
 *   PortfolioDriftSummary — full portfolio drift overview
 *
 * Exported functions:
 *   calculateDriftStatus   — build PortfolioDriftSummary from holdings + config
 *   getRebalanceSuggestion — human-readable one-liner based on drift health
 */

import type { Holding, Sleeve } from '@/types'
import type { HoldingState } from './rebalance'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriftStatus {
  holdingId: string
  ticker: string
  sleeveName: string
  sleeveColor: string
  currency: 'USD' | 'TWD'
  currentAllocationPct: number
  targetAllocationPct: number
  driftPct: number              // currentAllocationPct - targetAllocationPct (+ = overweight)
  driftThresholdPct: number     // from holding config
  severity: 'ok' | 'warning' | 'critical'
  // ok:       |drift| <= threshold × 0.5
  // warning:  threshold × 0.5 < |drift| <= threshold
  // critical: |drift| > threshold
}

export interface SleeveDriftStatus {
  sleeveId: string
  sleeveName: string
  sleeveColor: string
  currentAllocationPct: number   // sum of child holdings' actual %
  targetAllocationPct: number    // sum of child holdings' target %
  driftPct: number               // currentAllocationPct - targetAllocationPct
  severity: 'ok' | 'warning' | 'critical'
  holdings: DriftStatus[]        // child holdings, sorted by |driftPct| descending
}

export interface PortfolioDriftSummary {
  holdings: DriftStatus[]        // all holdings, sorted by |driftPct| descending
  sleeves: SleeveDriftStatus[]   // all sleeves, sorted by |driftPct| descending
  criticalCount: number          // holdings exceeding threshold
  warningCount: number
  overallHealth: 'healthy' | 'attention' | 'action-needed'
  // healthy:      0 critical, 0 warning
  // attention:    0 critical, 1+ warning
  // action-needed: 1+ critical
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function classifySeverity(
  absDrift: number,
  threshold: number,
): DriftStatus['severity'] {
  if (absDrift > threshold) return 'critical'
  if (absDrift > threshold * 0.5) return 'warning'
  return 'ok'
}

function sleeveSeverity(holdings: DriftStatus[]): SleeveDriftStatus['severity'] {
  if (holdings.some(h => h.severity === 'critical')) return 'critical'
  if (holdings.some(h => h.severity === 'warning')) return 'warning'
  return 'ok'
}

// ─── calculateDriftStatus ─────────────────────────────────────────────────────

/**
 * Builds a PortfolioDriftSummary from HoldingState[] (rebalance engine output),
 * Holding[] (for threshold and sleeve assignment), and Sleeve[] (for names/colors).
 *
 * Holdings not found in holdingConfigs or with no matching sleeve are skipped.
 */
export function calculateDriftStatus(
  holdings: HoldingState[],
  holdingConfigs: Holding[],
  sleeves: Sleeve[],
): PortfolioDriftSummary {
  const sleeveMap = new Map(sleeves.map(s => [s.id, s]))
  const configMap = new Map(holdingConfigs.map(h => [h.id, h]))

  // ── Per-holding drift ─────────────────────────────────────────────────────

  const driftStatuses: DriftStatus[] = []

  for (const state of holdings) {
    const config = configMap.get(state.holdingId)
    if (!config) continue

    const sleeve = sleeveMap.get(state.sleeveId)
    if (!sleeve) continue

    const absDrift = Math.abs(state.drift)
    const threshold = config.driftThresholdPct

    driftStatuses.push({
      holdingId:            state.holdingId,
      ticker:               state.ticker,
      sleeveName:           sleeve.name,
      sleeveColor:          sleeve.color,
      currency:             state.currency,
      currentAllocationPct: state.currentAllocationPct,
      targetAllocationPct:  state.targetAllocationPct,
      driftPct:             state.drift,
      driftThresholdPct:    threshold,
      severity:             classifySeverity(absDrift, threshold),
    })
  }

  // Sort by |driftPct| descending (worst drift first)
  driftStatuses.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))

  // ── Per-sleeve aggregates ─────────────────────────────────────────────────

  const sleeveGroups = new Map<string, DriftStatus[]>()
  for (const d of driftStatuses) {
    const sleeve = sleeves.find(s => s.name === d.sleeveName && s.color === d.sleeveColor)
    if (!sleeve) continue
    const existing = sleeveGroups.get(sleeve.id) ?? []
    existing.push(d)
    sleeveGroups.set(sleeve.id, existing)
  }

  const sleeveDriftStatuses: SleeveDriftStatus[] = []

  for (const sleeve of sleeves) {
    const children = sleeveGroups.get(sleeve.id) ?? []

    const currentAllocationPct = children.reduce((s, h) => s + h.currentAllocationPct, 0)
    const targetAllocationPct  = children.reduce((s, h) => s + h.targetAllocationPct, 0)
    const driftPct             = currentAllocationPct - targetAllocationPct

    // Sort children by |driftPct| descending within sleeve
    const sortedChildren = [...children].sort(
      (a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct),
    )

    sleeveDriftStatuses.push({
      sleeveId:             sleeve.id,
      sleeveName:           sleeve.name,
      sleeveColor:          sleeve.color,
      currentAllocationPct,
      targetAllocationPct,
      driftPct,
      severity:             sleeveSeverity(children),
      holdings:             sortedChildren,
    })
  }

  // Sort sleeves by |driftPct| descending
  sleeveDriftStatuses.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))

  // ── Summary counts ────────────────────────────────────────────────────────

  const criticalCount = driftStatuses.filter(d => d.severity === 'critical').length
  const warningCount  = driftStatuses.filter(d => d.severity === 'warning').length

  const overallHealth: PortfolioDriftSummary['overallHealth'] =
    criticalCount > 0 ? 'action-needed'
    : warningCount > 0 ? 'attention'
    : 'healthy'

  return {
    holdings: driftStatuses,
    sleeves:  sleeveDriftStatuses,
    criticalCount,
    warningCount,
    overallHealth,
  }
}

// ─── getRebalanceSuggestion ───────────────────────────────────────────────────

/**
 * Returns a human-readable one-liner describing the portfolio's drift health.
 *
 * Examples:
 *   "Portfolio is well-balanced. No action needed."
 *   "2 holdings approaching drift threshold. Consider rebalancing soon."
 *   "1 holding exceeded drift threshold. Rebalance recommended. VOO is 4.2% overweight."
 */
export function getRebalanceSuggestion(summary: PortfolioDriftSummary): string {
  const { overallHealth, criticalCount, warningCount, holdings } = summary

  if (overallHealth === 'healthy') {
    return 'Portfolio is well-balanced. No action needed.'
  }

  if (overallHealth === 'attention') {
    const n = warningCount
    return `${n} holding${n > 1 ? 's' : ''} approaching drift threshold. Consider rebalancing soon.`
  }

  // action-needed
  const n = criticalCount
  let msg = `${n} holding${n > 1 ? 's' : ''} exceeded drift threshold. Rebalance recommended.`

  // Append the worst critical holding
  const worst = holdings.find(h => h.severity === 'critical')
  if (worst) {
    const direction = worst.driftPct > 0 ? 'overweight' : 'underweight'
    msg += ` ${worst.ticker} is ${Math.abs(worst.driftPct).toFixed(1)}% ${direction}.`
  }

  return msg
}
