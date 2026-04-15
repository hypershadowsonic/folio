import { db } from '@/db'
import {
  TRADE_OPERATION_TABLES,
  createTradeOperationInCurrentTransaction,
} from '@/db/operationService'
import type { IBKRTrade } from '@/lib/ibkrParser'
import { checkAndAutoArchive } from '@/services/holdingLifecycle'
import type { Holding, Sleeve } from '@/types'

const UNASSIGNED_SLEEVE_NAME = 'Unassigned'
const UNASSIGNED_SLEEVE_COLOR = '#9ca3af'

export interface IBKRImportRow {
  trade: IBKRTrade
  holdingId: string | null | undefined
}

export interface IBKRImportResult {
  created: number
  skipped: number
  newLegacyTickers: string[]
}

function inferCurrency(ticker: string): 'USD' | 'TWD' {
  return /^\d/.test(ticker) ? 'TWD' : 'USD'
}

async function getOrCreateUnassignedSleeveInCurrentTransaction(portfolioId: string): Promise<string> {
  const existing = await db.sleeves
    .where('portfolioId')
    .equals(portfolioId)
    .filter((sleeve) => sleeve.name === UNASSIGNED_SLEEVE_NAME)
    .first()

  if (existing) return existing.id

  const sleeve: Sleeve = {
    id: crypto.randomUUID(),
    portfolioId,
    name: UNASSIGNED_SLEEVE_NAME,
    color: UNASSIGNED_SLEEVE_COLOR,
    targetAllocationPct: 0,
  }
  await db.sleeves.add(sleeve)
  return sleeve.id
}

async function getOrCreateLegacyHoldingInCurrentTransaction(
  portfolioId: string,
  ticker: string,
): Promise<{ holdingId: string; created: boolean }> {
  const upperTicker = ticker.toUpperCase()
  const existing = await db.holdings
    .where('portfolioId')
    .equals(portfolioId)
    .filter((holding) => holding.ticker.toUpperCase() === upperTicker)
    .first()

  if (existing) return { holdingId: existing.id, created: false }

  const sleeveId = await getOrCreateUnassignedSleeveInCurrentTransaction(portfolioId)
  const holding: Holding = {
    id: crypto.randomUUID(),
    portfolioId,
    sleeveId,
    ticker: upperTicker,
    name: upperTicker,
    status: 'legacy',
    targetAllocationPct: 0,
    driftThresholdPct: 0,
    currency: inferCurrency(ticker),
  }
  await db.holdings.add(holding)

  return { holdingId: holding.id, created: true }
}

export async function importIBKRTradesAtomically(
  portfolioId: string,
  rows: IBKRImportRow[],
  filename?: string,
): Promise<IBKRImportResult> {
  const rationale = `Imported from IBKR Activity Statement (${filename ?? 'unknown'})`
  const result = await db.transaction(
    'rw',
    [...TRADE_OPERATION_TABLES, db.sleeves],
    async () => {
      const resolvedRows: Array<{ trade: IBKRTrade; holdingId: string }> = []
      const newLegacyTickers = new Set<string>()
      let skipped = 0

      for (const row of rows) {
        if (row.holdingId === null) {
          skipped += 1
          continue
        }

        let resolvedHoldingId = row.holdingId
        if (!resolvedHoldingId) {
          const result = await getOrCreateLegacyHoldingInCurrentTransaction(portfolioId, row.trade.symbol)
          resolvedHoldingId = result.holdingId
          if (result.created) newLegacyTickers.add(row.trade.symbol.toUpperCase())
        }

        resolvedRows.push({
          trade: row.trade,
          holdingId: resolvedHoldingId,
        })
      }

      for (const { trade, holdingId } of resolvedRows) {
        const side: 'BUY' | 'SELL' = trade.quantity > 0 ? 'BUY' : 'SELL'
        try {
          await createTradeOperationInCurrentTransaction(portfolioId, {
            type: side,
            entries: [{
              holdingId,
              side,
              shares: Math.abs(trade.quantity),
              pricePerShare: trade.tradePrice,
              fees: trade.commFee,
            }],
            rationale,
            timestamp: trade.dateTime,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Failed on ${trade.symbol} (${trade.dateTime.toISOString()}): ${message}`)
        }
      }

      return {
        created: resolvedRows.length,
        skipped,
        newLegacyTickers: [...newLegacyTickers],
        sellHoldingIds: [...new Set(
          resolvedRows
            .filter(({ trade }) => trade.quantity < 0)
            .map(({ holdingId }) => holdingId),
        )],
      }
    },
  )

  for (const holdingId of result.sellHoldingIds) {
    await checkAndAutoArchive(holdingId)
  }

  return {
    created: result.created,
    skipped: result.skipped,
    newLegacyTickers: result.newLegacyTickers,
  }
}
