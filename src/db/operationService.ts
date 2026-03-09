/**
 * operationService — central service for creating trade/DCA/rotation operations.
 *
 * Orchestrates:
 *   1. Full before/after PortfolioSnapshot via snapshotService.captureSnapshot
 *   2. FIFO FX lot consumption for foreign-currency BUYs (pure engine, no nested tx)
 *   3. Cash balance updates via cash engine
 *   4. Holding position tracking (currentShares, averageCostBasis, averageCostBasisBase)
 *   5. Atomic persistence of all changes in a single db.transaction
 *
 * All writes use db.transaction('rw', [...allTables], ...) for atomicity.
 * Tables in scope: portfolios, holdings, cashAccounts, fxTransactions, fxLots, operations
 */

import { db } from '@/db'
import { captureSnapshot } from '@/db/snapshotService'
import { consumeFxLots } from '@/engine/fifo'
import { applyCashEffect } from '@/engine/cash'
import { updateHoldingOnBuy, updateHoldingOnSell } from '@/db/holdingService'
export { InsufficientCashError } from '@/engine/cash'
export { InsufficientSharesError } from '@/db/holdingService'
import type {
  Holding,
  FxLot,
  Operation,
  OperationEntry,
  OperationType,
} from '@/types'

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
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Loads available FX lots for a portfolio+currency, sorted ascending (FIFO).
 * Must be called inside a transaction that includes fxTransactions + fxLots.
 */
async function loadAvailableLots(
  portfolioId: string,
  currency: 'USD' | 'TWD',
): Promise<FxLot[]> {
  const txIds = (await db.fxTransactions
    .where('portfolioId')
    .equals(portfolioId)
    .primaryKeys()) as string[]

  if (txIds.length === 0) return []

  const lots = await db.fxLots
    .where('fxTransactionId')
    .anyOf(txIds)
    .sortBy('timestamp')

  return lots.filter(l => l.currency === currency && l.remainingAmount > 0)
}

// ─── createTradeOperation ─────────────────────────────────────────────────────

/**
 * Core trade pipeline. Handles any combination of BUY/SELL entries across
 * holdings. For foreign-currency BUYs, consumes FX lots inline (FIFO) without
 * opening a nested transaction.
 *
 * Throws:
 *   - InsufficientFxLotsError  if a BUY in USD cannot be fully funded by lots
 *   - InsufficientCashError    if cash balances are insufficient
 *   - InsufficientSharesError  if a SELL exceeds current holding shares
 */
export async function createTradeOperation(
  portfolioId: string,
  params: TradeOperationParams,
): Promise<Operation> {
  return db.transaction(
    'rw',
    [
      db.portfolios,
      db.holdings,
      db.cashAccounts,
      db.fxTransactions,
      db.fxLots,
      db.operations,
    ],
    async () => {
      const snapshotBefore = await captureSnapshot(portfolioId)

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
          let fxCostBasis: OperationEntry['fxCostBasis'] | undefined

          if (holding.currency !== 'TWD') {
            const lots = await loadAvailableLots(portfolioId, holding.currency)
            const { consumed, blendedRate, baseCurrencyCost, updatedLots } =
              consumeFxLots(lots, grossCost)  // throws InsufficientFxLotsError

            fxCostBasis = { fxLotsConsumed: consumed, blendedRate, baseCurrencyCost }

            // Persist updated lot remainingAmounts
            for (const lot of updatedLots) {
              await db.fxLots.update(lot.id, { remainingAmount: lot.remainingAmount })
            }
          }

          // ── Cash deduction ─────────────────────────────────────────────────
          balances = applyCashEffect(balances, {
            currency: holding.currency,
            amount: -grossCost,
          })

          // ── Update holding position (delegates to holdingService) ─────────
          // updateHoldingOnBuy joins the current Dexie transaction context
          // automatically — no nested-transaction conflict.
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
          // updateHoldingOnSell validates shares and throws InsufficientSharesError
          // if insufficient, aborting the whole transaction atomically.
          await updateHoldingOnSell(
            input.holdingId,
            input.shares,
            input.pricePerShare,
          )

          // ── Cash credit (proceeds minus fees) ─────────────────────────────
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

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: params.type,
        timestamp: new Date(),
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
}

// ─── createDCAOperation ───────────────────────────────────────────────────────

export interface DCAOperationParams {
  entries: TradeEntryInput[]
  rationale: string
  strategy: 'soft' | 'hard'
  allocationMethod: 'proportional-to-drift' | 'equal-weight'
}

/**
 * Wrapper around createTradeOperation for DCA executions.
 * Tags the operation with "dca:<strategy>:<allocationMethod>" for reporting.
 */
export async function createDCAOperation(
  portfolioId: string,
  params: DCAOperationParams,
): Promise<Operation> {
  return createTradeOperation(portfolioId, {
    type: 'DCA',
    entries: params.entries,
    rationale: params.rationale,
    tag: `dca:${params.strategy}:${params.allocationMethod}`,
  })
}

// ─── createTacticalRotation ───────────────────────────────────────────────────

export interface TacticalRotationParams {
  sell: TradeEntryInput
  buy: TradeEntryInput
  rationale: string
  tag?: string
}

/**
 * Tactical rotation: SELL one holding then BUY another in the same atomic operation.
 * Entries are ordered SELL-first so the cash proceeds are available for the BUY.
 */
export async function createTacticalRotation(
  portfolioId: string,
  params: TacticalRotationParams,
): Promise<Operation> {
  // Explicitly order SELL before BUY so proceeds land in balances first
  const sellEntry: TradeEntryInput = { ...params.sell, side: 'SELL' }
  const buyEntry:  TradeEntryInput = { ...params.buy,  side: 'BUY' }

  return createTradeOperation(portfolioId, {
    type: 'TACTICAL_ROTATION',
    entries: [sellEntry, buyEntry],
    rationale: params.rationale,
    tag: params.tag,
  })
}
