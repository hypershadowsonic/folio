import { describe, it, expect } from 'vitest'
import {
  consumeFxLots,
  calculateFxCostBasis,
  getLatestFxRate,
  getFxLotQueue,
  InsufficientFxLotsError,
} from './fifo'
import type { FxLot } from '@/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLot(
  id: string,
  amount: number,
  rate: number,
  offsetMs = 0,
): FxLot {
  return {
    id,
    fxTransactionId: `tx-${id}`,
    currency: 'USD',
    originalAmount: amount,
    remainingAmount: amount,
    rate,
    timestamp: new Date(1_000_000 + offsetMs),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('consumeFxLots', () => {
  it('Test 1: Single lot, exact consumption', () => {
    const lots = [makeLot('A', 1000, 31.5)]
    const result = consumeFxLots(lots, 1000)

    expect(result.blendedRate).toBe(31.5)
    expect(result.baseCurrencyCost).toBe(31500)
    expect(result.consumed).toHaveLength(1)
    expect(result.consumed[0]).toMatchObject({ lotId: 'A', amount: 1000, rate: 31.5 })
    expect(result.updatedLots[0].remainingAmount).toBe(0)
  })

  it('Test 2: Single lot, partial consumption', () => {
    const lots = [makeLot('A', 1000, 31.5)]
    const result = consumeFxLots(lots, 400)

    expect(result.blendedRate).toBe(31.5)
    expect(result.baseCurrencyCost).toBe(12600)
    expect(result.consumed[0]).toMatchObject({ lotId: 'A', amount: 400, rate: 31.5 })
    expect(result.updatedLots[0].remainingAmount).toBe(600)
  })

  it('Test 3: Multiple lots, FIFO order', () => {
    const lots = [
      makeLot('A', 500, 31.5, 0),   // oldest
      makeLot('B', 500, 32.0, 100),
      makeLot('C', 500, 31.8, 200),
    ]
    const result = consumeFxLots(lots, 800)

    // Should consume all of A ($500 × 31.5) + $300 from B ($300 × 32.0)
    expect(result.consumed).toHaveLength(2)
    expect(result.consumed[0]).toMatchObject({ lotId: 'A', amount: 500, rate: 31.5 })
    expect(result.consumed[1]).toMatchObject({ lotId: 'B', amount: 300, rate: 32.0 })

    const expectedCost = 500 * 31.5 + 300 * 32.0   // 15750 + 9600 = 25350
    expect(result.baseCurrencyCost).toBe(expectedCost)

    const expectedBlended = expectedCost / 800        // 31.6875
    expect(result.blendedRate).toBeCloseTo(expectedBlended, 6)

    expect(result.updatedLots[0].remainingAmount).toBe(0)    // A exhausted
    expect(result.updatedLots[1].remainingAmount).toBe(200)  // B partial
    expect(result.updatedLots[2].remainingAmount).toBe(500)  // C untouched
  })

  it('Test 4: Insufficient lots throws InsufficientFxLotsError', () => {
    const lots = [makeLot('A', 500, 31.5), makeLot('B', 500, 32.0)]
    expect(() => consumeFxLots(lots, 1500)).toThrowError(InsufficientFxLotsError)

    try {
      consumeFxLots(lots, 1500)
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientFxLotsError)
      expect((err as InsufficientFxLotsError).shortfall).toBe(500)
    }
  })
})

describe('calculateFxCostBasis', () => {
  it('Test 5: No FX needed for base currency trade returns undefined', () => {
    const lots = [makeLot('A', 1000, 31.5)]
    const result = calculateFxCostBasis(lots, 'TWD', 500, 'TWD')
    expect(result).toBeUndefined()
  })

  it('Returns fxCostBasis for foreign-currency trade', () => {
    const lots = [makeLot('A', 1000, 31.5)]
    const result = calculateFxCostBasis(lots, 'USD', 500, 'TWD')

    expect(result).toBeDefined()
    expect(result!.blendedRate).toBe(31.5)
    expect(result!.baseCurrencyCost).toBe(15750)
    expect(result!.fxLotsConsumed).toHaveLength(1)
    expect(result!.updatedLots[0].remainingAmount).toBe(500)
  })
})

describe('getLatestFxRate', () => {
  it('Returns null for empty lots', () => {
    expect(getLatestFxRate([])).toBeNull()
  })

  it('Returns rate from most recent lot', () => {
    const lots = [
      makeLot('A', 500, 31.5, 0),
      makeLot('B', 500, 32.0, 200),  // newest
      makeLot('C', 500, 31.8, 100),
    ]
    expect(getLatestFxRate(lots)).toBe(32.0)
  })
})

describe('getFxLotQueue', () => {
  it('Splits into available and exhausted', () => {
    const lots = [
      makeLot('A', 500, 31.5, 0),
      { ...makeLot('B', 500, 32.0, 100), remainingAmount: 0 },
      makeLot('C', 300, 31.8, 200),
    ]
    const { available, exhausted } = getFxLotQueue(lots)

    expect(available.map(l => l.id)).toEqual(['A', 'C'])
    expect(exhausted.map(l => l.id)).toEqual(['B'])
  })
})
