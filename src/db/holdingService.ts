/**
 * holdingService — manages Holding position tracking fields.
 *
 * updateHoldingOnBuy / updateHoldingOnSell are designed to be called both:
 *   a) Standalone — they operate on the auto-transaction Dexie creates per call.
 *   b) Inside an existing db.transaction() — Dexie automatically reuses the
 *      current transaction context, so no nested-transaction conflict occurs.
 *      (Holdings must be included in the outer transaction's table list.)
 *
 * updateHoldingPrice is standalone-only: it opens its own full-scope transaction
 * and saves a PortfolioSnapshot record after the price change.
 */

import { db } from '@/db/database'
import { captureSnapshot } from '@/db/snapshotService'

// ─── Errors ───────────────────────────────────────────────────────────────────

export class InsufficientSharesError extends Error {
  readonly holdingId: string
  readonly shortfall: number
  constructor(holdingId: string, shortfall: number) {
    super(`Insufficient shares for holding ${holdingId}: short by ${shortfall}`)
    this.name = 'InsufficientSharesError'
    this.holdingId = holdingId
    this.shortfall = shortfall
  }
}

// ─── updateHoldingOnBuy ───────────────────────────────────────────────────────

/**
 * Updates position tracking fields after a BUY.
 *
 * @param holdingId       - Target holding
 * @param shares          - Number of shares purchased
 * @param pricePerShare   - Execution price in holding's currency
 * @param fxCostBasisBase - Total TWD cost from FIFO lot consumption (USD holdings only).
 *                          For TWD holdings omit; defaults to shares × pricePerShare.
 */
export async function updateHoldingOnBuy(
  holdingId: string,
  shares: number,
  pricePerShare: number,
  fxCostBasisBase?: number,
): Promise<void> {
  const holding = await db.holdings.get(holdingId)
  if (!holding) throw new Error(`Holding ${holdingId} not found`)

  const prevShares  = holding.currentShares ?? 0
  const prevAvg     = holding.averageCostBasis ?? 0
  const prevAvgBase = holding.averageCostBasisBase ?? 0
  const tradeCost   = shares * pricePerShare          // cost in holding's currency
  const newShares   = prevShares + shares

  const newAvg = newShares > 0
    ? (prevShares * prevAvg + tradeCost) / newShares
    : 0

  // For TWD holdings, base cost = trade cost (already in TWD)
  const baseCost   = fxCostBasisBase ?? tradeCost
  const newAvgBase = newShares > 0
    ? (prevShares * prevAvgBase + baseCost) / newShares
    : 0

  await db.holdings.update(holdingId, {
    currentShares:        newShares,
    currentPricePerShare: pricePerShare,
    averageCostBasis:     newAvg,
    averageCostBasisBase: newAvgBase,
  })
}

// ─── updateHoldingOnSell ──────────────────────────────────────────────────────

/**
 * Updates position tracking fields after a SELL.
 *
 * Average cost per share is intentionally unchanged on sells (average-cost method).
 * Only the share count and latest known price are updated.
 *
 * Throws InsufficientSharesError if the requested sell exceeds current shares.
 */
export async function updateHoldingOnSell(
  holdingId: string,
  shares: number,
  pricePerShare: number,
): Promise<void> {
  const holding = await db.holdings.get(holdingId)
  if (!holding) throw new Error(`Holding ${holdingId} not found`)

  const currentShares = holding.currentShares ?? 0
  if (shares > currentShares) {
    throw new InsufficientSharesError(holdingId, shares - currentShares)
  }

  await db.holdings.update(holdingId, {
    currentShares:        currentShares - shares,
    currentPricePerShare: pricePerShare,
    // averageCostBasis and averageCostBasisBase remain unchanged on SELL
  })
}

// ─── updateHoldingPrice ───────────────────────────────────────────────────────

/**
 * Manual "mark to market" price update for a single holding.
 * Use this when the user checks IBKR and enters the latest market price without
 * executing a trade.
 *
 * Captures a new PortfolioSnapshot after the update so the Dashboard chart
 * reflects the price change even without an operation.
 */
export async function updateHoldingPrice(
  holdingId: string,
  pricePerShare: number,
): Promise<void> {
  // captureSnapshot reads from: portfolios, holdings, cashAccounts, operations,
  // fxTransactions, fxLots — all must be in the transaction scope.
  return db.transaction(
    'rw',
    [
      db.portfolios,
      db.holdings,
      db.cashAccounts,
      db.fxTransactions,
      db.fxLots,
      db.operations,
      db.snapshots,
    ],
    async () => {
      const holding = await db.holdings.get(holdingId)
      if (!holding) throw new Error(`Holding ${holdingId} not found`)

      await db.holdings.update(holdingId, { currentPricePerShare: pricePerShare })

      const snap = await captureSnapshot(holding.portfolioId)
      await db.snapshots.add({
        id:          crypto.randomUUID(),
        portfolioId: holding.portfolioId,
        ...snap,
      })
    },
  )
}

// ─── getHoldingSummary ────────────────────────────────────────────────────────

export interface HoldingSummary {
  ticker:           string
  shares:           number
  price:            number
  marketValue:      number   // in holding's currency
  costBasis:        number   // in holding's currency (shares × avgCostBasis)
  unrealizedPL:     number   // marketValue − costBasis
  unrealizedPLPct:  number   // unrealizedPL / costBasis × 100
  marketValueBase:  number   // in TWD
  costBasisBase:    number   // in TWD (shares × avgCostBasisBase)
}

/**
 * Returns a full P&L summary for a single holding, computed from persisted
 * position fields (currentShares, currentPricePerShare, average cost bases).
 *
 * Uses the portfolio's best available FX rate for TWD conversion.
 */
export async function getHoldingSummary(holdingId: string): Promise<HoldingSummary> {
  const holding = await db.holdings.get(holdingId)
  if (!holding) throw new Error(`Holding ${holdingId} not found`)

  const shares      = holding.currentShares ?? 0
  const price       = holding.currentPricePerShare ?? 0
  const marketValue = shares * price

  // Resolve FX rate (best effort — same tier logic as snapshotService)
  const portfolio  = await db.portfolios.get(holding.portfolioId)
  const fxRate     = portfolio?.fxRateOverride ?? portfolio?.initialFxRate ?? 1

  const marketValueBase = holding.currency === 'USD' ? marketValue * fxRate : marketValue

  const avgCost      = holding.averageCostBasis ?? 0
  const avgCostBase  = holding.averageCostBasisBase ?? 0
  const costBasis    = shares * avgCost
  const costBasisBase= shares * avgCostBase

  const unrealizedPL    = marketValue - costBasis
  const unrealizedPLPct = costBasis > 0 ? (unrealizedPL / costBasis) * 100 : 0

  return {
    ticker: holding.ticker,
    shares,
    price,
    marketValue,
    costBasis,
    unrealizedPL,
    unrealizedPLPct,
    marketValueBase,
    costBasisBase,
  }
}
