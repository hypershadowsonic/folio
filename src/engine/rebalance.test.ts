/**
 * rebalance.test.ts — unit tests for the pure rebalance engine.
 *
 * All tests bypass Dexie/React entirely — just plain functions with plain objects.
 *
 * Portfolio conventions used throughout:
 *   fxRate = 32 TWD per USD
 *   totalPortfolioBase (TWD) is set per-test group — see comments.
 *   All HoldingState objects are built via the makeHolding() helper so that
 *   marketValue / marketValueBase / currentShares are internally consistent.
 */

import { describe, it, expect } from 'vitest'
import {
  generateSoftRebalancePlan,
  generateHardRebalancePlan,
  calculateCurrentAllocations,
  DUST_SHARES,
} from './rebalance'
import type { HoldingState } from './rebalance'
import type { Holding } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const FX = 32   // TWD per USD

// ─── Fixture builder ──────────────────────────────────────────────────────────

/**
 * Builds a HoldingState that is internally consistent:
 *   - currentShares = marketValue / price
 *   - marketValueBase = currentPct% × totalPortfolioBase
 *   - drift = currentPct - targetPct
 *
 * `totalPortfolioBase` should equal the sum of all marketValueBase values in the
 * portfolio (i.e., portfolioBase excluding cash, since tests use cash = 0).
 */
function makeHolding(
  id: string,
  ticker: string,
  currency: 'USD' | 'TWD',
  price: number,
  currentPct: number,
  targetPct: number,
  totalPortfolioBase: number,
): HoldingState {
  const marketValueBase = (currentPct / 100) * totalPortfolioBase
  const marketValue     = currency === 'USD' ? marketValueBase / FX : marketValueBase
  const currentShares   = marketValue / price
  return {
    holdingId:            id,
    ticker,
    sleeveId:             'sleeve-1',
    currency,
    currentShares,
    currentPricePerShare: price,
    targetAllocationPct:  targetPct,
    currentAllocationPct: currentPct,
    drift:                currentPct - targetPct,
    marketValue,
    marketValueBase,
  }
}

const NO_CASH = { twd: 0, usd: 0 }

// ─── Shared portfolio (Tests 1, 2, 4, 7) ─────────────────────────────────────
//
//  totalPortfolioBase = 1,000,000 TWD, no cash.
//  Targets sum to 100%.  VOO and SMH are underweight; GLDM is overweight.
//
//  holding  cur%  tgt%  drift  currency  price
//  VOO      35    40    -5     USD       $500
//  VHT      20    20     0     USD       $300
//  SMH      12    15    -3     USD       $250
//  0050     10    10     0     TWD       ฿180
//  GLDM     23    15    +8     USD       $50
//
//  Derived market values (@1,000,000 TWD total):
//    VOO:  350,000 TWD = $10,937.50 → 21.875 shares
//    VHT:  200,000 TWD = $6,250     → 20.833̄ shares
//    SMH:  120,000 TWD = $3,750     → 15 shares
//    0050: 100,000 TWD              → 555.5̄ shares
//    GLDM: 230,000 TWD = $7,187.50  → 143.75 shares

const TOTAL_1M = 1_000_000

const BASE_PORTFOLIO: HoldingState[] = [
  makeHolding('voo',  'VOO',  'USD', 500, 35, 40, TOTAL_1M),
  makeHolding('vht',  'VHT',  'USD', 300, 20, 20, TOTAL_1M),
  makeHolding('smh',  'SMH',  'USD', 250, 12, 15, TOTAL_1M),
  makeHolding('0050', '0050', 'TWD', 180, 10, 10, TOTAL_1M),
  makeHolding('gldm', 'GLDM', 'USD',  50, 23, 15, TOTAL_1M),
]

// ─── Test 1: Soft + proportional-to-drift ────────────────────────────────────

describe('generateSoftRebalancePlan – proportional-to-drift', () => {
  // $1,000 USD budget = 32,000 TWD.
  // Underweight: VOO (|drift|=5), SMH (|drift|=3). totalAbsDrift = 8.
  //   VOO gets 5/8 × $1,000 = $625 USD
  //   SMH gets 3/8 × $1,000 = $375 USD
  //   VHT, 0050, GLDM → HOLD (on target or overweight)

  const plan = generateSoftRebalancePlan(
    BASE_PORTFOLIO,
    1000,       // $1,000 USD
    'USD',
    FX,
    'proportional-to-drift',
    NO_CASH,
  )

  it('generates no SELL orders', () => {
    expect(plan.trades.every(t => t.action !== 'SELL')).toBe(true)
  })

  it('VOO gets 62.5% of budget (~$625)', () => {
    const voo = plan.trades.find(t => t.ticker === 'VOO')!
    expect(voo.action).toBe('BUY')
    expect(voo.suggestedAmount).toBeCloseTo(625, 4)
  })

  it('SMH gets 37.5% of budget (~$375)', () => {
    const smh = plan.trades.find(t => t.ticker === 'SMH')!
    expect(smh.action).toBe('BUY')
    expect(smh.suggestedAmount).toBeCloseTo(375, 4)
  })

  it('overweight GLDM is HOLD', () => {
    const gldm = plan.trades.find(t => t.ticker === 'GLDM')!
    expect(gldm.action).toBe('HOLD')
    expect(gldm.suggestedShares).toBe(0)
  })

  it('on-target VHT and 0050 are HOLD', () => {
    const vht  = plan.trades.find(t => t.ticker === 'VHT')!
    const t050 = plan.trades.find(t => t.ticker === '0050')!
    expect(vht.action).toBe('HOLD')
    expect(t050.action).toBe('HOLD')
  })

  it('total buy cost equals full $1,000 USD budget', () => {
    expect(plan.totalBuyCost.usd).toBeCloseTo(1000, 4)
    expect(plan.totalBuyCost.twd).toBeCloseTo(0, 4)
  })

  it('no sell proceeds', () => {
    expect(plan.totalSellProceeds.usd).toBe(0)
    expect(plan.totalSellProceeds.twd).toBe(0)
  })

  it('plan is cash sufficient (budget in same currency as buys)', () => {
    // availableUsd = 0 (cash) + 1000 (budget) = 1000 ≥ buyCost.usd 1000
    expect(plan.cashSufficiency.sufficient).toBe(true)
    expect(plan.cashSufficiency.shortfalls).toHaveLength(0)
  })
})

// ─── Test 2: Soft + equal-weight ─────────────────────────────────────────────

describe('generateSoftRebalancePlan – equal-weight', () => {
  // $1,000 USD budget split equally across 2 underweight holdings: $500 each.

  const plan = generateSoftRebalancePlan(
    BASE_PORTFOLIO,
    1000,
    'USD',
    FX,
    'equal-weight',
    NO_CASH,
  )

  it('generates no SELL orders', () => {
    expect(plan.trades.every(t => t.action !== 'SELL')).toBe(true)
  })

  it('VOO gets $500 (half the budget)', () => {
    const voo = plan.trades.find(t => t.ticker === 'VOO')!
    expect(voo.action).toBe('BUY')
    expect(voo.suggestedAmount).toBeCloseTo(500, 4)
    // shares = $500 / $500 = 1.0 share
    expect(voo.suggestedShares).toBeCloseTo(1, 4)
  })

  it('SMH gets $500 (half the budget)', () => {
    const smh = plan.trades.find(t => t.ticker === 'SMH')!
    expect(smh.action).toBe('BUY')
    expect(smh.suggestedAmount).toBeCloseTo(500, 4)
    // shares = $500 / $250 = 2.0 shares
    expect(smh.suggestedShares).toBeCloseTo(2, 4)
  })

  it('VHT, 0050, GLDM are HOLD', () => {
    const holds = plan.trades.filter(t => t.action === 'HOLD').map(t => t.ticker)
    expect(holds).toContain('VHT')
    expect(holds).toContain('0050')
    expect(holds).toContain('GLDM')
  })
})

// ─── Test 3: Hard rebalance – same currency, net cash flow ≈ 0 ───────────────

describe('generateHardRebalancePlan – USD sell proceeds fund USD buys', () => {
  //  Portfolio: 3,200,000 TWD total ($100,000 USD equivalent).
  //    VOO:  35% = 1,120,000 TWD = $35,000 → 70 shares,  target 40%,  drift -5%
  //    VHT:  20% on target (640,000 TWD)
  //    SMH:  15% on target (480,000 TWD)
  //    0050: 10% on target (320,000 TWD)
  //    GLDM: 20% = 640,000 TWD = $20,000 → 400 shares, target 15%, drift +5%
  //
  //  Hard rebalance, $0 budget:
  //    GLDM excess = 5% × 3,200,000 = $5,000 → sell 100 shares
  //    Proceeds (USD) fund VOO buy = $5,000 → buy 10 shares
  //    Net USD cash flow = 0

  const TOTAL_3_2M = 3_200_000
  const portfolio3: HoldingState[] = [
    makeHolding('voo',  'VOO',  'USD', 500, 35, 40, TOTAL_3_2M),
    makeHolding('vht',  'VHT',  'USD', 300, 20, 20, TOTAL_3_2M),
    makeHolding('smh',  'SMH',  'USD', 250, 15, 15, TOTAL_3_2M),
    makeHolding('0050', '0050', 'TWD', 180, 10, 10, TOTAL_3_2M),
    makeHolding('gldm', 'GLDM', 'USD',  50, 20, 15, TOTAL_3_2M),
  ]

  const plan = generateHardRebalancePlan(
    portfolio3,
    0,
    'USD',
    FX,
    'proportional-to-drift',
    NO_CASH,
  )

  it('GLDM gets a SELL order', () => {
    const gldm = plan.trades.find(t => t.ticker === 'GLDM')!
    expect(gldm.action).toBe('SELL')
    // excessBase = 5% × 3,200,000 = 160,000 TWD = $5,000 USD
    expect(gldm.suggestedAmount).toBeCloseTo(5000, 2)
    expect(gldm.suggestedShares).toBeCloseTo(100, 2)
  })

  it('VOO gets a BUY order funded by GLDM sell proceeds', () => {
    const voo = plan.trades.find(t => t.ticker === 'VOO')!
    expect(voo.action).toBe('BUY')
    expect(voo.suggestedAmount).toBeCloseTo(5000, 2)
    expect(voo.suggestedShares).toBeCloseTo(10, 2)
  })

  it('VHT, SMH, 0050 are HOLD', () => {
    const holds = plan.trades.filter(t => t.action === 'HOLD').map(t => t.ticker)
    expect(holds).toContain('VHT')
    expect(holds).toContain('SMH')
    expect(holds).toContain('0050')
  })

  it('sell proceeds equal buy cost (net cash flow ≈ 0)', () => {
    expect(plan.totalSellProceeds.usd).toBeCloseTo(5000, 2)
    expect(plan.totalBuyCost.usd).toBeCloseTo(5000, 2)
    expect(plan.netCashFlow.usd).toBeCloseTo(0, 2)
  })

  it('plan is cash sufficient (proceeds cover buys)', () => {
    expect(plan.cashSufficiency.sufficient).toBe(true)
  })
})

// ─── Test 4: Cash insufficiency – TWD budget, USD purchases ──────────────────

describe('generateSoftRebalancePlan – insufficient USD (TWD budget for USD holdings)', () => {
  //  Same BASE_PORTFOLIO (VOO and SMH underweight in USD).
  //  Budget: 64,000 TWD (~$2,000 USD equivalent), but budgetCurrency = 'TWD'.
  //  Cash: USD $500, TWD $0.
  //
  //  The engine allocates TWD budget to USD holdings (proportional-to-drift):
  //    VOO gets 5/8 × 64,000 = 40,000 TWD → $1,250 USD of buyCost
  //    SMH gets 3/8 × 64,000 = 24,000 TWD → $750 USD of buyCost
  //    buyCost.usd = $2,000
  //
  //  Cash sufficiency check:
  //    availableUsd = cashUSD(500) + 0 (budget is TWD, not USD) = $500
  //    $500 < $2,000 → insufficient, shortfall $1,500 USD

  const plan = generateSoftRebalancePlan(
    BASE_PORTFOLIO,
    64_000,     // TWD
    'TWD',
    FX,
    'proportional-to-drift',
    { twd: 0, usd: 500 },
  )

  it('plan is NOT cash sufficient', () => {
    expect(plan.cashSufficiency.sufficient).toBe(false)
  })

  it('shortfall is in USD', () => {
    expect(plan.cashSufficiency.shortfalls).toHaveLength(1)
    const sf = plan.cashSufficiency.shortfalls[0]
    expect(sf.currency).toBe('USD')
  })

  it('shortfall amount is $1,500 USD (need $2,000, have $500)', () => {
    const sf = plan.cashSufficiency.shortfalls[0]
    expect(sf.needed).toBeCloseTo(2000, 4)
    expect(sf.available).toBeCloseTo(500, 4)
    expect(sf.shortfall).toBeCloseTo(1500, 4)
  })

  it('shortfallConvertedHint mentions converting TWD', () => {
    const sf = plan.cashSufficiency.shortfalls[0]
    expect(sf.shortfallConvertedHint).toMatch(/TWD/i)
    // 1500 USD × 32 = 48,000 TWD
    expect(sf.shortfallConvertedHint).toMatch(/48,000/)
  })
})

// ─── Test 5: Cross-currency hard rebalance ────────────────────────────────────

describe('generateHardRebalancePlan – cross-currency: TWD sell proceeds cannot fund USD buys', () => {
  //  Portfolio: 1,000,000 TWD total, no cash.
  //    VOO:  35%, target 40%, drift -5%,  USD, $500 (underweight)
  //    VHT:  20%, target 20%, drift  0%,  USD, $300
  //    SMH:  15%, target 15%, drift  0%,  USD, $250
  //    0050: 15%, target 10%, drift +5%,  TWD, ฿180 (overweight)
  //    GLDM: 15%, target 15%, drift  0%,  USD, $50
  //
  //  Hard rebalance, $0 budget:
  //    0050 excess = 5% × 1,000,000 = 50,000 TWD → sell ≈277.78 shares
  //    Sell proceeds: 50,000 TWD
  //    VOO buy target: 50,000 TWD → ~$1,562.50 USD needed
  //
  //  Cash sufficiency:
  //    availableUsd = 0 (no USD cash, no USD sell proceeds, no USD budget) = 0
  //    buyCost.usd ≈ $1,562.50
  //    → insufficient; hint says "convert ~TWD 50,000"

  const TOTAL_1M2 = 1_000_000
  const portfolio5: HoldingState[] = [
    makeHolding('voo',  'VOO',  'USD', 500, 35, 40, TOTAL_1M2),
    makeHolding('vht',  'VHT',  'USD', 300, 20, 20, TOTAL_1M2),
    makeHolding('smh',  'SMH',  'USD', 250, 15, 15, TOTAL_1M2),
    makeHolding('0050', '0050', 'TWD', 180, 15, 10, TOTAL_1M2),
    makeHolding('gldm', 'GLDM', 'USD',  50, 15, 15, TOTAL_1M2),
  ]

  const plan = generateHardRebalancePlan(
    portfolio5,
    0,
    'TWD',
    FX,
    'proportional-to-drift',
    NO_CASH,
  )

  it('0050 gets a SELL order (TWD, overweight)', () => {
    const t050 = plan.trades.find(t => t.ticker === '0050')!
    expect(t050.action).toBe('SELL')
    // excess = 5% × 1,000,000 = 50,000 TWD → 50,000/180 ≈ 277.78 shares
    expect(t050.suggestedAmount).toBeCloseTo(50_000 / 180 * 180, 1)  // ≈50,000 TWD
    expect(t050.suggestedShares).toBeCloseTo(50_000 / 180, 2)
  })

  it('TWD sell proceeds are captured (~50,000 TWD)', () => {
    // excessBase = 5% × 1,000,000 = 50,000 TWD; sharesToSell = 50,000/180; proceeds = shares × 180 = 50,000
    expect(plan.totalSellProceeds.twd).toBeCloseTo(50_000, 0)
  })

  it('VOO gets a BUY order (USD, funded by TWD proceeds via engine conversion)', () => {
    const voo = plan.trades.find(t => t.ticker === 'VOO')!
    expect(voo.action).toBe('BUY')
    // 50,000 TWD ÷ 32 = $1,562.50 USD
    expect(voo.suggestedAmount).toBeCloseTo(50_000 / FX, 2)
  })

  it('plan is NOT cash sufficient (TWD proceeds cannot cover USD buy automatically)', () => {
    expect(plan.cashSufficiency.sufficient).toBe(false)
  })

  it('shortfall is in USD', () => {
    const sf = plan.cashSufficiency.shortfalls.find(s => s.currency === 'USD')
    expect(sf).toBeDefined()
    expect(sf!.shortfall).toBeCloseTo(50_000 / FX, 2)  // ~$1,562.50
  })

  it('shortfallConvertedHint references TWD conversion', () => {
    const sf = plan.cashSufficiency.shortfalls.find(s => s.currency === 'USD')!
    expect(sf.shortfallConvertedHint).toMatch(/TWD/)
    expect(sf.shortfallConvertedHint).toMatch(/convert/)
  })
})

// ─── Test 6: All holdings on target ──────────────────────────────────────────

describe('generateSoftRebalancePlan – all holdings on target', () => {
  //  Every holding is exactly at target; $1,000 USD budget.
  //
  //  New behaviour (edge case 2 fix): when no holdings are underweight,
  //  the engine falls back to at-target (drift = 0) holdings so the budget
  //  is never silently discarded. Proportional-to-drift with all drifts = 0
  //  falls back to proportional-to-target weighting.
  //
  //  Portfolio: 5 holdings, targets sum to 100%.
  //    VOO  40%, VHT 20%, SMH 15%, 0050 10%, GLDM 15%
  //
  //  Proportional-to-target allocation of $1,000 USD (= 32,000 TWD base):
  //    VOO  (40%): 12,800 TWD base → $400 USD → 0.800 shares
  //    VHT  (20%):  6,400 TWD base → $200 USD → 0.667 shares
  //    SMH  (15%):  4,800 TWD base → $150 USD → 0.600 shares
  //    0050 (10%):  3,200 TWD base → 3,200 TWD (currency is TWD) → 17.78 shares
  //    GLDM (15%):  4,800 TWD base → $150 USD → 3.000 shares
  //
  //  Equal-weight allocation ($1,000 USD = 32,000 TWD base ÷ 5 = 6,400 TWD each):
  //    USD holdings: $200 each; 0050: 6,400 TWD.

  const TOTAL_AT_TARGET = 1_000_000
  const atTarget: HoldingState[] = [
    makeHolding('voo',  'VOO',  'USD', 500, 40, 40, TOTAL_AT_TARGET),
    makeHolding('vht',  'VHT',  'USD', 300, 20, 20, TOTAL_AT_TARGET),
    makeHolding('smh',  'SMH',  'USD', 250, 15, 15, TOTAL_AT_TARGET),
    makeHolding('0050', '0050', 'TWD', 180, 10, 10, TOTAL_AT_TARGET),
    makeHolding('gldm', 'GLDM', 'USD',  50, 15, 15, TOTAL_AT_TARGET),
  ]

  const softPlan  = generateSoftRebalancePlan(atTarget, 1000, 'USD', FX, 'proportional-to-drift', NO_CASH)
  const equalPlan = generateSoftRebalancePlan(atTarget, 1000, 'USD', FX, 'equal-weight', NO_CASH)

  it('soft proportional: all trades are BUY (fallback to target-proportional when drift = 0)', () => {
    expect(softPlan.trades.every(t => t.action === 'BUY')).toBe(true)
  })

  it('soft proportional: VOO gets 40% of budget ($400)', () => {
    const voo = softPlan.trades.find(t => t.ticker === 'VOO')!
    expect(voo.suggestedAmount).toBeCloseTo(400, 2)
    expect(voo.suggestedShares).toBeCloseTo(0.8, 4)
  })

  it('soft proportional: GLDM gets 15% of budget ($150)', () => {
    const gldm = softPlan.trades.find(t => t.ticker === 'GLDM')!
    expect(gldm.suggestedAmount).toBeCloseTo(150, 2)
    expect(gldm.suggestedShares).toBeCloseTo(3, 4)
  })

  it('soft equal-weight: all trades are BUY', () => {
    expect(equalPlan.trades.every(t => t.action === 'BUY')).toBe(true)
  })

  it('soft equal-weight: each USD holding gets $200', () => {
    const voo = equalPlan.trades.find(t => t.ticker === 'VOO')!
    expect(voo.suggestedAmount).toBeCloseTo(200, 2)
    expect(voo.suggestedShares).toBeCloseTo(0.4, 4)
  })

  it('hard: no sells and no buys when all on target with zero budget', () => {
    // Hard with $0 budget: buyableBase = 0, no underweight → all HOLD (correct)
    const hardPlan = generateHardRebalancePlan(atTarget, 0, 'USD', FX, 'proportional-to-drift', NO_CASH)
    expect(hardPlan.trades.every(t => t.action === 'HOLD')).toBe(true)
    expect(hardPlan.totalSellProceeds.usd).toBe(0)
    expect(hardPlan.totalBuyCost.usd).toBe(0)
  })
})

// ─── Test 9: All holdings overweight (no buys in soft strategy) ───────────────

describe('generateSoftRebalancePlan – all holdings overweight', () => {
  //  Edge case 6: all holdings have drift > 0 (e.g., target allocations were
  //  reduced or cash is counted elsewhere).  Soft strategy never buys overweight
  //  holdings — eligible set is empty → all HOLD, zero buy cost.

  const TOTAL_OW = 1_000_000
  const allOverweight: HoldingState[] = [
    // cur% > tgt% for all
    makeHolding('voo',  'VOO',  'USD', 500, 45, 40, TOTAL_OW),
    makeHolding('vht',  'VHT',  'USD', 300, 25, 20, TOTAL_OW),
    makeHolding('gldm', 'GLDM', 'USD',  50, 30, 15, TOTAL_OW),  // extreme overweight
  ]

  const plan = generateSoftRebalancePlan(allOverweight, 1000, 'USD', FX, 'proportional-to-drift', NO_CASH)

  it('all trades are HOLD (no eligible underweight or at-target holdings)', () => {
    expect(plan.trades.every(t => t.action === 'HOLD')).toBe(true)
  })

  it('zero buy cost (budget unused)', () => {
    expect(plan.totalBuyCost.usd).toBe(0)
    expect(plan.totalBuyCost.twd).toBe(0)
  })

  it('all HOLD reasons mention overweight', () => {
    expect(plan.trades.every(t => t.reason.toLowerCase().includes('overweight'))).toBe(true)
  })
})

// ─── Test 10: Holding with price = 0 ─────────────────────────────────────────

describe('edge case: holding with price = 0', () => {
  //  Edge case 4: one holding has no price yet. It must be HOLDed with a clear
  //  reason. The remaining holdings receive normal allocation. A plan-level
  //  warning must be present.

  const TOTAL = 1_000_000
  const withNullPrice: HoldingState[] = [
    makeHolding('voo',  'VOO',  'USD', 500, 35, 50, TOTAL),  // underweight
    { // no price yet
      holdingId: 'new', ticker: 'NEW', sleeveId: 'sleeve-1', currency: 'USD',
      currentShares: 0, currentPricePerShare: 0,
      targetAllocationPct: 50, currentAllocationPct: 0,
      drift: -50, marketValue: 0, marketValueBase: 0,
    },
  ]

  const plan = generateSoftRebalancePlan(withNullPrice, 1000, 'USD', FX, 'proportional-to-drift', NO_CASH)

  it('zero-price holding is HOLD', () => {
    const newH = plan.trades.find(t => t.ticker === 'NEW')!
    expect(newH.action).toBe('HOLD')
    expect(newH.suggestedShares).toBe(0)
  })

  it('zero-price holding reason mentions price data', () => {
    const newH = plan.trades.find(t => t.ticker === 'NEW')!
    expect(newH.reason.toLowerCase()).toMatch(/price/)
  })

  it('non-zero-price holding still gets a BUY', () => {
    const voo = plan.trades.find(t => t.ticker === 'VOO')!
    expect(voo.action).toBe('BUY')
    expect(voo.suggestedShares).toBeGreaterThan(0)
    expect(isFinite(voo.suggestedShares)).toBe(true)
    expect(isNaN(voo.suggestedShares)).toBe(false)
  })

  it('plan includes a warning about the no-price holding', () => {
    expect(plan.warnings.length).toBeGreaterThan(0)
    expect(plan.warnings.some(w => w.toLowerCase().includes('price'))).toBe(true)
  })
})

// ─── Test 11: Dust threshold ──────────────────────────────────────────────────

describe('edge case: budget too small — dust trades become HOLD', () => {
  //  Edge case 5: very small budget → suggested shares < DUST_SHARES.
  //  VOO at $500/share: to get < 0.0001 shares need < $0.05 budget.
  //  Use $0.01 budget; both underweight holdings receive < DUST_SHARES → HOLD.

  const TOTAL = 1_000_000
  const twoUnderweight: HoldingState[] = [
    makeHolding('voo', 'VOO', 'USD', 500, 35, 50, TOTAL),  // drift -15
    makeHolding('smh', 'SMH', 'USD', 250, 15, 50, TOTAL),  // drift -35
  ]

  const plan = generateSoftRebalancePlan(twoUnderweight, 0.01, 'USD', FX, 'proportional-to-drift', NO_CASH)

  it('all trades are HOLD (shares below dust threshold)', () => {
    expect(plan.trades.every(t => t.action === 'HOLD')).toBe(true)
  })

  it('dust reason mentions amount too small', () => {
    expect(plan.trades.some(t => t.reason.toLowerCase().includes('amount too small'))).toBe(true)
  })

  it('plan includes a dust warning', () => {
    expect(plan.warnings.some(w => w.toLowerCase().includes('dust') || w.toLowerCase().includes('threshold'))).toBe(true)
  })

  it('DUST_SHARES constant is exported and equals 0.0001', () => {
    expect(DUST_SHARES).toBe(0.0001)
  })
})

// ─── Test 7: projectedAllocationPct moves toward target ──────────────────────

describe('projectedAllocationPct converges toward target after soft plan', () => {
  //  BASE_PORTFOLIO: VOO 35%→40% (drift -5%), SMH 12%→15% (drift -3%).
  //  $1,000 USD budget (proportional-to-drift).
  //
  //  Projected portfolio total = 1,000,000 + 1,000 × 32 = 1,032,000 TWD.
  //  VOO gets $625: new shares = 21.875 + 1.25 = 23.125
  //    projectedBase = 23.125 × 500 × 32 = 370,000 TWD
  //    projectedPct  = 370,000 / 1,032,000 ≈ 35.85% (was 35%, target 40%)
  //  SMH gets $375: new shares = 15 + 1.5 = 16.5
  //    projectedBase = 16.5 × 250 × 32 = 132,000 TWD
  //    projectedPct  = 132,000 / 1,032,000 ≈ 12.79% (was 12%, target 15%)

  const plan = generateSoftRebalancePlan(
    BASE_PORTFOLIO,
    1000,
    'USD',
    FX,
    'proportional-to-drift',
    NO_CASH,
  )

  it('VOO projected allocation is closer to target 40% than current 35%', () => {
    const voo = plan.trades.find(t => t.ticker === 'VOO')!
    const distBefore  = Math.abs(voo.currentAllocationPct   - voo.targetAllocationPct)
    const distAfter   = Math.abs(voo.projectedAllocationPct - voo.targetAllocationPct)
    expect(distAfter).toBeLessThan(distBefore)
    // Concrete check: projected ≈ 35.85%
    expect(voo.projectedAllocationPct).toBeCloseTo(
      (23.125 * 500 * FX) / (TOTAL_1M + 1000 * FX) * 100,
      2,
    )
  })

  it('SMH projected allocation is closer to target 15% than current 12%', () => {
    const smh = plan.trades.find(t => t.ticker === 'SMH')!
    const distBefore  = Math.abs(smh.currentAllocationPct   - smh.targetAllocationPct)
    const distAfter   = Math.abs(smh.projectedAllocationPct - smh.targetAllocationPct)
    expect(distAfter).toBeLessThan(distBefore)
    // Concrete check: projected ≈ 12.79%
    expect(smh.projectedAllocationPct).toBeCloseTo(
      (16.5 * 250 * FX) / (TOTAL_1M + 1000 * FX) * 100,
      2,
    )
  })

  it('GLDM (HOLD) projected allocation shifts down slightly due to portfolio growth', () => {
    const gldm = plan.trades.find(t => t.ticker === 'GLDM')!
    // Total grew, GLDM shares unchanged → its % shrinks
    expect(gldm.projectedAllocationPct).toBeLessThan(gldm.currentAllocationPct)
  })
})

// ─── Test 8: calculateCurrentAllocations integration ─────────────────────────

describe('calculateCurrentAllocations', () => {
  //  Build from raw Holding[] — verify it derives the same allocations as the
  //  hand-crafted fixtures and sorts by drift ascending (most underweight first).

  const rawHoldings: Holding[] = [
    {
      id: 'voo', portfolioId: 'p1', ticker: 'VOO', name: 'Vanguard S&P 500',
      sleeveId: 's1', targetAllocationPct: 40, driftThresholdPct: 2,
      currency: 'USD', currentShares: 21.875, currentPricePerShare: 500, status: 'active',
    },
    {
      id: 'vht', portfolioId: 'p1', ticker: 'VHT', name: 'Vanguard Healthcare',
      sleeveId: 's1', targetAllocationPct: 20, driftThresholdPct: 2,
      currency: 'USD', currentShares: 200_000 / FX / 300, currentPricePerShare: 300, status: 'active',
    },
    {
      id: 'smh', portfolioId: 'p1', ticker: 'SMH', name: 'Semiconductor ETF',
      sleeveId: 's1', targetAllocationPct: 15, driftThresholdPct: 2,
      currency: 'USD', currentShares: 15, currentPricePerShare: 250, status: 'active',
    },
    {
      id: '0050', portfolioId: 'p1', ticker: '0050', name: 'Taiwan 50',
      sleeveId: 's1', targetAllocationPct: 10, driftThresholdPct: 2,
      currency: 'TWD', currentShares: 100_000 / 180, currentPricePerShare: 180, status: 'active',
    },
    {
      id: 'gldm', portfolioId: 'p1', ticker: 'GLDM', name: 'Gold ETF',
      sleeveId: 's1', targetAllocationPct: 15, driftThresholdPct: 2,
      currency: 'USD', currentShares: 143.75, currentPricePerShare: 50, status: 'active',
    },
  ]

  const states = calculateCurrentAllocations(rawHoldings, FX)

  it('returns one state per holding', () => {
    expect(states).toHaveLength(5)
  })

  it('sorted ascending by drift (most underweight first)', () => {
    for (let i = 1; i < states.length; i++) {
      expect(states[i].drift).toBeGreaterThanOrEqual(states[i - 1].drift)
    }
  })

  it('VOO drift ≈ -5%', () => {
    const voo = states.find(s => s.ticker === 'VOO')!
    expect(voo.drift).toBeCloseTo(-5, 1)
  })

  it('GLDM drift ≈ +8%', () => {
    const gldm = states.find(s => s.ticker === 'GLDM')!
    expect(gldm.drift).toBeCloseTo(8, 1)
  })

  it('allocation percentages sum to 100%', () => {
    const total = states.reduce((s, h) => s + h.currentAllocationPct, 0)
    expect(total).toBeCloseTo(100, 4)
  })

  it('marketValueBase matches shares × price × fxRate (USD) or shares × price (TWD)', () => {
    for (const s of states) {
      const expected = s.currency === 'USD'
        ? s.currentShares * s.currentPricePerShare * FX
        : s.currentShares * s.currentPricePerShare
      expect(s.marketValueBase).toBeCloseTo(expected, 2)
    }
  })
})
