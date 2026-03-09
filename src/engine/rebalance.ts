/**
 * rebalance.ts — pure calculation engine for DCA / rebalance trade planning.
 *
 * No React, no Dexie. All functions are pure: same inputs → same outputs.
 *
 * Exported types:
 *   HoldingState         — enriched holding snapshot used as engine input
 *   TradePlan            — single-holding trade instruction
 *   RebalancePlanResult  — full plan output with cash sufficiency + warnings
 *
 * Exported functions:
 *   calculateCurrentAllocations  — build HoldingState[] from raw Holding[]
 *   generateSoftRebalancePlan    — buy-only plan
 *   generateHardRebalancePlan    — sell overweight + buy underweight plan
 *   generateRebalancePlan        — router (soft | hard)
 *
 * Edge cases handled:
 *   - price = 0: holding skipped (HOLD with "No price data" reason)
 *   - dust: shares < DUST_SHARES → HOLD with "Amount too small" reason
 *   - all at target (drift = 0): soft/hard fall back to target-proportional weighting
 *   - all overweight: soft generates no buys (all HOLD)
 *   - cross-currency: TWD sell proceeds never automatically fund USD buys
 *   - empty portfolio: allocations normalise to target-pct when totalBase = 0
 */

import type { Holding } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Holdings producing fewer than this many shares are treated as dust and HOLDed. */
export const DUST_SHARES = 0.0001

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface HoldingState {
  holdingId: string
  ticker: string
  sleeveId: string
  currency: 'USD' | 'TWD'
  currentShares: number
  currentPricePerShare: number
  targetAllocationPct: number   // 0-100
  currentAllocationPct: number  // 0-100 (calculated)
  drift: number                 // currentAllocationPct - targetAllocationPct
  marketValue: number           // shares × price, in holding's currency
  marketValueBase: number       // in TWD
}

export interface TradePlan {
  holdingId: string
  ticker: string
  currency: 'USD' | 'TWD'
  action: 'BUY' | 'SELL' | 'HOLD'
  suggestedShares: number        // fractional allowed
  suggestedAmount: number        // in holding's currency
  suggestedAmountBase: number    // in TWD
  currentAllocationPct: number
  targetAllocationPct: number
  projectedAllocationPct: number // after this trade executes
  reason: string                 // e.g. "Underweight by 3.2%"
}

export interface RebalancePlanResult {
  trades: TradePlan[]
  totalBuyCost:     { usd: number; twd: number }
  totalSellProceeds:{ usd: number; twd: number }
  netCashFlow:      { usd: number; twd: number }  // negative = outflow (need cash)
  cashSufficiency: {
    sufficient: boolean
    shortfalls: {
      currency: 'USD' | 'TWD'
      needed: number
      available: number
      shortfall: number
      shortfallConvertedHint: string
    }[]
  }
  /** Human-readable advisories about skipped holdings or dust trades. */
  warnings: string[]
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function toBase(amount: number, currency: 'USD' | 'TWD', fxRate: number): number {
  return currency === 'USD' ? amount * fxRate : amount
}

function fromBase(amountBase: number, currency: 'USD' | 'TWD', fxRate: number): number {
  return currency === 'USD' ? amountBase / fxRate : amountBase
}

/**
 * Build cash sufficiency result given per-currency buy costs, sell proceeds, and available cash.
 * budgetCurrency + budget is already factored into availableUsd/availableTwd by callers.
 */
function checkCashSufficiency(
  buyCost: { usd: number; twd: number },
  availableUsd: number,
  availableTwd: number,
  fxRate: number,
): RebalancePlanResult['cashSufficiency'] {
  const shortfalls: RebalancePlanResult['cashSufficiency']['shortfalls'] = []

  if (buyCost.usd > availableUsd + 1e-9) {
    const shortfall = buyCost.usd - availableUsd
    shortfalls.push({
      currency: 'USD',
      needed: buyCost.usd,
      available: availableUsd,
      shortfall,
      shortfallConvertedHint: `Need additional $${shortfall.toFixed(2)} USD — convert ~TWD ${Math.ceil(shortfall * fxRate).toLocaleString()}`,
    })
  }

  if (buyCost.twd > availableTwd + 1e-9) {
    const shortfall = buyCost.twd - availableTwd
    shortfalls.push({
      currency: 'TWD',
      needed: buyCost.twd,
      available: availableTwd,
      shortfall,
      shortfallConvertedHint: `Need additional NT$${Math.ceil(shortfall).toLocaleString()} TWD — convert ~$${(shortfall / fxRate).toFixed(2)} USD`,
    })
  }

  return { sufficient: shortfalls.length === 0, shortfalls }
}

/**
 * Determine budget weights for the eligible set, using the selected method.
 *
 * Proportional-to-drift falls back to proportional-to-target when all eligible
 * drifts are zero (e.g. single holding at target, or all holdings at target).
 * This prevents NaN from a 0/0 division and ensures budget is always invested.
 */
function computeWeights(
  eligible: HoldingState[],
  allocationMethod: 'proportional-to-drift' | 'equal-weight',
): Map<string, number> {
  const weights = new Map<string, number>()
  if (eligible.length === 0) return weights

  if (allocationMethod === 'equal-weight') {
    const w = 1 / eligible.length
    for (const h of eligible) weights.set(h.holdingId, w)
    return weights
  }

  // proportional-to-drift
  const totalAbsDrift = eligible.reduce((s, h) => s + Math.abs(h.drift), 0)
  if (totalAbsDrift > 0) {
    for (const h of eligible) {
      weights.set(h.holdingId, Math.abs(h.drift) / totalAbsDrift)
    }
  } else {
    // All eligible holdings are at target (drift = 0).
    // Fall back to proportional-to-target so budget is invested proportionally.
    const totalTarget = eligible.reduce((s, h) => s + h.targetAllocationPct, 0)
    const denominator = totalTarget > 0 ? totalTarget : eligible.length
    for (const h of eligible) {
      weights.set(h.holdingId, totalTarget > 0 ? h.targetAllocationPct / denominator : 1 / eligible.length)
    }
  }
  return weights
}

// ─── calculateCurrentAllocations ──────────────────────────────────────────────

/**
 * Build a HoldingState[] from raw Holding records, enriched with allocation
 * percentages and drift. Sorted ascending by drift (most underweight first).
 *
 * Holdings with no price (currentPricePerShare = 0 or undefined) are included
 * in the output — callers must check currentPricePerShare > 0 before trading.
 */
export function calculateCurrentAllocations(
  holdings: Holding[],
  cashBalances: { twd: number; usd: number },
  fxRate: number,
): HoldingState[] {
  const withMv = holdings.map(h => {
    const shares = h.currentShares ?? 0
    const price  = h.currentPricePerShare ?? 0
    const marketValue     = shares * price
    const marketValueBase = toBase(marketValue, h.currency, fxRate)
    return { h, shares, price, marketValue, marketValueBase }
  })

  const cashBase  = cashBalances.twd + cashBalances.usd * fxRate
  const totalBase = withMv.reduce((s, v) => s + v.marketValueBase, 0) + cashBase

  return withMv
    .map(({ h, shares, price, marketValue, marketValueBase }) => {
      const currentAllocationPct = totalBase > 0 ? (marketValueBase / totalBase) * 100 : 0
      const drift = currentAllocationPct - h.targetAllocationPct
      return {
        holdingId:            h.id,
        ticker:               h.ticker,
        sleeveId:             h.sleeveId,
        currency:             h.currency,
        currentShares:        shares,
        currentPricePerShare: price,
        targetAllocationPct:  h.targetAllocationPct,
        currentAllocationPct,
        drift,
        marketValue,
        marketValueBase,
      } satisfies HoldingState
    })
    .sort((a, b) => a.drift - b.drift)  // most underweight first
}

// ─── generateSoftRebalancePlan ────────────────────────────────────────────────

/**
 * Soft rebalance: buy-only. Allocates the provided budget across underweight
 * holdings. When no holdings are underweight, falls back to at-target (drift = 0)
 * holdings so budget is never silently discarded (handles single-holding and
 * all-at-target portfolios). Overweight holdings always get HOLD.
 *
 * Holdings with price = 0 are always HOLDed with a warning.
 * Trades below DUST_SHARES threshold are HOLDed with a warning.
 */
export function generateSoftRebalancePlan(
  holdings: HoldingState[],
  budget: number,
  budgetCurrency: 'USD' | 'TWD',
  fxRate: number,
  allocationMethod: 'proportional-to-drift' | 'equal-weight',
  cashBalances: { twd: number; usd: number },
): RebalancePlanResult {
  const budgetBase = toBase(budget, budgetCurrency, fxRate)

  // Total portfolio value after the budget injection
  const currentBase = holdings.reduce((s, h) => s + h.marketValueBase, 0)
    + cashBalances.twd + cashBalances.usd * fxRate
  const projectedPortfolioBase = currentBase + budgetBase

  // Holdings with a known price are eligible for trading
  const priceable  = holdings.filter(h => h.currentPricePerShare > 0)
  const underweight = priceable.filter(h => h.drift < 0)

  // When no holdings are underweight, invest into at-target (drift ≤ 0) holdings.
  // Overweight (drift > 0) holdings are NEVER bought in soft strategy.
  const eligible = underweight.length > 0
    ? underweight
    : priceable.filter(h => h.drift <= 0)

  // Allocate budget (in TWD base) across eligible holdings
  const allocatedBase = new Map<string, number>()
  if (eligible.length > 0 && budget > 0) {
    const weights = computeWeights(eligible, allocationMethod)
    for (const h of eligible) {
      allocatedBase.set(h.holdingId, (weights.get(h.holdingId) ?? 0) * budgetBase)
    }
  }

  // Build trade plans
  const deltas  = new Map<string, number>()
  const buyCost = { usd: 0, twd: 0 }
  const warnings: string[] = []

  const noPriceCount = holdings.length - priceable.length
  if (noPriceCount > 0) {
    warnings.push(
      `${noPriceCount} holding${noPriceCount > 1 ? 's' : ''} skipped — no price data. Update prices on Dashboard first.`,
    )
  }

  let dustCount = 0

  const trades: TradePlan[] = holdings.map(h => {
    // Cannot trade a holding without a price
    if (h.currentPricePerShare <= 0) {
      return {
        holdingId:              h.holdingId,
        ticker:                 h.ticker,
        currency:               h.currency,
        action:                 'HOLD',
        suggestedShares:        0,
        suggestedAmount:        0,
        suggestedAmountBase:    0,
        currentAllocationPct:   h.currentAllocationPct,
        targetAllocationPct:    h.targetAllocationPct,
        projectedAllocationPct: 0,
        reason: 'No price data — update on Dashboard',
      } satisfies TradePlan
    }

    const allocBase = allocatedBase.get(h.holdingId) ?? 0

    if (allocBase <= 0) {
      return {
        holdingId:              h.holdingId,
        ticker:                 h.ticker,
        currency:               h.currency,
        action:                 'HOLD',
        suggestedShares:        0,
        suggestedAmount:        0,
        suggestedAmountBase:    0,
        currentAllocationPct:   h.currentAllocationPct,
        targetAllocationPct:    h.targetAllocationPct,
        projectedAllocationPct: 0,
        reason: h.drift > 0
          ? `Overweight by ${h.drift.toFixed(1)}% — no action (soft strategy)`
          : 'At target',
      } satisfies TradePlan
    }

    const allocAmount = fromBase(allocBase, h.currency, fxRate)
    const shares      = allocAmount / h.currentPricePerShare

    // Dust guard: skip trades below minimum share threshold
    if (shares < DUST_SHARES) {
      dustCount++
      return {
        holdingId:              h.holdingId,
        ticker:                 h.ticker,
        currency:               h.currency,
        action:                 'HOLD',
        suggestedShares:        0,
        suggestedAmount:        0,
        suggestedAmountBase:    0,
        currentAllocationPct:   h.currentAllocationPct,
        targetAllocationPct:    h.targetAllocationPct,
        projectedAllocationPct: 0,
        reason: `Amount too small (< ${DUST_SHARES} shares) — try a larger budget`,
      } satisfies TradePlan
    }

    deltas.set(h.holdingId, shares)
    if (h.currency === 'USD') buyCost.usd += allocAmount
    else                      buyCost.twd += allocAmount

    return {
      holdingId:              h.holdingId,
      ticker:                 h.ticker,
      currency:               h.currency,
      action:                 'BUY',
      suggestedShares:        shares,
      suggestedAmount:        allocAmount,
      suggestedAmountBase:    allocBase,
      currentAllocationPct:   h.currentAllocationPct,
      targetAllocationPct:    h.targetAllocationPct,
      projectedAllocationPct: 0,   // filled below
      reason: h.drift < 0
        ? `Underweight by ${Math.abs(h.drift).toFixed(1)}%`
        : 'At target — investing budget',
    } satisfies TradePlan
  })

  if (dustCount > 0) {
    warnings.push(
      `${dustCount} trade${dustCount > 1 ? 's' : ''} below dust threshold (< ${DUST_SHARES} shares) — budget may be too small`,
    )
  }

  // Projected allocations (portfolio total includes the budget injection)
  const projMap = projectAllocationsWithTotal(holdings, deltas, projectedPortfolioBase, fxRate)
  for (const t of trades) {
    t.projectedAllocationPct = projMap.get(t.holdingId) ?? t.currentAllocationPct
  }

  // Cash sufficiency: budget increases available cash in budgetCurrency
  const availableUsd = cashBalances.usd + (budgetCurrency === 'USD' ? budget : 0)
  const availableTwd = cashBalances.twd + (budgetCurrency === 'TWD' ? budget : 0)

  return {
    trades,
    totalBuyCost:      buyCost,
    totalSellProceeds: { usd: 0, twd: 0 },
    netCashFlow: { usd: -buyCost.usd, twd: -buyCost.twd },
    cashSufficiency:   checkCashSufficiency(buyCost, availableUsd, availableTwd, fxRate),
    warnings,
  }
}

// ─── generateHardRebalancePlan ────────────────────────────────────────────────

/**
 * Hard rebalance: sell overweight holdings back to target, then buy underweight
 * holdings using sell proceeds + existing cash + budget.
 *
 * Sell proceeds are per-currency — they don't cross currencies automatically.
 * Holdings with price = 0 are skipped for both sells and buys.
 * Trades below DUST_SHARES threshold are HOLDed with a warning.
 */
export function generateHardRebalancePlan(
  holdings: HoldingState[],
  budget: number,
  budgetCurrency: 'USD' | 'TWD',
  fxRate: number,
  allocationMethod: 'proportional-to-drift' | 'equal-weight',
  cashBalances: { twd: number; usd: number },
): RebalancePlanResult {
  const currentPortfolioBase = holdings.reduce((s, h) => s + h.marketValueBase, 0)
    + cashBalances.twd + cashBalances.usd * fxRate

  // ── Step 1: Sell plans for overweight holdings ─────────────────────────────

  const sellTrades   = new Map<string, { shares: number; amount: number; amountBase: number }>()
  const sellProceeds = { usd: 0, twd: 0 }

  for (const h of holdings) {
    if (h.drift <= 0) continue
    // Cannot sell a holding without a price — skip silently (warned in warnings array)
    if (h.currentPricePerShare <= 0) continue

    const excessBase   = (h.drift / 100) * currentPortfolioBase
    const excessAmount = fromBase(excessBase, h.currency, fxRate)
    const sharesToSell = Math.min(
      excessAmount / h.currentPricePerShare,
      h.currentShares,   // can't sell more than we own
    )
    const actualAmount = sharesToSell * h.currentPricePerShare
    const actualBase   = toBase(actualAmount, h.currency, fxRate)

    sellTrades.set(h.holdingId, { shares: sharesToSell, amount: actualAmount, amountBase: actualBase })

    if (h.currency === 'USD') sellProceeds.usd += actualAmount
    else                      sellProceeds.twd += actualAmount
  }

  // ── Step 2: Available cash for buys = existing + budget + sell proceeds ────

  const availableUsd = cashBalances.usd
    + (budgetCurrency === 'USD' ? budget : 0)
    + sellProceeds.usd
  const availableTwd = cashBalances.twd
    + (budgetCurrency === 'TWD' ? budget : 0)
    + sellProceeds.twd

  // ── Step 3: Buy plans for underweight holdings ─────────────────────────────

  const priceable      = holdings.filter(h => h.currentPricePerShare > 0)
  const underweightP   = priceable.filter(h => h.drift < 0 && !sellTrades.has(h.holdingId))
  // Same fallback as soft: when no underweight, invest into at-target holdings
  const eligibleP = underweightP.length > 0
    ? underweightP
    : priceable.filter(h => h.drift <= 0 && !sellTrades.has(h.holdingId))

  // Buyable resources = sell proceeds (base) + injected budget (base)
  const budgetBase  = toBase(budget, budgetCurrency, fxRate)
  const buyableBase = toBase(sellProceeds.usd, 'USD', fxRate)
    + sellProceeds.twd + budgetBase

  const allocatedBase = new Map<string, number>()
  if (eligibleP.length > 0 && buyableBase > 0) {
    const weights = computeWeights(eligibleP, allocationMethod)
    for (const h of eligibleP) {
      allocatedBase.set(h.holdingId, (weights.get(h.holdingId) ?? 0) * buyableBase)
    }
  }

  // ── Step 4: Build TradePlan[] ──────────────────────────────────────────────

  const deltas  = new Map<string, number>()
  const buyCost = { usd: 0, twd: 0 }
  const warnings: string[] = []

  const noPriceCount = holdings.length - priceable.length
  if (noPriceCount > 0) {
    warnings.push(
      `${noPriceCount} holding${noPriceCount > 1 ? 's' : ''} skipped — no price data. Update prices on Dashboard first.`,
    )
  }

  let dustCount = 0

  const trades: TradePlan[] = holdings.map(h => {
    // Cannot trade a holding without a price
    if (h.currentPricePerShare <= 0) {
      return {
        holdingId:              h.holdingId,
        ticker:                 h.ticker,
        currency:               h.currency,
        action:                 'HOLD',
        suggestedShares:        0,
        suggestedAmount:        0,
        suggestedAmountBase:    0,
        currentAllocationPct:   h.currentAllocationPct,
        targetAllocationPct:    h.targetAllocationPct,
        projectedAllocationPct: 0,
        reason: 'No price data — update on Dashboard',
      } satisfies TradePlan
    }

    const sell      = sellTrades.get(h.holdingId)
    const allocBase = allocatedBase.get(h.holdingId) ?? 0

    if (sell) {
      // Overweight → SELL
      deltas.set(h.holdingId, -sell.shares)
      return {
        holdingId:              h.holdingId,
        ticker:                 h.ticker,
        currency:               h.currency,
        action:                 'SELL',
        suggestedShares:        sell.shares,
        suggestedAmount:        sell.amount,
        suggestedAmountBase:    sell.amountBase,
        currentAllocationPct:   h.currentAllocationPct,
        targetAllocationPct:    h.targetAllocationPct,
        projectedAllocationPct: 0,
        reason: `Overweight by ${h.drift.toFixed(1)}% — trim to target`,
      } satisfies TradePlan
    }

    if (allocBase > 0) {
      // Underweight (or at-target fallback) → BUY
      const allocAmount = fromBase(allocBase, h.currency, fxRate)
      const shares      = allocAmount / h.currentPricePerShare

      // Dust guard
      if (shares < DUST_SHARES) {
        dustCount++
        return {
          holdingId:              h.holdingId,
          ticker:                 h.ticker,
          currency:               h.currency,
          action:                 'HOLD',
          suggestedShares:        0,
          suggestedAmount:        0,
          suggestedAmountBase:    0,
          currentAllocationPct:   h.currentAllocationPct,
          targetAllocationPct:    h.targetAllocationPct,
          projectedAllocationPct: 0,
          reason: `Amount too small (< ${DUST_SHARES} shares) — try a larger budget`,
        } satisfies TradePlan
      }

      deltas.set(h.holdingId, shares)
      if (h.currency === 'USD') buyCost.usd += allocAmount
      else                      buyCost.twd += allocAmount

      return {
        holdingId:              h.holdingId,
        ticker:                 h.ticker,
        currency:               h.currency,
        action:                 'BUY',
        suggestedShares:        shares,
        suggestedAmount:        allocAmount,
        suggestedAmountBase:    allocBase,
        currentAllocationPct:   h.currentAllocationPct,
        targetAllocationPct:    h.targetAllocationPct,
        projectedAllocationPct: 0,
        reason: h.drift < 0
          ? `Underweight by ${Math.abs(h.drift).toFixed(1)}%`
          : 'At target — investing budget',
      } satisfies TradePlan
    }

    // At target or overweight with no sell (shouldn't be overweight without sell unless price=0)
    return {
      holdingId:              h.holdingId,
      ticker:                 h.ticker,
      currency:               h.currency,
      action:                 'HOLD',
      suggestedShares:        0,
      suggestedAmount:        0,
      suggestedAmountBase:    0,
      currentAllocationPct:   h.currentAllocationPct,
      targetAllocationPct:    h.targetAllocationPct,
      projectedAllocationPct: 0,
      reason: h.drift > 0 ? `Overweight by ${h.drift.toFixed(1)}% — trim to target` : 'At target',
    } satisfies TradePlan
  })

  if (dustCount > 0) {
    warnings.push(
      `${dustCount} trade${dustCount > 1 ? 's' : ''} below dust threshold (< ${DUST_SHARES} shares) — budget may be too small`,
    )
  }

  // ── Step 5: Project allocations ────────────────────────────────────────────
  const projectedTotal = currentPortfolioBase + budgetBase
  const projMap = projectAllocationsWithTotal(holdings, deltas, projectedTotal, fxRate)
  for (const t of trades) {
    t.projectedAllocationPct = projMap.get(t.holdingId) ?? t.currentAllocationPct
  }

  // ── Step 6: Cash sufficiency — check per-currency net ─────────────────────
  const cashSufficiency = checkCashSufficiency(buyCost, availableUsd, availableTwd, fxRate)

  const netCashFlow = {
    usd: sellProceeds.usd - buyCost.usd,
    twd: sellProceeds.twd - buyCost.twd,
  }

  return {
    trades,
    totalBuyCost:      buyCost,
    totalSellProceeds: sellProceeds,
    netCashFlow,
    cashSufficiency,
    warnings,
  }
}

// ─── Projection helper (uses explicit portfolio total) ────────────────────────

function projectAllocationsWithTotal(
  holdings: HoldingState[],
  deltas: Map<string, number>,
  projectedPortfolioBase: number,
  fxRate: number,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const h of holdings) {
    const delta     = deltas.get(h.holdingId) ?? 0
    const newShares = h.currentShares + delta
    const mv        = newShares * h.currentPricePerShare
    const mvBase    = toBase(mv, h.currency, fxRate)
    result.set(
      h.holdingId,
      projectedPortfolioBase > 0 ? (mvBase / projectedPortfolioBase) * 100 : 0,
    )
  }
  return result
}

// ─── generateRebalancePlan ────────────────────────────────────────────────────

/** Router: delegates to soft or hard planner based on strategy. */
export function generateRebalancePlan(
  holdings: HoldingState[],
  budget: number,
  budgetCurrency: 'USD' | 'TWD',
  fxRate: number,
  strategy: 'soft' | 'hard',
  allocationMethod: 'proportional-to-drift' | 'equal-weight',
  cashBalances: { twd: number; usd: number },
): RebalancePlanResult {
  return strategy === 'soft'
    ? generateSoftRebalancePlan(holdings, budget, budgetCurrency, fxRate, allocationMethod, cashBalances)
    : generateHardRebalancePlan(holdings, budget, budgetCurrency, fxRate, allocationMethod, cashBalances)
}
