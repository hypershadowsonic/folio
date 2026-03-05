import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './database'
import type { OperationType } from '@/types'

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface OperationFilters {
  type?: OperationType
  tag?: string
  dateFrom?: Date
  dateTo?: Date
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Returns the first (and only MVP) portfolio, or undefined while loading.
 */
export function usePortfolio() {
  return useLiveQuery(
    () => db.portfolios.toCollection().first(),
  )
}

/**
 * Returns all holdings for a portfolio, ordered by ticker for stable display.
 */
export function useHoldings(portfolioId: string | undefined) {
  return useLiveQuery(
    () => {
      if (!portfolioId) return []
      return db.holdings
        .where('portfolioId').equals(portfolioId)
        .sortBy('ticker')
    },
    [portfolioId],
    [],
  )
}

/**
 * Returns all sleeves for a portfolio.
 */
export function useSleeves(portfolioId: string | undefined) {
  return useLiveQuery(
    () => {
      if (!portfolioId) return []
      return db.sleeves
        .where('portfolioId').equals(portfolioId)
        .toArray()
    },
    [portfolioId],
    [],
  )
}

/**
 * Returns TWD and USD cash accounts for a portfolio.
 */
export function useCashAccounts(portfolioId: string | undefined) {
  return useLiveQuery(
    () => {
      if (!portfolioId) return []
      return db.cashAccounts
        .where('portfolioId').equals(portfolioId)
        .toArray()
    },
    [portfolioId],
    [],
  )
}

/**
 * Returns operations for a portfolio, newest first, with optional filters.
 *
 * Filtering strategy:
 *   - portfolioId + timestamp uses the compound index for an efficient range scan
 *   - type and tag are applied as in-memory .filter() calls after the index scan
 *     (operation counts are small enough that this is never a bottleneck)
 */
export function useOperations(
  portfolioId: string | undefined,
  filters?: OperationFilters,
) {
  return useLiveQuery(
    () => {
      if (!portfolioId) return []

      // Start from the compound [portfolioId+timestamp] index
      let collection = db.operations
        .where('[portfolioId+timestamp]')
        .between(
          [portfolioId, filters?.dateFrom ?? Dexie.minKey],
          [portfolioId, filters?.dateTo   ?? Dexie.maxKey],
          true, // includeLower
          true, // includeUpper
        )

      // In-memory type/tag filters — applied after the indexed scan
      if (filters?.type) {
        const targetType = filters.type
        collection = collection.filter(op => op.type === targetType)
      }
      if (filters?.tag) {
        const targetTag = filters.tag
        collection = collection.filter(op => op.tag === targetTag)
      }

      return collection
        .reverse()         // newest first
        .toArray()
    },
    [portfolioId, filters?.type, filters?.tag, filters?.dateFrom, filters?.dateTo],
    [],
  )
}

/**
 * Returns all FX lots for a portfolio's transactions, ordered by timestamp
 * ascending (FIFO order). Joins fxTransactions → fxLots since FxLot has no
 * direct portfolioId field.
 */
export function useFxLots(portfolioId: string | undefined) {
  return useLiveQuery(
    async () => {
      if (!portfolioId) return []

      // Step 1: get all FX transaction ids for this portfolio
      const txIds = await db.fxTransactions
        .where('portfolioId').equals(portfolioId)
        .primaryKeys() as string[]

      if (txIds.length === 0) return []

      // Step 2: get all lots for those transactions, sorted FIFO
      return db.fxLots
        .where('fxTransactionId').anyOf(txIds)
        .sortBy('timestamp')   // oldest first = FIFO consumption order
    },
    [portfolioId],
    [],
  )
}
