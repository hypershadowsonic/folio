/**
 * operationService — central service for creating trade/DCA/rotation operations.
 *
 * Orchestrates:
 *   1. Full before/after PortfolioSnapshot via snapshotService.captureSnapshot
 *   2. FIFO FX lot consumption for foreign-currency BUYs via consumeFxLotsForBuy
 *   3. Cash balance updates via cash engine
 *   4. Holding position tracking (currentShares, averageCostBasis, averageCostBasisBase)
 *   5. Atomic persistence of all changes in a single db.transaction
 *   6. Persistence of snapshotBefore/After to db.snapshots for Performance tab queries
 *
 * All writes use db.transaction('rw', [...allTables], ...) for atomicity.
 * Tables in scope: portfolios, holdings, cashAccounts, fxTransactions, fxLots, operations, snapshots
 */

import { db } from '@/db'
import { captureSnapshot } from '@/db/snapshotService'
import { consumeFxLotsForBuy } from '@/db/cashFxService'
import { applyCashEffect } from '@/engine/cash'
import { updateHoldingOnBuy, updateHoldingOnSell } from '@/db/holdingService'
import { checkAndAutoArchive } from '@/services/holdingLifecycle'
export { InsufficientCashError } from '@/engine/cash'
export { InsufficientSharesError } from '@/db/holdingService'
import type {
  Holding,
  Operation,
  OperationEntry,
  OperationType,
} from '@/types'

// ─── Auto-archive result ──────────────────────────────────────────────────────

/** Returned alongside the created Operation to inform the UI about lifecycle events. */
export interface AutoArchiveEvent {
  holdingId: string
  ticker: string
  wasActive: boolean
  freedAllocationPct: number
}

// ─── Parameter types ──────────────────────────────────────────────────────────

export interface TradeEntryInput {
  holdingId: string
  side: 'BUY' | 'SELL'
  shares: number
  pricePerShare: number   // in holding's currency
  fees: number
}

export interface TradeOperationParams {
  /** BUY, SELL, REBALANCE, DCA, TACTICAL_ROTATION, DRAWDOWN_DEPLOY, DIVIDEND_REINVEST */
  type: OperationType
  entries: TradeEntryInput[]
  rationale: string
  tag?: string
  /** User-selected date for back-dating. Defaults to now. Must not be in the future. */
  timestamp?: Date
}

// ─── createTradeOperation ─────────────────────────────────────────────────────

/**
 * Core trade pipeline. Handles any combination of BUY/SELL entries across
 * holdings. For foreign-currency BUYs, delegates to consumeFxLotsForBuy.
 *
 * Throws:
 *   - Error ('No FX rate available') if a USD BUY has no rate to fall back on
 *   - InsufficientCashError    if cash balances are insufficient
 *   - InsufficientSharesError  if a SELL exceeds current holding shares
 */
export interface TradeOperationResult {
  operation: Operation
  /** Holdings that were auto-archived because their shares reached 0. */
  autoArchived: AutoArchiveEvent[]
}

export async function createTradeOperation(
  portfolioId: string,
  params: TradeOperationParams,
): Promise<TradeOperationResult> {
  const operation = await db.transaction(
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
      const opTimestamp = params.timestamp ?? new Date()

      const snapshotBefore = await captureSnapshot(portfolioId)
      snapshotBefore.timestamp = new Date(opTimestamp.getTime() - 1)

      // ── Load holdings for this operation ───────────────────────────────────
      const holdingIds = [...new Set(params.entries.map(e => e.holdingId))]
      const holdings = await db.holdings.bulkGet(holdingIds) as (Holding | undefined)[]
      const holdingMap = new Map<string, Holding>()
      for (const h of holdings) {
        if (h) holdingMap.set(h.id, h)
      }

      // ── Load cash accounts ─────────────────────────────────────────────────
      const cashAccounts = await db.cashAccounts
        .where('portfolioId')
        .equals(portfolioId)
        .toArray()
      let balances = new Map<string, number>(
        cashAccounts.map(a => [a.currency, a.balance]),
      )

      // ── Process each entry ─────────────────────────────────────────────────
      const operationEntries: OperationEntry[] = []

      for (const input of params.entries) {
        const holding = holdingMap.get(input.holdingId)
        if (!holding) {
          throw new Error(`Holding ${input.holdingId} not found`)
        }

        const grossCost = input.shares * input.pricePerShare + input.fees

        if (input.side === 'BUY') {
          // ── FX lot consumption (only for foreign-currency holdings) ─────────
          const fxCostBasis = await consumeFxLotsForBuy(portfolioId, holding.currency, grossCost)

          // ── Cash deduction ─────────────────────────────────────────────────
          balances = applyCashEffect(balances, {
            currency: holding.currency,
            amount: -grossCost,
          })

          await updateHoldingOnBuy(
            input.holdingId,
            input.shares,
            input.pricePerShare,
            fxCostBasis?.baseCurrencyCost,
          )

          operationEntries.push({
            holdingId: input.holdingId,
            side: 'BUY',
            shares: input.shares,
            pricePerShare: input.pricePerShare,
            fees: input.fees,
            currency: holding.currency,
            fxCostBasis,
          })
        } else {
          // ── SELL ───────────────────────────────────────────────────────────
          await updateHoldingOnSell(
            input.holdingId,
            input.shares,
            input.pricePerShare,
          )

          const proceeds = input.shares * input.pricePerShare - input.fees
          balances = applyCashEffect(balances, {
            currency: holding.currency,
            amount: proceeds,
          })

          operationEntries.push({
            holdingId: input.holdingId,
            side: 'SELL',
            shares: input.shares,
            pricePerShare: input.pricePerShare,
            fees: input.fees,
            currency: holding.currency,
          })
        }
      }

      // ── Persist updated cash balances ──────────────────────────────────────
      for (const account of cashAccounts) {
        const newBalance = balances.get(account.currency)
        if (newBalance !== undefined && newBalance !== account.balance) {
          await db.cashAccounts.update(account.id, { balance: newBalance })
        }
      }

      const snapshotAfter = await captureSnapshot(portfolioId)
      snapshotAfter.timestamp = opTimestamp

      // ── Persist snapshots to db.snapshots for Performance tab ─────────────
      await db.snapshots.add({ id: crypto.randomUUID(), portfolioId, ...snapshotBefore })
      await db.snapshots.add({ id: crypto.randomUUID(), portfolioId, ...snapshotAfter })

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: params.type,
        timestamp: opTimestamp,
        entries: operationEntries,
        rationale: params.rationale,
        tag: params.tag,
        snapshotBefore,
        snapshotAfter,
      }
      await db.operations.add(operation)
      return operation
    },
  )

  // ── Post-transaction: auto-archive holdings that reached 0 shares ──────────
  // Must run OUTSIDE the transaction because checkAndAutoArchive opens its own.
  const autoArchived: AutoArchiveEvent[] = []
  const sellHoldingIds = params.entries
    .filter(e => e.side === 'SELL')
    .map(e => e.holdingId)

  for (const holdingId of [...new Set(sellHoldingIds)]) {
    const result = await checkAndAutoArchive(holdingId)
    if (result.archived) {
      autoArchived.push({
        holdingId,
        ticker: result.ticker,
        wasActive: result.wasActive,
        freedAllocationPct: result.freedAllocationPct,
      })
    }
  }

  return { operation, autoArchived }
}

// ─── createDCAOperation ───────────────────────────────────────────────────────

export interface DCAOperationParams {
  entries: TradeEntryInput[]
  rationale: string
  strategy: 'soft' | 'hard'
  allocationMethod: 'proportional-to-drift' | 'equal-weight'
  timestamp?: Date
}

/**
 * Wrapper around createTradeOperation for DCA executions.
 * Tags the operation with "dca:<strategy>:<allocationMethod>" for reporting.
 */
export async function createDCAOperation(
  portfolioId: string,
  params: DCAOperationParams,
): Promise<TradeOperationResult> {
  return createTradeOperation(portfolioId, {
    type: 'DCA',
    entries: params.entries,
    rationale: params.rationale,
    tag: `dca:${params.strategy}:${params.allocationMethod}`,
    timestamp: params.timestamp,
  })
}

// ─── createTacticalRotation ───────────────────────────────────────────────────

export interface TacticalRotationParams {
  sell: TradeEntryInput
  buy: TradeEntryInput
  rationale: string
  tag?: string
  timestamp?: Date
}

/**
 * Tactical rotation: SELL one holding then BUY another in the same atomic operation.
 * Entries are ordered SELL-first so the cash proceeds are available for the BUY.
 */
export async function createTacticalRotation(
  portfolioId: string,
  params: TacticalRotationParams,
): Promise<TradeOperationResult> {
  const sellEntry: TradeEntryInput = { ...params.sell, side: 'SELL' }
  const buyEntry:  TradeEntryInput = { ...params.buy,  side: 'BUY' }

  return createTradeOperation(portfolioId, {
    type: 'TACTICAL_ROTATION',
    entries: [sellEntry, buyEntry],
    rationale: params.rationale,
    tag: params.tag,
    timestamp: params.timestamp,
  })
}