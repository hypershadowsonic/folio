// ─── Types ────────────────────────────────────────────────────────────────────

export interface CashEffect {
  currency: 'USD' | 'TWD'
  amount: number // positive = inflow, negative = outflow
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class InsufficientCashError extends Error {
  readonly currency: string
  readonly shortfall: number
  constructor(currency: string, shortfall: number) {
    super(`Insufficient ${currency} cash: short by ${shortfall}`)
    this.name = 'InsufficientCashError'
    this.currency = currency
    this.shortfall = shortfall
  }
}

// ─── applyCashEffect ──────────────────────────────────────────────────────────

/**
 * Applies a single CashEffect to a balances map.
 * Returns a new Map — the original is not mutated.
 * Throws InsufficientCashError if the resulting balance would go negative.
 */
export function applyCashEffect(
  balances: Map<string, number>,
  effect: CashEffect,
): Map<string, number> {
  const current = balances.get(effect.currency) ?? 0
  const next = current + effect.amount
  if (next < 0) {
    throw new InsufficientCashError(effect.currency, -next)
  }
  const result = new Map(balances)
  result.set(effect.currency, next)
  return result
}

// ─── calculateTradesCashEffect ────────────────────────────────────────────────

interface TradeEntry {
  side: 'BUY' | 'SELL'
  currency: 'USD' | 'TWD'
  shares: number
  pricePerShare: number
  fees: number
}

/**
 * Derives cash effects from a list of trade entries.
 * BUY  → outflow of (shares × pricePerShare + fees)
 * SELL → inflow  of (shares × pricePerShare - fees)
 * Returns one CashEffect per affected currency (amounts summed).
 */
export function calculateTradesCashEffect(entries: TradeEntry[]): CashEffect[] {
  const totals = new Map<'USD' | 'TWD', number>()

  for (const e of entries) {
    const gross = e.shares * e.pricePerShare
    const net = e.side === 'BUY' ? -(gross + e.fees) : gross - e.fees
    totals.set(e.currency, (totals.get(e.currency) ?? 0) + net)
  }

  return Array.from(totals.entries()).map(([currency, amount]) => ({
    currency,
    amount,
  }))
}

// ─── calculateFxCashEffect ────────────────────────────────────────────────────

/**
 * Derives cash effects from an FX conversion.
 * Returns two effects: outflow on fromCurrency, inflow on toCurrency.
 * Fees are deducted from the feesCurrency side.
 */
export function calculateFxCashEffect(
  fromCurrency: 'USD' | 'TWD',
  fromAmount: number,
  toCurrency: 'USD' | 'TWD',
  toAmount: number,
  fees: number,
  feesCurrency: 'USD' | 'TWD',
): CashEffect[] {
  const fromEffect = -(fromAmount + (feesCurrency === fromCurrency ? fees : 0))
  const toEffect = toAmount - (feesCurrency === toCurrency ? fees : 0)

  return [
    { currency: fromCurrency, amount: fromEffect },
    { currency: toCurrency, amount: toEffect },
  ]
}

// ─── checkCashSufficiency ─────────────────────────────────────────────────────

export interface CashShortfall {
  currency: string
  needed: number
  available: number
  shortfall: number
}

export interface SufficiencyResult {
  sufficient: boolean
  shortfalls: CashShortfall[]
}

/**
 * Checks whether all negative CashEffects can be covered by the current balances.
 * Returns detailed per-currency shortfall information.
 */
export function checkCashSufficiency(
  balances: Map<string, number>,
  requiredEffects: CashEffect[],
): SufficiencyResult {
  // Aggregate outflows per currency
  const outflows = new Map<string, number>()
  for (const effect of requiredEffects) {
    if (effect.amount < 0) {
      outflows.set(
        effect.currency,
        (outflows.get(effect.currency) ?? 0) + Math.abs(effect.amount),
      )
    }
  }

  const shortfalls: CashShortfall[] = []
  for (const [currency, needed] of outflows.entries()) {
    const available = balances.get(currency) ?? 0
    if (needed > available) {
      shortfalls.push({ currency, needed, available, shortfall: needed - available })
    }
  }

  return { sufficient: shortfalls.length === 0, shortfalls }
}
