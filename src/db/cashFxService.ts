/**
 * cashFxService — bridge between the pure cash/FIFO engines and Dexie persistence.
 *
 * All write operations use db.transaction() for atomicity.
 * No React dependencies — safe to call from event handlers or other services.
 */

import { db } from '@/db'
import type {
  CashAccount,
  FxLot,
  FxTransaction,
  Operation,
  OperationEntry,
  PortfolioSnapshot,
} from '@/types'
import { applyCashEffect, calculateFxCashEffect } from '@/engine/cash'
export { InsufficientCashError } from '@/engine/cash'
import {
  calculateFxCostBasis,
  getFxLotQueue as engineGetFxLotQueue,
  getLatestFxRate as engineGetLatestFxRate,
} from '@/engine/fifo'

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

/**
 * Builds a lightweight PortfolioSnapshot from current DB state.
 * Holdings are left empty — full holding valuation is added in Phase 3.
 *
 * Must be called inside a transaction that includes cashAccounts,
 * fxTransactions, and fxLots.
 */
async function buildSnapshot(
  portfolioId: string,
  overrideFxRate?: number,
): Promise<PortfolioSnapshot> {
  const accounts = await db.cashAccounts
    .where('portfolioId')
    .equals(portfolioId)
    .toArray()

  const lots = await loadLotsForPortfolio(portfolioId)
  const fxRate = overrideFxRate ?? engineGetLatestFxRate(lots) ?? 0

  const twdBalance = accounts.find(a => a.currency === 'TWD')?.balance ?? 0
  const usdBalance = accounts.find(a => a.currency === 'USD')?.balance ?? 0
  const totalValueBase = twdBalance + usdBalance * (fxRate || 1)

  return {
    timestamp: new Date(),
    totalValueBase,
    currentFxRate: fxRate,
    cashBalances: accounts.map(a => ({ currency: a.currency, balance: a.balance })),
    holdings: [],
  }
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

// ─── 1. recordCashDeposit ─────────────────────────────────────────────────────

export async function recordCashDeposit(
  portfolioId: string,
  currency: 'USD' | 'TWD',
  amount: number,
  note?: string,
): Promise<Operation> {
  return db.transaction(
    'rw',
    [db.cashAccounts, db.fxTransactions, db.fxLots, db.operations],
    async () => {
      const snapshotBefore = await buildSnapshot(portfolioId)

      const account = await requireAccount(portfolioId, currency)
      await db.cashAccounts.update(account.id, {
        balance: account.balance + amount,
      })

      const snapshotAfter = await buildSnapshot(portfolioId)

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: 'CASH_DEPOSIT',
        timestamp: new Date(),
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
): Promise<Operation> {
  return db.transaction(
    'rw',
    [db.cashAccounts, db.fxTransactions, db.fxLots, db.operations],
    async () => {
      const snapshotBefore = await buildSnapshot(portfolioId)

      const account = await requireAccount(portfolioId, currency)

      // applyCashEffect enforces non-negative balance — throws InsufficientCashError
      const balances = new Map([[currency, account.balance]])
      applyCashEffect(balances, { currency, amount: -amount })

      await db.cashAccounts.update(account.id, {
        balance: account.balance - amount,
      })

      const snapshotAfter = await buildSnapshot(portfolioId)

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: 'CASH_WITHDRAWAL',
        timestamp: new Date(),
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
): Promise<FxExchangeResult> {
  return db.transaction(
    'rw',
    [db.cashAccounts, db.fxTransactions, db.fxLots, db.operations],
    async () => {
      const snapshotBefore = await buildSnapshot(portfolioId)

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
      const now = new Date()
      const fxTransaction: FxTransaction = {
        id: crypto.randomUUID(),
        portfolioId,
        timestamp: now,
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
        timestamp: now,
      }
      await db.fxLots.add(fxLot)

      const snapshotAfter = await buildSnapshot(portfolioId, params.rate)

      const operation: Operation = {
        id: crypto.randomUUID(),
        portfolioId,
        type: 'FX_EXCHANGE',
        timestamp: now,
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

// ─── 4. consumeFxLotsForTrade ─────────────────────────────────────────────────

export async function consumeFxLotsForTrade(
  portfolioId: string,
  currency: 'USD' | 'TWD',
  amount: number,
): Promise<OperationEntry['fxCostBasis']> {
  return db.transaction('rw', [db.fxTransactions, db.fxLots], async () => {
    const lots = await loadLotsForPortfolio(portfolioId, currency)

    const result = calculateFxCostBasis(lots, currency, amount, 'TWD')
    if (!result) return undefined // base currency trade — no FX cost basis

    // Persist updated remainingAmounts back to Dexie
    for (const updatedLot of result.updatedLots) {
      await db.fxLots.update(updatedLot.id, {
        remainingAmount: updatedLot.remainingAmount,
      })
    }

    const { updatedLots: _unused, ...fxCostBasis } = result
    return fxCostBasis
  })
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
