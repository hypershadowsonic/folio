/**
 * operationService - central service for creating trade/DCA/rotation operations.
 *
 * Orchestrates:
 *   1. Full before/after PortfolioSnapshot via snapshotService.captureSnapshot
 *   2. FIFO FX lot consumption for foreign-currency BUYs via consumeFxLotsForBuy
 *   3. Cash balance updates via cash engine
 *   4. Holding position tracking (currentShares, averageCostBasis, averageCostBasisBase)
 *   5. Atomic persistence of all changes in a single db.transaction
 *   6. Persistence of snapshotBefore/After to db.snapshots for Performance tab queries
 */

import { db } from '@/db'
import { consumeFxLotsForBuy } from '@/db/cashFxService'
import { updateHoldingOnBuy, updateHoldingOnSell } from '@/db/holdingService'
import { captureSnapshot } from '@/db/snapshotService'
import { applyCashEffect } from '@/engine/cash'
import { checkAndAutoArchive } from '@/services/holdingLifecycle'
import type { Holding, Operation, OperationEntry, OperationType } from '@/types'

export { InsufficientCashError } from '@/engine/cash'
export { InsufficientSharesError } from '@/db/holdingService'

export interface AutoArchiveEvent {
  holdingId: string
  ticker: string
  wasActive: boolean
  freedAllocationPct: number
}

export interface TradeEntryInput {
  holdingId: string
  side: 'BUY' | 'SELL'
  shares: number
  pricePerShare: number
  fees: number
}

export interface TradeOperationParams {
  type: OperationType
  entries: TradeEntryInput[]
  rationale: string
  tag?: string
  timestamp?: Date
}

export interface TradeOperationResult {
  operation: Operation
  autoArchived: AutoArchiveEvent[]
}

export const TRADE_OPERATION_TABLES = [
  db.portfolios,
  db.holdings,
  db.cashAccounts,
  db.fxTransactions,
  db.fxLots,
  db.operations,
  db.snapshots,
] as const

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be greater than 0.`)
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be 0 or greater.`)
  }
}

function normalizeTimestamp(timestamp?: Date): Date {
  const resolved = timestamp ?? new Date()
  if (Number.isNaN(resolved.getTime())) {
    throw new Error('Timestamp must be a valid date.')
  }
  if (resolved.getTime() > Date.now()) {
    throw new Error('Timestamp cannot be in the future.')
  }
  return resolved
}

function validateTradeOperationParams(params: TradeOperationParams): void {
  if (params.entries.length === 0) {
    throw new Error('Trade operation must include at least one entry.')
  }

  if (params.rationale.trim().length === 0) {
    throw new Error('Rationale is required.')
  }

  normalizeTimestamp(params.timestamp)

  for (const [index, entry] of params.entries.entries()) {
    if (entry.holdingId.trim().length === 0) {
      throw new Error(`Entry ${index + 1}: holdingId is required.`)
    }
    assertFinitePositive(entry.shares, `Entry ${index + 1}: shares`)
    assertFinitePositive(entry.pricePerShare, `Entry ${index + 1}: pricePerShare`)
    assertFiniteNonNegative(entry.fees, `Entry ${index + 1}: fees`)
  }
}

async function collectAutoArchivedEvents(entries: TradeEntryInput[]): Promise<AutoArchiveEvent[]> {
  const sellHoldingIds = [...new Set(
    entries.filter((entry) => entry.side === 'SELL').map((entry) => entry.holdingId),
  )]

  const autoArchived: AutoArchiveEvent[] = []
  for (const holdingId of sellHoldingIds) {
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

  return autoArchived
}

export async function createTradeOperationInCurrentTransaction(
  portfolioId: string,
  params: TradeOperationParams,
): Promise<Operation> {
  const opTimestamp = normalizeTimestamp(params.timestamp)
  const snapshotBefore = await captureSnapshot(portfolioId)
  snapshotBefore.timestamp = new Date(opTimestamp.getTime() - 1)

  const holdingIds = [...new Set(params.entries.map((entry) => entry.holdingId))]
  const holdings = await db.holdings.bulkGet(holdingIds) as (Holding | undefined)[]
  const holdingMap = new Map<string, Holding>()
  for (const holding of holdings) {
    if (holding) holdingMap.set(holding.id, holding)
  }

  const cashAccounts = await db.cashAccounts.where('portfolioId').equals(portfolioId).toArray()
  let balances = new Map<string, number>(cashAccounts.map((account) => [account.currency, account.balance]))

  const operationEntries: OperationEntry[] = []
  for (const input of params.entries) {
    const holding = holdingMap.get(input.holdingId)
    if (!holding) {
      throw new Error(`Holding ${input.holdingId} not found`)
    }

    const grossCost = input.shares * input.pricePerShare + input.fees
    if (input.side === 'BUY') {
      const fxCostBasis = await consumeFxLotsForBuy(portfolioId, holding.currency, grossCost)
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
      await updateHoldingOnSell(input.holdingId, input.shares, input.pricePerShare)
      balances = applyCashEffect(balances, {
        currency: holding.currency,
        amount: input.shares * input.pricePerShare - input.fees,
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

  for (const account of cashAccounts) {
    const newBalance = balances.get(account.currency)
    if (newBalance !== undefined && newBalance !== account.balance) {
      await db.cashAccounts.update(account.id, { balance: newBalance })
    }
  }

  const snapshotAfter = await captureSnapshot(portfolioId)
  snapshotAfter.timestamp = opTimestamp

  await db.snapshots.add({ id: crypto.randomUUID(), portfolioId, ...snapshotBefore })
  await db.snapshots.add({ id: crypto.randomUUID(), portfolioId, ...snapshotAfter })

  const operation: Operation = {
    id: crypto.randomUUID(),
    portfolioId,
    type: params.type,
    timestamp: opTimestamp,
    entries: operationEntries,
    rationale: params.rationale.trim(),
    tag: params.tag?.trim() || undefined,
    snapshotBefore,
    snapshotAfter,
  }
  await db.operations.add(operation)

  return operation
}

export async function createTradeOperation(
  portfolioId: string,
  params: TradeOperationParams,
): Promise<TradeOperationResult> {
  validateTradeOperationParams(params)

  const operation = await db.transaction(
    'rw',
    [...TRADE_OPERATION_TABLES],
    async () => createTradeOperationInCurrentTransaction(portfolioId, params),
  )

  return {
    operation,
    autoArchived: await collectAutoArchivedEvents(params.entries),
  }
}

export interface DCAOperationParams {
  entries: TradeEntryInput[]
  rationale: string
  strategy: 'soft' | 'hard'
  allocationMethod: 'proportional-to-drift' | 'equal-weight'
  timestamp?: Date
}

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

export interface TacticalRotationParams {
  sell: TradeEntryInput
  buy: TradeEntryInput
  rationale: string
  tag?: string
  timestamp?: Date
}

export async function createTacticalRotation(
  portfolioId: string,
  params: TacticalRotationParams,
): Promise<TradeOperationResult> {
  const sellEntry: TradeEntryInput = { ...params.sell, side: 'SELL' }
  const buyEntry: TradeEntryInput = { ...params.buy, side: 'BUY' }

  return createTradeOperation(portfolioId, {
    type: 'TACTICAL_ROTATION',
    entries: [sellEntry, buyEntry],
    rationale: params.rationale,
    tag: params.tag,
    timestamp: params.timestamp,
  })
}
