import type { FxLot, OperationEntry } from '@/types'

// ─── Errors ───────────────────────────────────────────────────────────────────

export class InsufficientFxLotsError extends Error {
  readonly shortfall: number
  constructor(shortfall: number) {
    super(`Insufficient FX lots: short by ${shortfall}`)
    this.name = 'InsufficientFxLotsError'
    this.shortfall = shortfall
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConsumedLot {
  lotId: string
  amount: number
  rate: number
}

export interface ConsumeFxLotsResult {
  consumed: ConsumedLot[]
  blendedRate: number
  baseCurrencyCost: number
  updatedLots: FxLot[]
}

// ─── consumeFxLots ────────────────────────────────────────────────────────────

/**
 * Consumes FX lots in FIFO order (oldest first) to fulfil amountNeeded.
 * Returns which lots were consumed, the weighted-average blended rate,
 * the total base-currency cost, and the mutated lots array.
 *
 * Throws InsufficientFxLotsError if the lots don't cover the full amount.
 */
export function consumeFxLots(
  lots: FxLot[],
  amountNeeded: number,
): ConsumeFxLotsResult {
  const totalAvailable = lots.reduce((sum, l) => sum + l.remainingAmount, 0)
  if (totalAvailable < amountNeeded) {
    throw new InsufficientFxLotsError(amountNeeded - totalAvailable)
  }

  // Work on shallow copies so we don't mutate the originals
  const updatedLots: FxLot[] = lots.map(l => ({ ...l }))
  const consumed: ConsumedLot[] = []
  let remaining = amountNeeded

  for (const lot of updatedLots) {
    if (remaining <= 0) break
    if (lot.remainingAmount <= 0) continue

    const take = Math.min(lot.remainingAmount, remaining)
    consumed.push({ lotId: lot.id, amount: take, rate: lot.rate })
    lot.remainingAmount -= take
    remaining -= take
  }

  const baseCurrencyCost = consumed.reduce(
    (sum, c) => sum + c.amount * c.rate,
    0,
  )
  const blendedRate = baseCurrencyCost / amountNeeded

  return { consumed, blendedRate, baseCurrencyCost, updatedLots }
}

// ─── calculateFxCostBasis ─────────────────────────────────────────────────────

/**
 * Calculates fxCostBasis for a BUY trade in a foreign currency.
 * Returns undefined when no FX conversion is needed (tradeCurrency === baseCurrency).
 */
export function calculateFxCostBasis(
  lots: FxLot[],
  tradeCurrency: 'USD' | 'TWD',
  tradeAmount: number,
  baseCurrency: 'TWD',
): (OperationEntry['fxCostBasis'] & { updatedLots: FxLot[] }) | undefined {
  if (tradeCurrency === baseCurrency) return undefined

  const { consumed, blendedRate, baseCurrencyCost, updatedLots } =
    consumeFxLots(lots, tradeAmount)

  return {
    fxLotsConsumed: consumed,
    blendedRate,
    baseCurrencyCost,
    updatedLots,
  }
}

// ─── getLatestFxRate ──────────────────────────────────────────────────────────

/**
 * Returns the rate from the most recent FxLot (by timestamp), or null if empty.
 */
export function getLatestFxRate(lots: FxLot[]): number | null {
  if (lots.length === 0) return null
  const sorted = [...lots].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )
  return sorted[0].rate
}

// ─── getFxLotQueue ────────────────────────────────────────────────────────────

/**
 * Splits lots into available (remainingAmount > 0) and exhausted, both sorted
 * by timestamp ascending (FIFO order).
 */
export function getFxLotQueue(lots: FxLot[]): {
  available: FxLot[]
  exhausted: FxLot[]
} {
  const byTime = (a: FxLot, b: FxLot) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()

  const available = lots.filter(l => l.remainingAmount > 0).sort(byTime)
  const exhausted = lots.filter(l => l.remainingAmount <= 0).sort(byTime)
  return { available, exhausted }
}
