import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'
import { createBackupPayload, importBackupPayload } from '@/db/backupService'
import { db } from '@/db/database'
import type {
  AmmunitionPool,
  Benchmark,
  Build,
  CashAccount,
  Compare,
  EntityLink,
  FxLot,
  FxTransaction,
  Holding,
  LabDraft,
  Operation,
  Portfolio,
  PriceCache,
  Sleeve,
} from '@/types'

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

async function seedDurableData(): Promise<void> {
  const now = new Date('2026-04-15T00:00:00.000Z')
  const portfolioId = 'portfolio-1'
  const sleeveId = 'sleeve-1'
  const holdingId = 'holding-1'
  const fxTransactionId = 'fx-1'
  const operationId = 'op-1'
  const buildId = 'build-1'
  const benchmarkId = 'benchmark-1'
  const compareId = 'compare-1'

  const portfolio: Portfolio = {
    id: portfolioId,
    name: 'Backup Test',
    baseCurrency: 'TWD',
    supportedCurrencies: ['TWD', 'USD'],
    monthlyDCABudget: 1000,
    monthlyDCABudgetCurrency: 'USD',
    defaultRebalanceStrategy: 'soft',
    defaultAllocationMethod: 'proportional-to-drift',
    initialFxRate: 31.5,
    createdAt: now,
    updatedAt: now,
  }

  const sleeve: Sleeve = {
    id: sleeveId,
    portfolioId,
    name: 'Core',
    targetAllocationPct: 100,
    color: '#000000',
  }

  const holding: Holding = {
    id: holdingId,
    portfolioId,
    ticker: 'VOO',
    name: 'Vanguard S&P 500 ETF',
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

  const cashAccounts: CashAccount[] = [
    { id: 'cash-twd', portfolioId, currency: 'TWD', balance: 10000 },
    { id: 'cash-usd', portfolioId, currency: 'USD', balance: 500 },
  ]

  const fxTransaction: FxTransaction = {
    id: fxTransactionId,
    portfolioId,
    timestamp: now,
    fromCurrency: 'TWD',
    toCurrency: 'USD',
    fromAmount: 31500,
    toAmount: 1000,
    rate: 31.5,
    fees: 0,
    feesCurrency: 'TWD',
  }

  const fxLot: FxLot = {
    id: 'lot-1',
    fxTransactionId,
    currency: 'USD',
    originalAmount: 1000,
    remainingAmount: 1000,
    rate: 31.5,
    timestamp: now,
  }

  const snapshot = {
    timestamp: now,
    totalValueBase: 50000,
    currentFxRate: 31.5,
    cashBalances: [{ currency: 'USD', balance: 500 }],
    holdings: [{
      holdingId,
      shares: 1,
      pricePerShare: 100,
      marketValue: 100,
      marketValueBase: 3150,
      costBasis: 90,
      costBasisBase: 2835,
      allocationPct: 100,
      driftFromTarget: 0,
    }],
  }

  const operation: Operation = {
    id: operationId,
    portfolioId,
    type: 'BUY',
    timestamp: now,
    entries: [{
      holdingId,
      side: 'BUY',
      shares: 1,
      pricePerShare: 100,
      fees: 0,
      currency: 'USD',
    }],
    rationale: 'Initial buy',
    snapshotBefore: snapshot,
    snapshotAfter: snapshot,
  }

  const ammunitionPool: AmmunitionPool = {
    portfolioId,
    tier1: { holdingId, value: 1000, deployTriggerPct: 10 },
    tier2: { holdingId, value: 2000, deployTriggerPct: 20 },
  }

  const build: Build = {
    id: buildId,
    name: 'Build A',
    holdings: [{ ticker: 'VOO', name: 'VOO', currency: 'USD', targetAllocationPct: 100 }],
    dcaAmount: 1000,
    dcaCurrency: 'USD',
    dcaFrequency: 'monthly',
    startDate: now,
    endDate: now,
    rebalanceStrategy: 'soft',
    rebalanceTriggers: ['on-dca'],
    isFavorite: true,
    createdAt: now,
    updatedAt: now,
  }

  const benchmark: Benchmark = {
    id: benchmarkId,
    ticker: 'SPY',
    name: 'SPY',
    currency: 'USD',
    startDate: now,
    endDate: now,
    isFavorite: false,
    createdAt: now,
  }

  const compare: Compare = {
    id: compareId,
    name: 'Compare A',
    items: [{ type: 'build', refId: buildId }, { type: 'benchmark', refId: benchmarkId }],
    isFavorite: false,
    createdAt: now,
  }

  const entityLink: EntityLink = {
    id: 'link-1',
    sourceBuildId: buildId,
    targetFolioId: portfolioId,
    relationType: 'promoted_from',
    createdAt: now,
  }

  const labDraft: LabDraft = {
    id: 'singleton',
    buildA: {
      config: {
        name: 'A',
        holdings: [{ ticker: 'VOO', name: 'VOO', currency: 'USD', targetAllocationPct: 100 }],
        dcaAmount: '1000',
        dcaCurrency: 'USD',
        dcaFrequency: 'monthly',
        startDate: '2026-01-01',
        endDate: '2026-04-01',
        rebalanceStrategy: 'soft',
        rebalanceTriggers: ['on-dca'],
        thresholdPct: '5',
        periodicFrequency: 'monthly',
      },
      isStale: false,
    },
    buildB: {
      config: {
        name: 'B',
        holdings: [{ ticker: 'SPY', name: 'SPY', currency: 'USD', targetAllocationPct: 100 }],
        dcaAmount: '1000',
        dcaCurrency: 'USD',
        dcaFrequency: 'monthly',
        startDate: '2026-01-01',
        endDate: '2026-04-01',
        rebalanceStrategy: 'soft',
        rebalanceTriggers: ['on-dca'],
        thresholdPct: '5',
        periodicFrequency: 'monthly',
      },
      isStale: false,
    },
    sharedControls: {
      startDate: '2026-01-01',
      endDate: '2026-04-01',
      dcaCurrency: 'USD',
      dcaFrequency: 'monthly',
      dcaAmount: 1000,
    },
    updatedAt: now.toISOString(),
  }

  const priceCache: PriceCache = {
    ticker: 'VOO',
    startDate: now,
    endDate: now,
    interval: '1d',
    prices: [{ date: '2026-04-15', adjustedClose: 100 }],
    fetchedAt: now,
  }

  await db.portfolios.add(portfolio)
  await db.sleeves.add(sleeve)
  await db.holdings.add(holding)
  await db.cashAccounts.bulkAdd(cashAccounts)
  await db.fxTransactions.add(fxTransaction)
  await db.fxLots.add(fxLot)
  await db.operations.add(operation)
  await db.ammunitionPools.add(ammunitionPool)
  await db.snapshots.add({ id: 'snapshot-1', portfolioId, ...snapshot })
  await db.builds.add(build)
  await db.benchmarks.add(benchmark)
  await db.compares.add(compare)
  await db.entityLinks.add(entityLink)
  await db.labDraft.add(labDraft)
  await db.priceCaches.add(priceCache)
}

describe('backupService', () => {
  beforeEach(async () => {
    await clearAllTables()
  })

  it('imports legacy v1 backups while defaulting newer tables to empty', async () => {
    const now = '2026-04-15T00:00:00.000Z'
    await importBackupPayload({
      version: 1,
      exportedAt: now,
      data: {
        portfolios: [{
          id: 'portfolio-1',
          name: 'Legacy',
          baseCurrency: 'TWD',
          supportedCurrencies: ['TWD', 'USD'],
          monthlyDCABudget: 0,
          monthlyDCABudgetCurrency: 'USD',
          defaultRebalanceStrategy: 'soft',
          defaultAllocationMethod: 'proportional-to-drift',
          createdAt: new Date(now),
          updatedAt: new Date(now),
        }],
        holdings: [],
        sleeves: [],
        cashAccounts: [],
        fxTransactions: [],
        fxLots: [],
        operations: [],
        ammunitionPools: [],
        snapshots: [],
      },
    })

    expect(await db.portfolios.count()).toBe(1)
    expect(await db.builds.count()).toBe(0)
    expect(await db.entityLinks.count()).toBe(0)
    expect(await db.labDraft.count()).toBe(0)
  })

  it('round-trips v2 backups across all durable tables', async () => {
    await seedDurableData()

    const payload = await createBackupPayload()
    await clearAllTables()
    await importBackupPayload(payload)

    expect(payload.version).toBe(2)
    expect(await db.portfolios.count()).toBe(1)
    expect(await db.holdings.count()).toBe(1)
    expect(await db.operations.count()).toBe(1)
    expect(await db.builds.count()).toBe(1)
    expect(await db.benchmarks.count()).toBe(1)
    expect(await db.compares.count()).toBe(1)
    expect(await db.entityLinks.count()).toBe(1)
    expect(await db.labDraft.count()).toBe(1)
  })

  it('clears price cache on import because it is excluded from backups', async () => {
    await seedDurableData()
    const payload = await createBackupPayload()

    expect(await db.priceCaches.count()).toBe(1)
    await importBackupPayload(payload)

    expect(await db.priceCaches.count()).toBe(0)
  })
})
