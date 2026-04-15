import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/database'
import { importIBKRTradesAtomically } from '@/services/ibkrImportService'
import type { CashAccount, Holding, Portfolio } from '@/types'

async function clearAllTables(): Promise<void> {
  await db.labDraft.clear()
  await db.entityLinks.clear()
  await db.compares.clear()
  await db.benchmarks.clear()
  await db.builds.clear()
  await db.priceCaches.clear()
  await db.snapshots.clear()
  await db.operations.clear()
  await db.fxLots.clear()
  await db.fxTransactions.clear()
  await db.cashAccounts.clear()
  await db.holdings.clear()
  await db.sleeves.clear()
  await db.ammunitionPools.clear()
  await db.portfolios.clear()
}

async function seedPortfolio(): Promise<string> {
  const portfolioId = crypto.randomUUID()
  const now = new Date('2026-04-15T00:00:00.000Z')
  const portfolio: Portfolio = {
    id: portfolioId,
    name: 'IBKR Import Test',
    baseCurrency: 'TWD',
    supportedCurrencies: ['TWD', 'USD'],
    monthlyDCABudget: 0,
    monthlyDCABudgetCurrency: 'USD',
    defaultRebalanceStrategy: 'soft',
    defaultAllocationMethod: 'proportional-to-drift',
    initialFxRate: 31.5,
    createdAt: now,
    updatedAt: now,
  }
  const cashAccounts: CashAccount[] = [
    { id: crypto.randomUUID(), portfolioId, currency: 'TWD', balance: 100000 },
    { id: crypto.randomUUID(), portfolioId, currency: 'USD', balance: 2000 },
  ]

  await db.portfolios.add(portfolio)
  await db.cashAccounts.bulkAdd(cashAccounts)
  return portfolioId
}

describe('ibkrImportService', () => {
  beforeEach(async () => {
    await clearAllTables()
  })

  it('imports resolved rows atomically in chronological order', async () => {
    const portfolioId = await seedPortfolio()

    const result = await importIBKRTradesAtomically(portfolioId, [
      {
        trade: {
          dateTime: new Date('2026-01-02T10:00:00.000Z'),
          symbol: 'VOO',
          quantity: 2,
          tradePrice: 100,
          currency: 'USD',
          commFee: 1,
          code: 'O',
        },
        holdingId: undefined,
      },
      {
        trade: {
          dateTime: new Date('2026-02-02T10:00:00.000Z'),
          symbol: 'VOO',
          quantity: 1,
          tradePrice: 110,
          currency: 'USD',
          commFee: 1,
          code: 'O',
        },
        holdingId: undefined,
      },
    ], 'import.csv')

    const holdings = await db.holdings.toArray()
    const operations = await db.operations.orderBy('timestamp').toArray()

    expect(result.created).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.newLegacyTickers).toEqual(['VOO'])
    expect(holdings).toHaveLength(1)
    expect(operations).toHaveLength(2)
    expect(operations[0].timestamp.toISOString()).toBe('2026-01-02T10:00:00.000Z')
    expect(operations[1].timestamp.toISOString()).toBe('2026-02-02T10:00:00.000Z')
  })

  it('rolls back all earlier rows when a later import row fails', async () => {
    const portfolioId = await seedPortfolio()

    await expect(importIBKRTradesAtomically(portfolioId, [
      {
        trade: {
          dateTime: new Date('2026-01-02T10:00:00.000Z'),
          symbol: 'VOO',
          quantity: 2,
          tradePrice: 100,
          currency: 'USD',
          commFee: 1,
          code: 'O',
        },
        holdingId: undefined,
      },
      {
        trade: {
          dateTime: new Date('2026-01-03T10:00:00.000Z'),
          symbol: 'QQQ',
          quantity: -1,
          tradePrice: 100,
          currency: 'USD',
          commFee: 1,
          code: 'C',
        },
        holdingId: undefined,
      },
    ], 'import.csv')).rejects.toThrow('Failed on QQQ')

    expect(await db.operations.count()).toBe(0)
    expect(await db.holdings.count()).toBe(0)
    expect(await db.sleeves.count()).toBe(0)
  })

  it('still auto-archives imported sells that close an existing position', async () => {
    const portfolioId = await seedPortfolio()
    const sleeveId = crypto.randomUUID()
    const holding: Holding = {
      id: crypto.randomUUID(),
      portfolioId,
      ticker: 'VOO',
      name: 'VOO',
      sleeveId,
      targetAllocationPct: 100,
      driftThresholdPct: 2,
      currency: 'USD',
      status: 'active',
      currentShares: 1,
      currentPricePerShare: 100,
      averageCostBasis: 90,
      averageCostBasisBase: 2835,
    }

    await db.sleeves.add({
      id: sleeveId,
      portfolioId,
      name: 'Core',
      color: '#000000',
      targetAllocationPct: 100,
    })
    await db.holdings.add(holding)

    await importIBKRTradesAtomically(portfolioId, [{
      trade: {
        dateTime: new Date('2026-01-02T10:00:00.000Z'),
        symbol: 'VOO',
        quantity: -1,
        tradePrice: 100,
        currency: 'USD',
        commFee: 0,
        code: 'C',
      },
      holdingId: holding.id,
    }], 'sell.csv')

    const updated = await db.holdings.get(holding.id)
    expect(updated?.status).toBe('archived')
    expect(updated?.currentShares).toBe(0)
  })
})
