/**
 * snapshotService — computes a full PortfolioSnapshot from current DB state.
 *
 * Used by:
 *   - Every operation's before/after snapshot (Phase 3)
 *   - Weekly auto-snapshot service worker (Phase 7)
 *
 * Pure reads — no writes. Callers that need atomicity should open their own
 * db.transaction and call this inside it (all tables listed below must be
 * included in the transaction scope).
 *
 * Tables read: portfolios, holdings, cashAccounts, fxTransactions, fxLots
 */

import { db } from '@/db'
import { getLatestFxRate } from '@/engine/fifo'
import type { HoldingSnapshot, PortfolioSnapshot } from '@/types'

// ─── FX rate resolution ───────────────────────────────────────────────────────

/**
 * Resolves the best available TWD/USD rate for the portfolio using a three-tier
 * fallback chain:
 *   1. Latest FxLot rate  (created by real recordFxExchange operations)
 *   2. Latest FxTransaction rate  (includes the zero-amount setup anchor)
 *   3. portfolio.initialFxRate  (last-resort fallback stored at wizard time)
 *
 * Returns 1 if nothing is found (avoids division by zero; caller should warn).
 */
export async function resolveCurrentFxRate(portfolioId: string): Promise<number> {
  // Tier 0: explicit user override — always wins
  const portfolio = await db.portfolios.get(portfolioId)
  if (portfolio?.fxRateOverride && portfolio.fxRateOverride > 0) {
    return portfolio.fxRateOverride
  }

  // Tier 1: FxLots — created by real FX exchange operations
  const txIds = (await db.fxTransactions
    .where('portfolioId')
    .equals(portfolioId)
    .primaryKeys()) as string[]

  if (txIds.length > 0) {
    const lots = await db.fxLots
      .where('fxTransactionId')
      .anyOf(txIds)
      .sortBy('timestamp')

    const rateFromLots = getLatestFxRate(lots)
    if (rateFromLots != null) return rateFromLots

    // Tier 2: FxTransactions (includes zero-amount setup anchor)
    const latestTx = await db.fxTransactions
      .where('portfolioId')
      .equals(portfolioId)
      .reverse()   // newest first by insertion order (timestamp not indexed asc/desc directly)
      .sortBy('timestamp')
      .then(txs => txs[txs.length - 1])  // last = newest after ascending sort

    if (latestTx && latestTx.rate > 0) return latestTx.rate
  }

  // Tier 3: stored on portfolio at wizard time (portfolio already loaded above)
  if (portfolio?.initialFxRate && portfolio.initialFxRate > 0) {
    return portfolio.initialFxRate
  }

  return 1  // ultimate fallback — avoids NaN/Infinity in downstream math
}

// ─── captureSnapshot ──────────────────────────────────────────────────────────

/**
 * Reads the current portfolio state directly from denormalized holding fields
 * (currentShares, currentPricePerShare, averageCostBasis, averageCostBasisBase)
 * rather than replaying operations. This ensures snapshotAfter always reflects
 * the just-completed trade, since updateHoldingOnBuy/Sell write these fields
 * before captureSnapshot is called inside createTradeOperation.
 */
export async function captureSnapshot(portfolioId: string): Promise<PortfolioSnapshot> {
  const [holdings, cashAccounts] = await Promise.all([
    db.holdings.where('portfolioId').equals(portfolioId).toArray(),
    db.cashAccounts.where('portfolioId').equals(portfolioId).toArray(),
  ])

  const fxRate = await resolveCurrentFxRate(portfolioId)

  // ── Cash values ────────────────────────────────────────────────────────────

  const twdBalance    = cashAccounts.find(a => a.currency === 'TWD')?.balance ?? 0
  const usdBalance    = cashAccounts.find(a => a.currency === 'USD')?.balance ?? 0
  const cashValueBase = twdBalance + usdBalance * fxRate

  // ── Per-holding market values ──────────────────────────────────────────────
  // currentShares / currentPricePerShare / averageCostBasis / averageCostBasisBase
  // are updated by updateHoldingOnBuy / updateHoldingOnSell before captureSnapshot
  // is called, so these values reflect the post-trade state correctly.

  const holdingValues = holdings.map(h => {
    const shares      = h.currentShares        ?? 0
    const price       = h.currentPricePerShare  ?? 0
    const avgCost     = h.averageCostBasis      ?? 0
    const avgCostBase = h.averageCostBasisBase  ?? 0

    const marketValue     = shares * price
    const marketValueBase = h.currency === 'USD' ? marketValue * fxRate : marketValue
    const costBasis       = shares * avgCost
    const costBasisBase   = shares * avgCostBase

    return { h, shares, price, marketValue, marketValueBase, costBasis, costBasisBase }
  })

  const holdingsValueBase = holdingValues.reduce((s, v) => s + v.marketValueBase, 0)
  const totalValueBase    = holdingsValueBase + cashValueBase

  // ── Build HoldingSnapshot[] ────────────────────────────────────────────────

  const holdingSnapshots: HoldingSnapshot[] = holdingValues.map(
    ({ h, shares, price, marketValue, marketValueBase, costBasis, costBasisBase }) => {
      const allocationPct   = holdingsValueBase > 0
        ? (marketValueBase / holdingsValueBase) * 100
        : 0
      const driftFromTarget = allocationPct - h.targetAllocationPct

      return {
        holdingId:     h.id,
        shares,
        pricePerShare: price,
        marketValue,
        marketValueBase,
        costBasis,
        costBasisBase,
        allocationPct,
        driftFromTarget,
      }
    }
  )

  const snap: PortfolioSnapshot = {
    timestamp:     new Date(),
    totalValueBase,
    currentFxRate: fxRate,
    cashBalances:  cashAccounts.map(a => ({ currency: a.currency, balance: a.balance })),
    holdings:      holdingSnapshots,
  }

  console.log('[captureSnapshot] captured:', {
    timestamp: snap.timestamp.toISOString(),
    totalValueBase: snap.totalValueBase.toFixed(2),
    holdings: snap.holdings.length,
  })

  return snap
}
