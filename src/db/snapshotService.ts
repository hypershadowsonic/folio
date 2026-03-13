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
 * Tables read: portfolios, holdings, cashAccounts, operations, fxTransactions,
 *              fxLots
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

// ─── Holding state accumulator ────────────────────────────────────────────────

interface HoldingAccum {
  shares: number
  costBasis: number       // in holding's native currency (USD or TWD)
  costBasisBase: number   // in TWD
  lastPrice: number       // most recent pricePerShare seen, in holding's currency
  lastPriceTs: number     // epoch ms of the operation that set lastPrice
}

// ─── captureSnapshot ──────────────────────────────────────────────────────────

export async function captureSnapshot(portfolioId: string): Promise<PortfolioSnapshot> {
  // Parallel reads (safe — read-only, no transaction needed for consistency here)
  const [holdings, cashAccounts, operations] = await Promise.all([
    db.holdings.where('portfolioId').equals(portfolioId).toArray(),
    db.cashAccounts.where('portfolioId').equals(portfolioId).toArray(),
    // Sort ascending so we accumulate in chronological order
    db.operations
      .where('[portfolioId+timestamp]')
      .between([portfolioId, new Date(0)], [portfolioId, new Date('9999-12-31')])
      .toArray()
      .then(ops => ops.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      )),
  ])

  const fxRate = await resolveCurrentFxRate(portfolioId)

  // ── Per-holding state: accumulated from operation entries ──────────────────

  const accumMap = new Map<string, HoldingAccum>(
    holdings.map(h => [h.id, {
      shares: 0,
      costBasis: 0,
      costBasisBase: 0,
      lastPrice: 0,
      lastPriceTs: 0,
    }])
  )

  for (const op of operations) {
    const opTs = new Date(op.timestamp).getTime()

    for (const entry of op.entries) {
      const accum = accumMap.get(entry.holdingId)
      if (!accum) continue  // holding no longer in portfolio (shouldn't happen in MVP)

      // Update last known price (use the entry's timestamp via the operation)
      if (opTs >= accum.lastPriceTs) {
        accum.lastPrice = entry.pricePerShare
        accum.lastPriceTs = opTs
      }

      if (entry.side === 'BUY') {
        const grossCost = entry.shares * entry.pricePerShare + entry.fees
        accum.shares    += entry.shares
        accum.costBasis += grossCost

        if (entry.fxCostBasis) {
          // USD holding purchased with TWD via FIFO lots
          accum.costBasisBase += entry.fxCostBasis.baseCurrencyCost
        } else {
          // TWD-denominated holding — cost is already in base currency
          accum.costBasisBase += grossCost
        }
      } else {
        // SELL — reduce shares and cost basis proportionally (average cost method)
        if (accum.shares > 0) {
          const avgCost     = accum.costBasis     / accum.shares
          const avgCostBase = accum.costBasisBase / accum.shares
          accum.costBasis     -= avgCost     * entry.shares
          accum.costBasisBase -= avgCostBase * entry.shares
        }
        accum.shares = Math.max(0, accum.shares - entry.shares)
      }
    }
  }

  // ── Cash values ────────────────────────────────────────────────────────────

  const twdBalance = cashAccounts.find(a => a.currency === 'TWD')?.balance ?? 0
  const usdBalance = cashAccounts.find(a => a.currency === 'USD')?.balance ?? 0
  const cashValueBase = twdBalance + usdBalance * fxRate

  // ── Per-holding market values ──────────────────────────────────────────────

  const holdingValues = holdings.map(h => {
    const accum = accumMap.get(h.id)!
    const marketValue     = accum.shares * accum.lastPrice
    const marketValueBase = h.currency === 'USD'
      ? marketValue * fxRate
      : marketValue                  // TWD holding — already in base currency
    return { holding: h, accum, marketValue, marketValueBase }
  })

  const holdingsValueBase = holdingValues.reduce((s, v) => s + v.marketValueBase, 0)
  const totalValueBase    = holdingsValueBase + cashValueBase

  // ── Build HoldingSnapshot[] ────────────────────────────────────────────────

  const holdingSnapshots: HoldingSnapshot[] = holdingValues.map(
    ({ holding, accum, marketValue, marketValueBase }) => {
      // Allocation % = share of invested capital only (cash excluded from denominator)
      const allocationPct  = holdingsValueBase > 0
        ? (marketValueBase / holdingsValueBase) * 100
        : 0
      const driftFromTarget = allocationPct - holding.targetAllocationPct

      return {
        holdingId:        holding.id,
        shares:           accum.shares,
        pricePerShare:    accum.lastPrice,
        marketValue,
        marketValueBase,
        costBasis:        accum.costBasis,
        costBasisBase:    accum.costBasisBase,
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
