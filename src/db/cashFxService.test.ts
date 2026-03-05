/**
 * Integration test: full Phase 2 pipeline — deposit → FX exchange × 2 → FIFO consumption.
 *
 * Uses fake-indexeddb so Dexie runs in Node without a real browser.
 * Import order matters: fake-indexeddb/auto must be first so it polyfills
 * globalThis.indexedDB before any Dexie module initialises.
 */
import 'fake-indexeddb/auto'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FolioDB } from '@/db/database'
import type { Portfolio, CashAccount } from '@/types'

// ─── Isolated DB instance per test suite ──────────────────────────────────────
// We create a fresh FolioDB instance (fresh IDB store name) for each test so
// suites can't bleed into each other, without needing to reset the global IDB.

let testDb: FolioDB
let svc: typeof import('@/db/cashFxService')

async function freshEnv() {
  const { FolioDB } = await import('@/db/database')
  testDb = new FolioDB()

  // Monkey-patch the module-level `db` reference used by cashFxService
  // by re-importing after overriding the module's internal db export.
  // Because vitest reuses modules across imports in the same worker, we
  // instead directly exercise via helpers that accept a db param — OR we
  // seed the real singleton db and run everything through the exported API.
  //
  // Simpler approach: since fake-indexeddb is global, just clear all tables
  // on the real singleton `db` between tests.
  const dbModule = await import('@/db/database')
  const realDb = dbModule.db

  await realDb.portfolios.clear()
  await realDb.holdings.clear()
  await realDb.sleeves.clear()
  await realDb.cashAccounts.clear()
  await realDb.fxTransactions.clear()
  await realDb.fxLots.clear()
  await realDb.operations.clear()
  await realDb.snapshots.clear()

  svc = await import('@/db/cashFxService')
  return realDb
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedPortfolio(db: FolioDB, initialFxRate = 31.5): Promise<string> {
  const portfolioId = crypto.randomUUID()
  const now = new Date()

  const portfolio: Portfolio = {
    id: portfolioId,
    name: 'Test Portfolio',
    baseCurrency: 'TWD',
    supportedCurrencies: ['TWD', 'USD'],
    monthlyDCABudget: 0,
    monthlyDCABudgetCurrency: 'USD',
    defaultRebalanceStrategy: 'soft',
    defaultAllocationMethod: 'proportional-to-drift',
    initialFxRate,
    createdAt: now,
    updatedAt: now,
  }

  const cashAccounts: CashAccount[] = [
    { id: crypto.randomUUID(), portfolioId, currency: 'TWD', balance: 0 },
    { id: crypto.randomUUID(), portfolioId, currency: 'USD', balance: 0 },
  ]

  await db.transaction('rw', [db.portfolios, db.cashAccounts], async () => {
    await db.portfolios.add(portfolio)
    await db.cashAccounts.bulkAdd(cashAccounts)
  })

  return portfolioId
}

// ─── Main scenario ────────────────────────────────────────────────────────────

describe('Phase 2 end-to-end pipeline', () => {
  let db: FolioDB
  let portfolioId: string

  beforeEach(async () => {
    db = await freshEnv()
    portfolioId = await seedPortfolio(db)
  })

  afterEach(() => {
    void testDb?.close()
  })

  // ── Step 3 ──────────────────────────────────────────────────────────────────

  it('Step 3 — deposit TWD 200,000', async () => {
    await svc.recordCashDeposit(portfolioId, 'TWD', 200_000)

    const balances = await svc.getCashBalances(portfolioId)
    expect(balances.twd).toBe(200_000)
    expect(balances.usd).toBe(0)
  })

  // ── Step 4 + 5 ──────────────────────────────────────────────────────────────

  it('Step 4+5 — two FX exchanges yield correct balances and 2 lots', async () => {
    await svc.recordCashDeposit(portfolioId, 'TWD', 200_000)

    // Exchange 1: TWD 63,000 → USD 2,000 @ 31.5, fee 50 TWD
    await svc.recordFxExchange(portfolioId, {
      fromCurrency: 'TWD', fromAmount: 63_000,
      toCurrency:   'USD', toAmount:   2_000,
      rate: 31.5, fees: 50, feesCurrency: 'TWD',
      note: 'First conversion',
    })

    // Guarantee different timestamps (FIFO relies on timestamp ordering)
    await new Promise(r => setTimeout(r, 2))

    // Exchange 2: TWD 32,000 → USD 1,000 @ 32.0, fee 30 TWD
    await svc.recordFxExchange(portfolioId, {
      fromCurrency: 'TWD', fromAmount: 32_000,
      toCurrency:   'USD', toAmount:   1_000,
      rate: 32.0, fees: 30, feesCurrency: 'TWD',
      note: 'Second conversion',
    })

    // ── Step 6: balance assertions ──────────────────────────────────────────
    const balances = await svc.getCashBalances(portfolioId)

    // TWD: 200000 − (63000+50) − (32000+30) = 104,920
    expect(balances.twd).toBe(104_920)
    // USD: 2000 + 1000 = 3000
    expect(balances.usd).toBe(3_000)

    // ── FX Lot queue ────────────────────────────────────────────────────────
    const { available, exhausted } = await svc.getFxLotQueue(portfolioId, 'USD')
    expect(exhausted).toHaveLength(0)
    expect(available).toHaveLength(2)

    const [lot1, lot2] = available   // sorted by timestamp ASC = FIFO order
    expect(lot1.originalAmount).toBe(2_000)
    expect(lot1.rate).toBe(31.5)
    expect(lot1.remainingAmount).toBe(2_000)

    expect(lot2.originalAmount).toBe(1_000)
    expect(lot2.rate).toBe(32.0)
    expect(lot2.remainingAmount).toBe(1_000)

    // ── Latest FX rate ──────────────────────────────────────────────────────
    const latestRate = await svc.getLatestFxRate(portfolioId)
    expect(latestRate).toBe(32.0)
  })

  // ── Step 7 ──────────────────────────────────────────────────────────────────

  it('Step 7 — consumeFxLotsForTrade $2500 follows FIFO and returns correct blendedRate', async () => {
    await svc.recordCashDeposit(portfolioId, 'TWD', 200_000)

    await svc.recordFxExchange(portfolioId, {
      fromCurrency: 'TWD', fromAmount: 63_000,
      toCurrency:   'USD', toAmount:   2_000,
      rate: 31.5, fees: 50, feesCurrency: 'TWD',
    })
    await new Promise(r => setTimeout(r, 2))
    await svc.recordFxExchange(portfolioId, {
      fromCurrency: 'TWD', fromAmount: 32_000,
      toCurrency:   'USD', toAmount:   1_000,
      rate: 32.0, fees: 30, feesCurrency: 'TWD',
    })

    // Consume $2500:
    //   all of Lot1 ($2000 @ 31.5) + $500 from Lot2 (@ 32.0)
    //   baseCurrencyCost = 2000×31.5 + 500×32.0 = 63000 + 16000 = 79000
    //   blendedRate      = 79000 / 2500 = 31.6
    const fxCostBasis = await svc.consumeFxLotsForTrade(portfolioId, 'USD', 2_500)

    expect(fxCostBasis).toBeDefined()
    expect(fxCostBasis!.baseCurrencyCost).toBe(79_000)
    expect(fxCostBasis!.blendedRate).toBeCloseTo(31.6, 5)
    expect(fxCostBasis!.fxLotsConsumed).toHaveLength(2)
    expect(fxCostBasis!.fxLotsConsumed[0]).toMatchObject({ amount: 2_000, rate: 31.5 })
    expect(fxCostBasis!.fxLotsConsumed[1]).toMatchObject({ amount: 500,   rate: 32.0 })

    // ── Step 8: verify lot queue UI state ───────────────────────────────────
    const { available, exhausted } = await svc.getFxLotQueue(portfolioId, 'USD')
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0].rate).toBe(31.5)
    expect(exhausted[0].remainingAmount).toBe(0)

    expect(available).toHaveLength(1)
    expect(available[0].rate).toBe(32.0)
    expect(available[0].remainingAmount).toBe(500)
  })

  // ── Edge case: insufficient USD lots ────────────────────────────────────────

  it('consumeFxLotsForTrade throws InsufficientFxLotsError when lots < amount', async () => {
    await svc.recordCashDeposit(portfolioId, 'TWD', 200_000)
    await svc.recordFxExchange(portfolioId, {
      fromCurrency: 'TWD', fromAmount: 31_500,
      toCurrency:   'USD', toAmount:   1_000,
      rate: 31.5, fees: 0, feesCurrency: 'TWD',
    })

    // Try to consume more than available
    const { InsufficientFxLotsError } = await import('@/engine/fifo')
    await expect(
      svc.consumeFxLotsForTrade(portfolioId, 'USD', 5_000)
    ).rejects.toThrowError(InsufficientFxLotsError)
  })

  // ── Edge case: withdrawal blocked by insufficient balance ────────────────────

  it('recordCashWithdrawal throws InsufficientCashError when balance < amount', async () => {
    await svc.recordCashDeposit(portfolioId, 'TWD', 1_000)

    const { InsufficientCashError } = await import('@/db/cashFxService')
    await expect(
      svc.recordCashWithdrawal(portfolioId, 'TWD', 5_000)
    ).rejects.toThrowError(InsufficientCashError)

    // Balance must be unchanged after a failed withdrawal
    const balances = await svc.getCashBalances(portfolioId)
    expect(balances.twd).toBe(1_000)
  })

  // ── Snapshots embedded in operations ────────────────────────────────────────

  it('operations record accurate before/after cash snapshots', async () => {
    const depositOp = await svc.recordCashDeposit(portfolioId, 'TWD', 50_000)

    expect(depositOp.snapshotBefore.cashBalances.find(b => b.currency === 'TWD')?.balance).toBe(0)
    expect(depositOp.snapshotAfter.cashBalances.find(b => b.currency === 'TWD')?.balance).toBe(50_000)
    expect(depositOp.type).toBe('CASH_DEPOSIT')

    const fxOp = (await svc.recordFxExchange(portfolioId, {
      fromCurrency: 'TWD', fromAmount: 31_500,
      toCurrency:   'USD', toAmount:   1_000,
      rate: 31.5, fees: 0, feesCurrency: 'TWD',
    })).operation

    expect(fxOp.type).toBe('FX_EXCHANGE')
    expect(fxOp.snapshotBefore.cashBalances.find(b => b.currency === 'TWD')?.balance).toBe(50_000)
    // After FX: TWD = 50000 - 31500 = 18500
    expect(fxOp.snapshotAfter.cashBalances.find(b => b.currency === 'TWD')?.balance).toBe(18_500)
    expect(fxOp.snapshotAfter.cashBalances.find(b => b.currency === 'USD')?.balance).toBe(1_000)
  })
})
