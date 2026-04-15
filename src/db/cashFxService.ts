/**
 * cashFxService — bridge between the pure cash/FIFO engines and Dexie persistence.
 *
 * All write operations use db.transaction() for atomicity.
 * No React dependencies — safe to call from event handlers or other services.
 *
 * Snapshots are persisted to db.snapshots (before + after each operation) so
 * the Performance tab chart and TWR calculations have data points at every cash event.
 */

import { db } from '@/db'
import { captureSnapshot } from '@/db/snapshotService'
import type {
  FxLot,
  FxTransaction,
  Operation,
  OperationEntry,
  PortfolioSnapshot,
} from '@/types'
import { applyCashEffect, calculateFxCashEffect } from '@/engine/cash'
export { InsufficientCashError } from '@/engine/cash'
import {
  consumeFxLots,
  getFxLotQueue as engineGetFxLotQueue,
  getLatestFxRate as engineGetLatestFxRate,
} from '@/engine/fifo'
import type { CashAccount } from '@/types'

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Loads all FX lots for a portfolio (via the fxTransactions join), optionally
 * filtered by currency, sorted by timestamp ascending (FIFO order).
 *
 * Must be called inside a db.transaction that includes fxTransactions + fxLots.
 */
async function loadLotsForPortfolio(
  portfolioId: string,
  currency?: 'USD' | 'TWD',
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

  return currency ? lots.filter(l => l.currency === currency) : lots
}

/** Resolves the CashAccount for a given portfolio+currency. Throws if missing. */
async function requireAccount(
  portfolioId: string,
  currency: 'USD' | 'TWD',
): Promise<CashAccount> {
  const account = await db.cashAccounts
    .where('[portfolioId+currency]')
    .equals([portfolioId, currency])
    .first()
  if (!account) {
    throw new Error(`No ${currency} cash account found for portfolio ${portfolioId}`)
  }
  return account
}

/** Persist a snapshot pair (before + after) to db.snapshots. */
async function persistSnapshots(
  portfolioId: string,
  before: PortfolioSnapshot,
  after: PortfolioSnapshot,
): Promise<void> {
  await db.snapshots.add({ id: crypto.randomUUID(), portfolioId, ...before })
  await db.snapshots.add({ id: crypto.randomUUID(), portfolioId, ...after })
}

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

// ─── 1. recordCashDeposit ─────────────────────────────────────────────────────

export async function recordCashDeposit(
  portfolioId: string,
  currency: 'USD' | 'TWD',
  amount: number,
  note?: string,
  timestamp?: Date,
): Promise<Operation> {
  assertFinitePositive(amount, 'Deposit amount')
  return db.transaction(
    'rw',
    [db.portfolios, db.holdings, db.cashAccounts, db.fxTransactions, db.fxLots, db.operations, db.snapshots],
    async () => {
      const opTimestamp = normalizeTimestamp(timestamp)

      const snapshotBefore = await captureSnapshot(portfolioId)
      snapshotBefore.timestamp = new Date(opTimestamp.getTime() - 1)

      const account = await requireAccount(portfolioId, currency)
      await db.cashAccounts.update(account.id, {
        balance: account.balance + amount,
      })

      const snapshotAfter = await captureSnapshot(portfolioId)
      snapshotAfter.timestamp = opTimestamp

      await persistSnapshots(portfolioId, snapshotBefore, snapshotAfter)

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: 'CASH_DEPOSIT',
        timestamp: opTimestamp,
        entries: [],
        cashFlow: { currency, amount, note },
        rationale: note ?? `Deposit ${amount} ${currency}`,
        snapshotBefore,
        snapshotAfter,
      }
      await db.operations.add(operation)
      return operation
    },
  )
}

// ─── 2. recordCashWithdrawal ──────────────────────────────────────────────────

export async function recordCashWithdrawal(
  portfolioId: string,
  currency: 'USD' | 'TWD',
  amount: number,
  note?: string,
  timestamp?: Date,
): Promise<Operation> {
  assertFinitePositive(amount, 'Withdrawal amount')
  return db.transaction(
    'rw',
    [db.portfolios, db.holdings, db.cashAccounts, db.fxTransactions, db.fxLots, db.operations, db.snapshots],
    async () => {
      const opTimestamp = normalizeTimestamp(timestamp)

      const snapshotBefore = await captureSnapshot(portfolioId)
      snapshotBefore.timestamp = new Date(opTimestamp.getTime() - 1)

      const account = await requireAccount(portfolioId, currency)

      // applyCashEffect enforces non-negative balance — throws InsufficientCashError
      const balances = new Map([[currency, account.balance]])
      applyCashEffect(balances, { currency, amount: -amount })

      await db.cashAccounts.update(account.id, {
        balance: account.balance - amount,
      })

      const snapshotAfter = await captureSnapshot(portfolioId)
      snapshotAfter.timestamp = opTimestamp

      await persistSnapshots(portfolioId, snapshotBefore, snapshotAfter)

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: 'CASH_WITHDRAWAL',
        timestamp: opTimestamp,
        entries: [],
        cashFlow: { currency, amount: -amount, note },
        rationale: note ?? `Withdraw ${amount} ${currency}`,
        snapshotBefore,
        snapshotAfter,
      }
      await db.operations.add(operation)
      return operation
    },
  )
}

// ─── 3. recordFxExchange ──────────────────────────────────────────────────────

export interface FxExchangeParams {
  fromCurrency: 'USD' | 'TWD'
  fromAmount: number
  toCurrency: 'USD' | 'TWD'
  toAmount: number
  rate: number
  fees: number
  feesCurrency: 'USD' | 'TWD'
  note?: string
}

export interface FxExchangeResult {
  operation: Operation
  fxTransaction: FxTransaction
  fxLot: FxLot
}

export async function recordFxExchange(
  portfolioId: string,
  params: FxExchangeParams,
  timestamp?: Date,
): Promise<FxExchangeResult> {
  if (params.fromCurrency === params.toCurrency) {
    throw new Error('FX exchange currencies must differ.')
  }
  assertFinitePositive(params.fromAmount, 'FX fromAmount')
  assertFinitePositive(params.toAmount, 'FX toAmount')
  assertFinitePositive(params.rate, 'FX rate')
  assertFiniteNonNegative(params.fees, 'FX fees')

  return db.transaction(
    'rw',
    [db.portfolios, db.holdings, db.cashAccounts, db.fxTransactions, db.fxLots, db.operations, db.snapshots],
    async () => {
      const opTimestamp = normalizeTimestamp(timestamp)

      const snapshotBefore = await captureSnapshot(portfolioId)
      snapshotBefore.timestamp = new Date(opTimestamp.getTime() - 1)

      // Validate balances before mutating
      const fromAccount = await requireAccount(portfolioId, params.fromCurrency)
      const toAccount = await requireAccount(portfolioId, params.toCurrency)

      const effects = calculateFxCashEffect(
        params.fromCurrency,
        params.fromAmount,
        params.toCurrency,
        params.toAmount,
        params.fees,
        params.feesCurrency,
      )

      // Validate sufficiency (throws InsufficientCashError if needed)
      let balances: Map<string, number> = new Map([
        [fromAccount.currency, fromAccount.balance],
        [toAccount.currency, toAccount.balance],
      ])
      for (const effect of effects) {
        balances = applyCashEffect(balances, effect)
      }

      // Persist balance updates
      await db.cashAccounts.update(fromAccount.id, {
        balance: balances.get(params.fromCurrency)!,
      })
      await db.cashAccounts.update(toAccount.id, {
        balance: balances.get(params.toCurrency)!,
      })

      // Create FxTransaction record
      const fxTransaction: FxTransaction = {
        id: crypto.randomUUID(),
        portfolioId,
        timestamp: opTimestamp,
        fromCurrency: params.fromCurrency,
        toCurrency: params.toCurrency,
        fromAmount: params.fromAmount,
        toAmount: params.toAmount,
        rate: params.rate,
        fees: params.fees,
        feesCurrency: params.feesCurrency,
        note: params.note,
      }
      await db.fxTransactions.add(fxTransaction)

      // Create FxLot — represents the newly acquired foreign currency
      const fxLot: FxLot = {
        id: crypto.randomUUID(),
        fxTransactionId: fxTransaction.id,
        currency: params.toCurrency,
        originalAmount: params.toAmount,
        remainingAmount: params.toAmount,
        rate: params.rate,
        timestamp: opTimestamp,
      }
      await db.fxLots.add(fxLot)

      // captureSnapshot now picks up the new FxLot → uses params.rate automatically
      const snapshotAfter = await captureSnapshot(portfolioId)
      snapshotAfter.timestamp = opTimestamp

      await persistSnapshots(portfolioId, snapshotBefore, snapshotAfter)

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: 'FX_EXCHANGE',
        timestamp: opTimestamp,
        entries: [],
        fxTransactionId: fxTransaction.id,
        rationale: params.note ?? `FX exchange ${params.fromAmount} ${params.fromCurrency} → ${params.toAmount} ${params.toCurrency}`,
        snapshotBefore,
        snapshotAfter,
      }
      await db.operations.add(operation)

      return { operation, fxTransaction, fxLot }
    },
  )
}

// ─── 4. consumeFxLotsForBuy ───────────────────────────────────────────────────

/**
 * Unified FX lot consumption for any USD BUY trade.
 *
 * Returns undefined for TWD-denominated trades (no FX conversion needed).
 *
 * For USD: loads all lots FIFO, resolves the best available fallback rate,
 * calls consumeFxLots, persists updated remainingAmounts, returns fxCostBasis.
 *
 * Fallback rate hierarchy (applied when lots are insufficient):
 *   1. portfolio.fxRateOverride  (explicit user override)
 *   2. getLatestFxRate(allLots)  (most recent actual exchange rate, incl. exhausted)
 *   3. portfolio.initialFxRate   (setup-time rate)
 *   Throws a descriptive Error if none of the above are available.
 *
 * Safe to call inside an outer db.transaction() that already includes
 * db.portfolios, db.fxTransactions, and db.fxLots — Dexie will auto-enlist.
 */
export async function consumeFxLotsForBuy(
  portfolioId: string,
  tradeCurrency: 'USD' | 'TWD',
  amountNeeded: number,
): Promise<OperationEntry['fxCostBasis']> {
  if (tradeCurrency === 'TWD') return undefined

  // Load all lots for rate resolution (including exhausted — latest rate matters)
  const allLots = await loadLotsForPortfolio(portfolioId, tradeCurrency)
  const availableLots = allLots.filter(l => l.remainingAmount > 0)

  // Resolve fallback rate: override > latest actual rate > setup rate
  const portfolio = await db.portfolios.get(portfolioId)
  const fallbackRate =
    portfolio?.fxRateOverride ??
    engineGetLatestFxRate(allLots) ??
    portfolio?.initialFxRate

  if (fallbackRate === undefined) {
    throw new Error(
      'No FX rate available. Log an FX exchange or set a rate override in ' +
      'Settings → Cash & FX Manager before logging USD trades.',
    )
  }

  const { consumed, blendedRate, baseCurrencyCost, updatedLots } =
    consumeFxLots(availableLots, amountNeeded, fallbackRate)

  for (const lot of updatedLots) {
    await db.fxLots.update(lot.id, { remainingAmount: lot.remainingAmount })
  }

  return { fxLotsConsumed: consumed, blendedRate, baseCurrencyCost }
}

// ─── 5. getCashBalances ───────────────────────────────────────────────────────

export async function getCashBalances(
  portfolioId: string,
): Promise<{ twd: number; usd: number }> {
  const accounts = await db.cashAccounts
    .where('portfolioId')
    .equals(portfolioId)
    .toArray()

  return {
    twd: accounts.find(a => a.currency === 'TWD')?.balance ?? 0,
    usd: accounts.find(a => a.currency === 'USD')?.balance ?? 0,
  }
}

// ─── 6. getFxLotQueue ─────────────────────────────────────────────────────────

export async function getFxLotQueue(
  portfolioId: string,
  currency: 'USD',
): Promise<{ available: FxLot[]; exhausted: FxLot[] }> {
  const lots = await loadLotsForPortfolio(portfolioId, currency)
  return engineGetFxLotQueue(lots)
}

// ─── 7. getLatestFxRate ───────────────────────────────────────────────────────

export async function getLatestFxRate(portfolioId: string): Promise<number | null> {
  const lots = await loadLotsForPortfolio(portfolioId)
  return engineGetLatestFxRate(lots)
}
