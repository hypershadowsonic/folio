/**
 * performance.test.ts — unit tests for the pure performance engine.
 *
 * No React, no Dexie. All inputs are plain objects.
 *
 * Conventions:
 *   - All values in TWD unless stated otherwise
 *   - fxRate = 32 TWD per USD (constant throughout)
 *   - Day offsets from BASE_DATE (2024-01-01)
 */

import { describe, it, expect } from 'vitest'
import { calculateTWR, calculateMWR, xirr } from './performance'
import type { PortfolioSnapshot, Operation } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const FX = 32
const BASE_DATE = new Date('2024-01-01T00:00:00.000Z')

// ─── Fixture builders ─────────────────────────────────────────────────────────

function daysAfter(n: number): Date {
  return new Date(BASE_DATE.getTime() + n * 24 * 60 * 60 * 1000)
}

function makeSnapshot(dayOffset: number, totalValueBase: number): PortfolioSnapshot {
  return {
    timestamp: daysAfter(dayOffset),
    totalValueBase,
    currentFxRate: FX,
    cashBalances: [],
    holdings: [],
  }
}

function makeDeposit(dayOffset: number, amount: number, snapshotBeforeValue: number): Operation {
  return {
    id: `op-${dayOffset}`,
    portfolioId: 'p1',
    type: 'CASH_DEPOSIT',
    timestamp: daysAfter(dayOffset),
    entries: [],
    cashFlow: { currency: 'TWD', amount },
    rationale: 'deposit',
    snapshotBefore: makeSnapshot(dayOffset, snapshotBeforeValue),
    snapshotAfter:  makeSnapshot(dayOffset, snapshotBeforeValue + amount),
  }
}


// ─── Test 1: Simple TWR — no cash flows ──────────────────────────────────────

describe('calculateTWR — simple growth, no cash flows', () => {
  const snaps = [
    makeSnapshot(0,  100_000),
    makeSnapshot(90, 110_000),
  ]

  it('returns 10% TWR', () => {
    const result = calculateTWR(snaps, [], daysAfter(0), daysAfter(90), 'TWD', FX)
    expect(result.twrPct).toBeCloseTo(0.10, 6)
  })

  it('produces a single sub-period', () => {
    const result = calculateTWR(snaps, [], daysAfter(0), daysAfter(90), 'TWD', FX)
    expect(result.subPeriods).toHaveLength(1)
    expect(result.subPeriods[0].startValue).toBeCloseTo(100_000)
    expect(result.subPeriods[0].endValue).toBeCloseTo(110_000)
  })
})

// ─── Test 2: TWR with deposit mid-period ─────────────────────────────────────

describe('calculateTWR — deposit mid-period', () => {
  //  Day  0: portfolio = 100,000
  //  Day 30: portfolio = 105,000 (before deposit); deposit 50,000 → total 155,000
  //  Day 90: portfolio = 170,000
  //
  //  Sub-period 1 (day 0 → day 30):  r1 = 105,000/100,000 - 1 = 5%
  //  Sub-period 2 (day 30 → day 90): r2 = 170,000/155,000 - 1 ≈ 9.677%
  //  TWR = (1.05 × 1.09677) - 1 ≈ 15.16%

  const deposit = makeDeposit(30, 50_000, 105_000)
  const snaps   = [
    makeSnapshot(0,  100_000),
    makeSnapshot(30, 155_000),   // snapshot after deposit (for end-of-period lookup)
    makeSnapshot(90, 170_000),
  ]

  it('produces TWR ≈ 15.16%', () => {
    const result = calculateTWR(snaps, [deposit], daysAfter(0), daysAfter(90), 'TWD', FX)
    expect(result.twrPct).toBeCloseTo(0.1516, 3)
  })

  it('TWR is greater than naive return of 13.3%', () => {
    // Naive: (170,000 - 100,000 - 50,000) / (100,000 + 50,000) = 13.3%
    // TWR correctly strips out the timing of the deposit
    const result = calculateTWR(snaps, [deposit], daysAfter(0), daysAfter(90), 'TWD', FX)
    expect(result.twrPct).toBeGreaterThan(0.133)
  })

  it('splits into 2 sub-periods', () => {
    const result = calculateTWR(snaps, [deposit], daysAfter(0), daysAfter(90), 'TWD', FX)
    expect(result.subPeriods).toHaveLength(2)
    expect(result.subPeriods[0].returnPct).toBeCloseTo(0.05, 5)
    expect(result.subPeriods[1].returnPct).toBeCloseTo(170_000 / 155_000 - 1, 5)
  })
})

// ─── Test 3: TWR with zero starting value ─────────────────────────────────────

describe('calculateTWR — zero starting value', () => {
  //  Day 0: portfolio = 0 (empty)
  //  Day 5: deposit 100,000
  //  Day 90: portfolio = 108,000
  //
  //  Sub-period 1 (day 0 → day 5): startValue=0 → skip
  //  Sub-period 2 (day 5 → day 90): 108,000 / 100,000 - 1 = 8%

  const deposit = makeDeposit(5, 100_000, 0)
  const snaps = [
    makeSnapshot(0,  0),
    makeSnapshot(5,  100_000),
    makeSnapshot(90, 108_000),
  ]

  it('returns 8% (skipping the empty-portfolio sub-period)', () => {
    const result = calculateTWR(snaps, [deposit], daysAfter(0), daysAfter(90), 'TWD', FX)
    expect(result.twrPct).toBeCloseTo(0.08, 5)
  })
})

// ─── Test 4: MWR/XIRR — simple 1-year growth ─────────────────────────────────

describe('calculateMWR — simple 1-year investment', () => {
  //  Day 0:   invest 100,000 (starting portfolio value)
  //  Day 365: portfolio worth 112,000
  //  XIRR ≈ 12%

  // Provide a starting snapshot via a synthetic op so calculateMWR can find snapshotBefore
  const syntheticStartOp: Operation = {
    id: 'start',
    portfolioId: 'p1',
    type: 'BUY',
    timestamp: daysAfter(0),
    entries: [],
    rationale: 'initial',
    snapshotBefore: makeSnapshot(0, 100_000),
    snapshotAfter:  makeSnapshot(0, 100_000),
  }

  it('produces XIRR ≈ 12%', () => {
    const result = calculateMWR(
      [syntheticStartOp],
      112_000,
      daysAfter(365),
      daysAfter(0),
      'TWD',
      FX,
    )
    expect(result.annualizedPct).toBeCloseTo(0.12, 4)
  })

  it('mwrPct (simple ratio) is also ≈ 12%', () => {
    const result = calculateMWR(
      [syntheticStartOp],
      112_000,
      daysAfter(365),
      daysAfter(0),
      'TWD',
      FX,
    )
    expect(result.mwrPct).toBeCloseTo(0.12, 5)
  })
})

// ─── Test 5: MWR/XIRR — multiple cash flows ──────────────────────────────────

describe('calculateMWR — multiple cash flows', () => {
  //  Day 0:   invest 100,000 (via starting value)
  //  Day 180: deposit 50,000
  //  Day 365: portfolio worth 165,000
  //
  //  XIRR should discount the second investment less (half the time),
  //  giving approximately 10.9%.

  const deposit = makeDeposit(180, 50_000, 140_000)

  const startOp: Operation = {
    id: 'start',
    portfolioId: 'p1',
    type: 'BUY',
    timestamp: daysAfter(0),
    entries: [],
    rationale: 'initial',
    snapshotBefore: makeSnapshot(0, 100_000),
    snapshotAfter:  makeSnapshot(0, 100_000),
  }

  it('produces XIRR in the 10%–13% range (second investment had ~6 months to compound)', () => {
    // Manual verification:
    //   f(r) = -100k + (-50k)/(1+r)^(180/365) + 165k/(1+r)^1 = 0
    //   Solving: r ≈ 12.0% — the second 50k still had half a year to work,
    //   so XIRR is close to (but slightly above) a simple ratio.
    const result = calculateMWR(
      [startOp, deposit],
      165_000,
      daysAfter(365),
      daysAfter(0),
      'TWD',
      FX,
    )
    expect(result.annualizedPct).toBeGreaterThan(0.10)
    expect(result.annualizedPct).toBeLessThan(0.13)
  })

  it('includes 3 XIRR cash flows: initial, deposit, terminal', () => {
    const result = calculateMWR(
      [startOp, deposit],
      165_000,
      daysAfter(365),
      daysAfter(0),
      'TWD',
      FX,
    )
    expect(result.cashFlows).toHaveLength(3)
    expect(result.cashFlows[0].amount).toBeLessThan(0)   // initial investment (outflow)
    expect(result.cashFlows[1].amount).toBeLessThan(0)   // deposit (outflow)
    expect(result.cashFlows[2].amount).toBeGreaterThan(0) // terminal value (inflow)
  })
})

// ─── Test 6: MWR vs TWR divergence ───────────────────────────────────────────

describe('calculateTWR vs calculateMWR — bad-timing divergence', () => {
  //  Day 0:  invest 100,000; grows to 110,000 by day 30  (+10%)
  //  Day 30: deposit 100,000 → total 210,000; market then falls
  //  Day 90: value = 189,000
  //
  //  TWR:
  //    r1 = 110,000 / 100,000 - 1 = 10%
  //    r2 = 189,000 / 210,000 - 1 = -10%
  //    TWR = (1.10 × 0.90) - 1 = -1%
  //
  //  MWR: worse than TWR because the big deposit happened right before the drop

  const deposit = makeDeposit(30, 100_000, 110_000)

  const startOp: Operation = {
    id: 'start',
    portfolioId: 'p1',
    type: 'BUY',
    timestamp: daysAfter(0),
    entries: [],
    rationale: 'initial',
    snapshotBefore: makeSnapshot(0, 100_000),
    snapshotAfter:  makeSnapshot(0, 100_000),
  }

  const snaps = [
    makeSnapshot(0,  100_000),
    makeSnapshot(30, 210_000),   // after deposit
    makeSnapshot(90, 189_000),
  ]

  it('TWR ≈ -1%', () => {
    const result = calculateTWR(snaps, [deposit], daysAfter(0), daysAfter(90), 'TWD', FX)
    expect(result.twrPct).toBeCloseTo(-0.01, 5)
  })

  it('MWR annualized < TWR (bad timing amplifies loss for money-weighted)', () => {
    const twr = calculateTWR(snaps, [deposit], daysAfter(0), daysAfter(90), 'TWD', FX)
    const mwr = calculateMWR([startOp, deposit], 189_000, daysAfter(90), daysAfter(0), 'TWD', FX)
    expect(mwr.annualizedPct).toBeLessThan(twr.twrPct)
  })
})

// ─── Test 7: XIRR edge case — all outflows, no inflow ────────────────────────

describe('xirr — edge cases', () => {
  it('returns NaN gracefully when all flows are negative (no terminal inflow)', () => {
    const flows = [
      { date: daysAfter(0),   amount: -100_000 },
      { date: daysAfter(180), amount: -50_000  },
    ]
    const result = xirr(flows)
    expect(Number.isNaN(result)).toBe(true)
  })

  it('returns NaN for fewer than 2 cash flows', () => {
    expect(Number.isNaN(xirr([{ date: daysAfter(0), amount: -100_000 }]))).toBe(true)
    expect(Number.isNaN(xirr([]))).toBe(true)
  })

  it('does not throw or loop infinitely for degenerate inputs', () => {
    // All same date — zero time differences, so t_i = 0 for all
    const flows = [
      { date: daysAfter(0), amount: -100_000 },
      { date: daysAfter(0), amount:  100_000 },
    ]
    // Should return something finite or NaN but must not hang
    const result = xirr(flows)
    expect(typeof result).toBe('number')
  })
})
