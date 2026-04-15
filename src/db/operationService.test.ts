import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'
import { recordCashDeposit, recordCashWithdrawal, recordFxExchange } from '@/db/cashFxService'
import { db } from '@/db/database'
import { createTradeOperation } from '@/db/operationService'
import type { CashAccount, Holding, Portfolio, Sleeve } from '@/types'

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
    name: 'Ops Test',
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
    { id: crypto.randomUUID(), portfolioId, currency: 'USD', balance: 1000 },
  ]

  await db.portfolios.add(portfolio)
  await db.cashAccounts.bulkAdd(cashAccounts)
  return portfolioId
}

async function seedHolding(
  portfolioId: string,
  overrides: Partial<Holding> = {},
): Promise<string> {
  const sleeveId = overrides.sleeveId ?? crypto.randomUUID()
  const sleeve: Sleeve = {
    id: sleeveId,
    portfolioId,
    name: 'Core',
    color: '#000000',
    targetAllocationPct: 100,
  }

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
    currentShares: 0,
    currentPricePerShare: 0,
    averageCostBasis: 0,
    averageCostBasisBase: 0,
    ...overrides,
  }

  await db.sleeves.put(sleeve)
  await db.holdings.put(holding)
  return holding.id
}

describe('operationService validations and lifecycle', () => {
  beforeEach(async () => {
    await clearAllTables()
  })

  it('restores archived holdings to legacy when buying into them', async () => {
    const portfolioId = await seedPortfolio()
    const holdingId = await seedHolding(portfolioId, {
      status: 'archived',
      targetAllocationPct: 0,
      archivedAt: new Date('2026-04-01T00:00:00.000Z'),
    })

    await createTradeOperation(portfolioId, {
      type: 'BUY',
      entries: [{
        holdingId,
        side: 'BUY',
        shares: 1,
        pricePerShare: 100,
        fees: 0,
      }],
      rationale: 'Restore this archived holding with a new buy.',
      timestamp: new Date('2026-04-15T00:00:00.000Z'),
    })

    const updated = await db.holdings.get(holdingId)
    expect(updated?.status).toBe('legacy')
    expect(updated?.archivedAt).toBeUndefined()
    expect(updated?.currentShares).toBe(1)
  })

  it('rejects invalid trade entries and future timestamps', async () => {
    const portfolioId = await seedPortfolio()
    const holdingId = await seedHolding(portfolioId)

    await expect(createTradeOperation(portfolioId, {
      type: 'BUY',
      entries: [],
      rationale: 'Valid rationale',
    })).rejects.toThrow('at least one entry')

    await expect(createTradeOperation(portfolioId, {
      type: 'BUY',
      entries: [{
        holdingId,
        side: 'BUY',
        shares: 0,
        pricePerShare: 100,
        fees: 0,
      }],
      rationale: 'Valid rationale',
    })).rejects.toThrow('shares')

    await expect(createTradeOperation(portfolioId, {
      type: 'BUY',
      entries: [{
        holdingId,
        side: 'BUY',
        shares: 1,
        pricePerShare: 100,
        fees: -1,
      }],
      rationale: 'Valid rationale',
    })).rejects.toThrow('fees')

    await expect(createTradeOperation(portfolioId, {
      type: 'BUY',
      entries: [{
        holdingId,
        side: 'BUY',
        shares: 1,
        pricePerShare: 100,
        fees: 0,
      }],
      rationale: '   ',
    })).rejects.toThrow('Rationale')

    await expect(createTradeOperation(portfolioId, {
      type: 'BUY',
      entries: [{
        holdingId,
        side: 'BUY',
        shares: 1,
        pricePerShare: 100,
        fees: 0,
      }],
      rationale: 'Valid rationale',
      timestamp: new Date('2999-01-01T00:00:00.000Z'),
    })).rejects.toThrow('future')
  })

  it('rejects invalid cash and fx service inputs', async () => {
    const portfolioId = await seedPortfolio()

    await expect(recordCashDeposit(portfolioId, 'USD', 0)).rejects.toThrow('Deposit amount')
    await expect(recordCashWithdrawal(portfolioId, 'USD', -1)).rejects.toThrow('Withdrawal amount')

    await expect(recordFxExchange(portfolioId, {
      fromCurrency: 'USD',
      fromAmount: 100,
      toCurrency: 'USD',
      toAmount: 100,
      rate: 1,
      fees: 0,
      feesCurrency: 'USD',
    })).rejects.toThrow('currencies must differ')

    await expect(recordFxExchange(portfolioId, {
      fromCurrency: 'TWD',
      fromAmount: 100,
      toCurrency: 'USD',
      toAmount: 10,
      rate: 0,
      fees: 0,
      feesCurrency: 'TWD',
    })).rejects.toThrow('rate')
  })

  it('still auto-archives holdings that are sold down to zero', async () => {
    const portfolioId = await seedPortfolio()
    const holdingId = await seedHolding(portfolioId, {
      currentShares: 1,
      currentPricePerShare: 100,
      averageCostBasis: 90,
      averageCostBasisBase: 2835,
    })

    const result = await createTradeOperation(portfolioId, {
      type: 'SELL',
      entries: [{
        holdingId,
        side: 'SELL',
        shares: 1,
        pricePerShare: 100,
        fees: 0,
      }],
      rationale: 'Exit the full position cleanly.',
      timestamp: new Date('2026-04-15T00:00:00.000Z'),
    })

    const updated = await db.holdings.get(holdingId)
    expect(result.autoArchived).toHaveLength(1)
    expect(updated?.status).toBe('archived')
    expect(updated?.currentShares).toBe(0)
  })
})
