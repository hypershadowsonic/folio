/**
 * rebalance.ts — pure calculation engine for DCA / rebalance trade planning.
 *
 * No React, no Dexie. All functions are pure: same inputs → same outputs.
 *
 * Exported types:
 *   HoldingState         — enriched holding snapshot used as engine input
 *   TradePlan            — single-holding trade instruction
 *   RebalancePlanResult  — full plan output with cash sufficiency
 *
 * Exported functions:
 *   calculateCurrentAllocations  — build HoldingState[] from raw Holding[]
 *   generateSoftRebalancePlan    — buy-only plan
 *   generateHardRebalancePlan    — sell overweight + buy underweight plan
 *   generateRebalancePlan        — router (soft | hard)
 */

import type { Holding } from '@/types'

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
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function toBase(amount: number, currency: 'USD' | 'TWD', fxRate: number): number {
  return currency === 'USD' ? amount * fxRate : amount
}

function fromBase(amountBase: number, currency: 'USD' | 'TWD', fxRate: number): number {
  return currency === 'USD' ? amountBase / fxRate : amountBase
}

/**
 * Recompute projectedAllocationPct for every holding given a list of share deltas.
 * deltas: Map<holdingId, additionalShares> — positive for BUY, negative for SELL.
 */

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

// ─── calculateCurrentAllocations ──────────────────────────────────────────────

/**
 * Build a HoldingState[] from raw Holding records, enriched with allocation
 * percentages and drift. Sorted ascending by drift (most underweight first).
 */
export function calculateCurrentAllocations(
  holdings: Holding[],
  cashBalances: { twd: number; usd: number },
  fxRate: number,
): HoldingState[] {
  // Compute each holding's market value
  const withMv = holdings.map(h => {
    const shares = h.currentShares ?? 0
    const price  = h.currentPricePerShare ?? 0
    const marketValue     = shares * price
    const marketValueBase = toBase(marketValue, h.currency, fxRate)
    return { h, shares, price, marketValue, marketValueBase }
  })

  const cashBase = cashBalances.twd + cashBalances.usd * fxRate
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
 * holdings; overweight holdings get HOLD with suggestedShares = 0.
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

  // Underweight holdings only participate in buy allocation
  const underweight = holdings.filter(h => h.drift < 0)

  // Compute budget shares per holding (in TWD)
  const allocatedBase = new Map<string, number>()

  if (underweight.length > 0 && budget > 0) {
    if (allocationMethod === 'proportional-to-drift') {
      const totalAbsDrift = underweight.reduce((s, h) => s + Math.abs(h.drift), 0)
      for (const h of underweight) {
        const share = Math.abs(h.drift) / totalAbsDrift
        allocatedBase.set(h.holdingId, share * budgetBase)
      }
    } else {
      // equal-weight
      const perHolding = budgetBase / underweight.length
      for (const h of underweight) {
        allocatedBase.set(h.holdingId, perHolding)
      }
    }
  }

  // Build trade plans
  const deltas = new Map<string, number>()
  const buyCost = { usd: 0, twd: 0 }

  const trades: TradePlan[] = holdings.map(h => {
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
        projectedAllocationPct: 0,   // filled after projection pass
        reason: h.drift > 0
          ? `Overweight by ${h.drift.toFixed(1)}% — no action (soft strategy)`
          : `At target`,
      } satisfies TradePlan
    }

    const allocAmount   = fromBase(allocBase, h.currency, fxRate)
    const shares        = allocAmount / h.currentPricePerShare
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
      reason: `Underweight by ${Math.abs(h.drift).toFixed(1)}%`,
    } satisfies TradePlan
  })

  // Compute projected allocations using new portfolio total
  // (project against the new total which includes the budget injection)
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
  }
}

// ─── generateHardRebalancePlan ────────────────────────────────────────────────

/**
 * Hard rebalance: sell overweight holdings back to target, then buy underweight
 * holdings using sell proceeds + existing cash + budget.
 *
 * Sell proceeds are per-currency — they don't cross currencies automatically.
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

  const sellTrades = new Map<string, { shares: number; amount: number; amountBase: number }>()
  const sellProceeds = { usd: 0, twd: 0 }

  for (const h of holdings) {
    if (h.drift <= 0) continue

    // Excess value to trim back to target
    const excessBase    = (h.drift / 100) * currentPortfolioBase
    const excessAmount  = fromBase(excessBase, h.currency, fxRate)
    const sharesToSell  = Math.min(
      excessAmount / h.currentPricePerShare,
      h.currentShares,   // can't sell more than we own
    )
    const actualAmount  = sharesToSell * h.currentPricePerShare
    const actualBase    = toBase(actualAmount, h.currency, fxRate)

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

  const underweight = holdings.filter(h => h.drift < 0)

  // Buyable resources = sell proceeds (base) + injected budget (base)
  const budgetBase  = toBase(budget, budgetCurrency, fxRate)
  const buyableBase = toBase(sellProceeds.usd, 'USD', fxRate)
    + sellProceeds.twd + budgetBase

  const allocatedBase = new Map<string, number>()

  if (underweight.length > 0 && buyableBase > 0) {
    if (allocationMethod === 'proportional-to-drift') {
      const totalAbsDrift = underweight.reduce((s, h) => s + Math.abs(h.drift), 0)
      for (const h of underweight) {
        const share = Math.abs(h.drift) / totalAbsDrift
        allocatedBase.set(h.holdingId, share * buyableBase)
      }
    } else {
      const perHolding = buyableBase / underweight.length
      for (const h of underweight) {
        allocatedBase.set(h.holdingId, perHolding)
      }
    }
  }

  // ── Step 4: Build TradePlan[] ──────────────────────────────────────────────

  const deltas  = new Map<string, number>()
  const buyCost = { usd: 0, twd: 0 }

  const trades: TradePlan[] = holdings.map(h => {
    const sell = sellTrades.get(h.holdingId)
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
      // Underweight → BUY
      const allocAmount = fromBase(allocBase, h.currency, fxRate)
      const shares      = allocAmount / h.currentPricePerShare
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
        reason: `Underweight by ${Math.abs(h.drift).toFixed(1)}%`,
      } satisfies TradePlan
    }

    // At target
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
      reason: `At target`,
    } satisfies TradePlan
  })

  // ── Step 5: Project allocations ────────────────────────────────────────────
  // Portfolio value is unchanged by rebalance (sells → cash → buys).
  // Budget injection increases total by budgetBase.
  const projectedTotal = currentPortfolioBase + budgetBase
  const projMap = projectAllocationsWithTotal(holdings, deltas, projectedTotal, fxRate)
  for (const t of trades) {
    t.projectedAllocationPct = projMap.get(t.holdingId) ?? t.currentAllocationPct
  }

  // ── Step 6: Cash sufficiency — check per-currency net ─────────────────────
  // Buys must be coverable by availableUsd/availableTwd (which already includes proceeds)
  const cashSufficiency = checkCashSufficiency(buyCost, availableUsd, availableTwd, fxRate)

  // Net cash flow per currency
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
  }
}

// ─── Projection helper (uses explicit portfolio total) ────────────────────────

/**
 * Like projectAllocations but takes an explicit projected portfolio total
 * instead of re-computing it from cash balances. Used by both soft and hard
 * planners so the budget injection is correctly reflected.
 */
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

/**
 * Router: delegates to soft or hard planner based on strategy.
 */
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
