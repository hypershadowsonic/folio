import { describe, it, expect } from 'vitest'
import {
  applyCashEffect,
  calculateTradesCashEffect,
  calculateFxCashEffect,
  checkCashSufficiency,
  InsufficientCashError,
} from './cash'

describe('calculateTradesCashEffect + applyCashEffect', () => {
  it('Test 1: BUY reduces cash', () => {
    const balances = new Map<string, number>([['USD', 5000]])
    const effects = calculateTradesCashEffect([
      { side: 'BUY', currency: 'USD', shares: 10, pricePerShare: 450, fees: 1 },
    ])
    // effect = -(10 × 450 + 1) = -4501
    expect(effects).toHaveLength(1)
    expect(effects[0]).toEqual({ currency: 'USD', amount: -4501 })

    const updated = applyCashEffect(balances, effects[0])
    expect(updated.get('USD')).toBe(499)
  })

  it('Test 2: SELL increases cash', () => {
    const balances = new Map<string, number>([['USD', 1000]])
    const effects = calculateTradesCashEffect([
      { side: 'SELL', currency: 'USD', shares: 5, pricePerShare: 200, fees: 1 },
    ])
    // effect = +(5 × 200 - 1) = +999
    expect(effects[0]).toEqual({ currency: 'USD', amount: 999 })

    const updated = applyCashEffect(balances, effects[0])
    expect(updated.get('USD')).toBe(1999)
  })
})

describe('calculateFxCashEffect', () => {
  it('Test 3: FX exchange TWD→USD with TWD fee', () => {
    // Convert 31500 TWD → 1000 USD, fee 30 TWD
    const effects = calculateFxCashEffect('TWD', 31500, 'USD', 1000, 30, 'TWD')

    // fromEffect: -(31500 + 30) = -31530
    // toEffect:   +1000 (fee not on USD side)
    expect(effects).toHaveLength(2)
    const twd = effects.find(e => e.currency === 'TWD')!
    const usd = effects.find(e => e.currency === 'USD')!
    expect(twd.amount).toBe(-31530)
    expect(usd.amount).toBe(1000)

    // Apply to balances: TWD 100000, USD 0
    let balances = new Map<string, number>([['TWD', 100000], ['USD', 0]])
    balances = applyCashEffect(balances, twd)
    balances = applyCashEffect(balances, usd)
    expect(balances.get('TWD')).toBe(68470)
    expect(balances.get('USD')).toBe(1000)
  })
})

describe('checkCashSufficiency', () => {
  it('Test 4: Insufficient cash blocks trade', () => {
    const balances = new Map<string, number>([['USD', 500]])
    const effects = calculateTradesCashEffect([
      { side: 'BUY', currency: 'USD', shares: 10, pricePerShare: 100, fees: 0 },
    ])
    // effect = -1000
    const result = checkCashSufficiency(balances, effects)

    expect(result.sufficient).toBe(false)
    expect(result.shortfalls).toHaveLength(1)
    expect(result.shortfalls[0]).toMatchObject({
      currency: 'USD',
      needed: 1000,
      available: 500,
      shortfall: 500,
    })
  })

  it('Test 5: Multi-currency trade plan — sufficient', () => {
    const balances = new Map<string, number>([['TWD', 50000], ['USD', 3000]])
    const effects = calculateTradesCashEffect([
      // BUY $2000 USD holding (no fees for simplicity)
      { side: 'BUY', currency: 'USD', shares: 1, pricePerShare: 2000, fees: 0 },
      // BUY 30000 TWD holding
      { side: 'BUY', currency: 'TWD', shares: 1, pricePerShare: 30000, fees: 0 },
    ])
    const result = checkCashSufficiency(balances, effects)

    expect(result.sufficient).toBe(true)
    expect(result.shortfalls).toHaveLength(0)
  })
})

describe('applyCashEffect error handling', () => {
  it('Throws InsufficientCashError when balance would go negative', () => {
    const balances = new Map<string, number>([['USD', 100]])
    expect(() =>
      applyCashEffect(balances, { currency: 'USD', amount: -200 }),
    ).toThrowError(InsufficientCashError)

    try {
      applyCashEffect(balances, { currency: 'USD', amount: -200 })
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientCashError)
      expect((err as InsufficientCashError).shortfall).toBe(100)
      expect((err as InsufficientCashError).currency).toBe('USD')
    }
  })
})
