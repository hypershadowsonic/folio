/**
 * ammunition.ts — pure calculation engine for the Ammunition Pool.
 *
 * No React, no Dexie. All functions are pure: same inputs → same outputs.
 *
 * Exported types:
 *   AmmunitionTier       — per-tier deployment status
 *   AmmunitionPoolStatus — full two-tier pool overview
 *
 * Exported functions:
 *   calculateAmmunitionStatus — builds AmmunitionPoolStatus from config + live data
 */

import type { AmmunitionPool, PortfolioSnapshot } from '@/types'
import type { HoldingState } from './rebalance'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AmmunitionTier {
  label: string
  holdingId: string | null
  holdingTicker?: string
  currentValue: number           // market value in holding's native currency
  currentValueBase: number       // in TWD
  deployTriggerPct: number       // negative: e.g., -10 = trigger at -10% drawdown from ATH
  status: 'standby' | 'ready' | 'deploying' | 'depleted'
}

export interface AmmunitionPoolStatus {
  tier1: AmmunitionTier
  tier2: AmmunitionTier
  totalReserveBase: number       // tier1.currentValueBase + tier2.currentValueBase (TWD)
  portfolioATH: number           // all-time high total portfolio value (TWD)
  currentTotalBase: number       // current total portfolio value, holdings + cash (TWD)
  currentDrawdownPct: number     // (current − ATH) / ATH × 100  (≤ 0 when below ATH)
  tier1Proximity: number         // 0–100+%: how far drawdown has progressed to tier1 trigger
  tier2Proximity: number
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function resolveStatus(
  currentValueBase: number,
  configValueBase: number,
  currentDrawdownPct: number,
  deployTriggerPct: number,
): AmmunitionTier['status'] {
  if (currentValueBase <= 0) return 'depleted'
  // 1% buffer absorbs floating-point noise
  if (configValueBase > 0 && currentValueBase < configValueBase * 0.99) return 'deploying'
  if (deployTriggerPct < 0 && currentDrawdownPct <= deployTriggerPct) return 'ready'
  return 'standby'
}

/**
 * How far current drawdown has progressed toward the trigger.
 * Returns 0–100+% where 100% = at the trigger threshold.
 */
function drawdownProximityPct(drawdownPct: number, triggerPct: number): number {
  if (triggerPct >= 0) return 0   // invalid / not configured
  return Math.max(0, (drawdownPct / triggerPct) * 100)
}

function buildTier(
  label: string,
  tierConfig: { holdingId: string | null; value: number; deployTriggerPct: number },
  holdingStates: HoldingState[],
  currentDrawdownPct: number,
): AmmunitionTier {
  const { holdingId, value: configValueBase, deployTriggerPct } = tierConfig
  // Treat empty string same as null (backward compatibility)
  const effectiveId = holdingId === '' ? null : holdingId

  if (!effectiveId) {
    return {
      label,
      holdingId: null,
      currentValue: 0,
      currentValueBase: 0,
      deployTriggerPct,
      status: 'depleted',
    }
  }

  const state = holdingStates.find(h => h.holdingId === effectiveId)
  const currentValueBase = state?.marketValueBase ?? 0
  const currentValue     = state?.marketValue     ?? 0

  return {
    label,
    holdingId: effectiveId,
    holdingTicker: state?.ticker,
    currentValue,
    currentValueBase,
    deployTriggerPct,
    status: resolveStatus(currentValueBase, configValueBase, currentDrawdownPct, deployTriggerPct),
  }
}

// ─── calculateAmmunitionStatus ────────────────────────────────────────────────

/**
 * Builds AmmunitionPoolStatus from:
 *   config        — persisted tier configuration (from Dexie ammunitionPools table)
 *   holdingStates — live holding market values (from calculateCurrentAllocations)
 *   cashBalances  — live cash balances
 *   snapshots     — historical PortfolioSnapshots (for ATH derivation)
 *   fxRate        — current TWD/USD rate
 *
 * ATH is derived from both historical snapshots AND the current total, so it
 * never drops below the current value (newly set up portfolios always start at ATH).
 *
 * Drawdown uses total portfolio value (holdings + cash), not just invested capital.
 * This matches the intuitive meaning of "portfolio drawdown from peak".
 */
export function calculateAmmunitionStatus(
  config: AmmunitionPool,
  holdingStates: HoldingState[],
  cashBalances: { twd: number; usd: number },
  snapshots: PortfolioSnapshot[],
  fxRate: number,
): AmmunitionPoolStatus {
  // Total portfolio value (holdings + cash) in TWD
  const holdingsBase     = holdingStates.reduce((s, h) => s + h.marketValueBase, 0)
  const cashBase         = cashBalances.twd + cashBalances.usd * fxRate
  const currentTotalBase = holdingsBase + cashBase

  // ATH = max of all historical snapshots and current value
  const portfolioATH = snapshots.length > 0
    ? Math.max(currentTotalBase, ...snapshots.map(s => s.totalValueBase))
    : currentTotalBase

  const currentDrawdownPct = portfolioATH > 0
    ? ((currentTotalBase - portfolioATH) / portfolioATH) * 100
    : 0

  const tier1 = buildTier('Tier 1 (Ready)',   config.tier1, holdingStates, currentDrawdownPct)
  const tier2 = buildTier('Tier 2 (Reserve)', config.tier2, holdingStates, currentDrawdownPct)

  return {
    tier1,
    tier2,
    totalReserveBase:   tier1.currentValueBase + tier2.currentValueBase,
    portfolioATH,
    currentTotalBase,
    currentDrawdownPct,
    tier1Proximity: drawdownProximityPct(currentDrawdownPct, config.tier1.deployTriggerPct),
    tier2Proximity: drawdownProximityPct(currentDrawdownPct, config.tier2.deployTriggerPct),
  }
}
