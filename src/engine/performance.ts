/**
 * performance.ts — Pure TWR calculation engine (Phase 6).
 *
 * No React, no Dexie. All inputs are plain TypeScript values.
 *
 * TWR method: Modified Dietz chaining.
 * Sub-periods are split at external cash flow events (CASH_DEPOSIT /
 * CASH_WITHDRAWAL). Internal flows (BUY, SELL, DCA, REBALANCE, etc.)
 * move money within the portfolio and do not affect TWR sub-period
 * boundaries.
 */

import type { PortfolioSnapshot, Operation, Sleeve, Holding } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SubPeriodReturn {
  startDate: Date
  endDate: Date
  startValue: number
  endValue: number
  /** External cash flow at the START of this sub-period (positive = deposit, negative = withdrawal) */
  cashFlow: number
  returnPct: number
}

export interface TWRResult {
  twrPct: number
  subPeriods: SubPeriodReturn[]
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the total portfolio value from a snapshot in the requested currency.
 * PortfolioSnapshot.totalValueBase is always in TWD (base currency).
 */
function snapshotValue(
  snapshot: PortfolioSnapshot,
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): number {
  if (valueCurrency === 'TWD') return snapshot.totalValueBase
  // fxRate = TWD per USD; divide to get USD
  return fxRate > 0 ? snapshot.totalValueBase / fxRate : 0
}

/**
 * Convert a cash flow amount to the requested currency.
 * CashFlow.amount is in CashFlow.currency.
 */
function convertCashFlow(
  amount: number,
  fromCurrency: 'USD' | 'TWD',
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): number {
  if (fromCurrency === valueCurrency) return amount
  if (valueCurrency === 'TWD') return amount * fxRate   // USD → TWD
  return fxRate > 0 ? amount / fxRate : 0               // TWD → USD
}

/**
 * Find the snapshot with the latest timestamp that is <= the given time.
 * Returns undefined if none exists.
 */
function snapshotAtOrBefore(
  snapshots: PortfolioSnapshot[],
  time: number,
): PortfolioSnapshot | undefined {
  // snapshots are sorted ascending; walk backwards
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (new Date(snapshots[i].timestamp).getTime() <= time) return snapshots[i]
  }
  return undefined
}

/**
 * Find the snapshot with the earliest timestamp that is >= the given time.
 */
function snapshotAtOrAfter(
  snapshots: PortfolioSnapshot[],
  time: number,
): PortfolioSnapshot | undefined {
  for (let i = 0; i < snapshots.length; i++) {
    if (new Date(snapshots[i].timestamp).getTime() >= time) return snapshots[i]
  }
  return undefined
}

// ─── calculateTWR ─────────────────────────────────────────────────────────────

/**
 * Calculate Time-Weighted Return using Modified Dietz chaining.
 *
 * Sub-period boundaries are placed at CASH_DEPOSIT / CASH_WITHDRAWAL events only.
 * All other operation types (BUY, SELL, DCA, REBALANCE, etc.) are internal and
 * do NOT create boundaries.
 *
 * For each sub-period:
 *   - Sub-period 0 start:  first standalone snapshot at/after startDate
 *   - Sub-period N start (N>0):  op.snapshotAfter of the (N-1)th cash flow event
 *   - Sub-period N end (before CF): op.snapshotBefore of the Nth cash flow event
 *   - Last sub-period end:  last standalone snapshot at/before endDate
 *
 * Using op.snapshotBefore/After (not standalone snapshots) for CF boundaries
 * ensures we capture the exact portfolio value immediately before/after each
 * external cash flow, avoiding the "future high-value snapshot used as start"
 * bug that caused massively negative TWR readings.
 *
 * @param snapshots    All PortfolioSnapshot records (any order — sorted internally)
 * @param operations   All Operation records (any order — sorted internally)
 * @param startDate    Inclusive start of the measurement period
 * @param endDate      Inclusive end of the measurement period
 * @param valueCurrency Currency in which to express values and returns
 * @param fxRate       TWD per USD rate used for currency conversion
 */
export function calculateTWR(
  snapshots: PortfolioSnapshot[],
  operations: Operation[],
  startDate: Date,
  endDate: Date,
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): TWRResult {
  const startMs = startDate.getTime()
  const endMs   = endDate.getTime()

  // ── 1. Filter and sort snapshots within [startDate, endDate] ────────────────
  const periodSnaps = snapshots
    .filter(s => {
      const t = new Date(s.timestamp).getTime()
      return t >= startMs && t <= endMs
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  // Need at least 2 snapshots to compute a return
  if (periodSnaps.length < 2) {
    return { twrPct: 0, subPeriods: [] }
  }

  // ── 2. Identify external cash flow events within the period ─────────────────
  //
  // IMPORTANT: Only CASH_DEPOSIT and CASH_WITHDRAWAL are external cash flows.
  // BUY/SELL/DCA/REBALANCE/FX_EXCHANGE/etc. are ALL internal — they move money
  // between cash and holdings within the portfolio but do NOT affect total value.
  //
  // For each CF event we store snapshotBefore (end of current sub-period) AND
  // snapshotAfter (start of next sub-period). Using these embedded snapshots
  // avoids looking up standalone snapshots that may be far in the future.

  interface CashFlowEvent {
    timeMs:          number
    amount:          number                       // valueCurrency; positive = deposit
    snapshotBefore:  PortfolioSnapshot            // value just BEFORE this CF (op.snapshotBefore)
    snapshotAfter:   PortfolioSnapshot            // value just AFTER this CF  (op.snapshotAfter)
  }

  const cashFlowEvents: CashFlowEvent[] = operations
    .filter(op => {
      if (op.type !== 'CASH_DEPOSIT' && op.type !== 'CASH_WITHDRAWAL') return false
      if (!op.cashFlow) return false
      const t = new Date(op.timestamp).getTime()
      return t > startMs && t <= endMs   // strictly after start to avoid double-counting
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map(op => ({
      timeMs:         new Date(op.timestamp).getTime(),
      amount:         convertCashFlow(op.cashFlow!.amount, op.cashFlow!.currency, valueCurrency, fxRate),
      snapshotBefore: op.snapshotBefore,   // required on Operation
      snapshotAfter:  op.snapshotAfter,    // required on Operation
    }))

  // ── 3. Build sub-period list ─────────────────────────────────────────────────
  //
  // Boundaries:
  //   sub-period 0:  [startSnap   → cashFlowEvents[0].snapshotBefore]
  //   sub-period i:  [cashFlowEvents[i-1].snapshotAfter → cashFlowEvents[i].snapshotBefore]
  //   last period:   [cashFlowEvents[last].snapshotAfter → endSnap]
  //   (no CFs):      [startSnap → endSnap]
  //
  // The start/end values come from op.snapshotBefore/After for CF boundaries,
  // and from the first/last standalone snapshot for the period endpoints.

  const startSnap = snapshotAtOrAfter(periodSnaps, startMs)
  const endSnap   = snapshotAtOrBefore(periodSnaps, endMs)

  if (!startSnap || !endSnap) {
    return { twrPct: 0, subPeriods: [] }
  }

  // Debug: log all inputs
  console.group('[TWR debug]')
  console.log('Standalone snapshots in period:',
    periodSnaps.map(s => ({
      ts: new Date(s.timestamp).toISOString().slice(0, 10),
      value: snapshotValue(s, valueCurrency, fxRate).toFixed(0),
    }))
  )
  console.log('Cash flow events (CASH_DEPOSIT / CASH_WITHDRAWAL only):',
    cashFlowEvents.map(ev => ({
      ts:      new Date(ev.timeMs).toISOString().slice(0, 10),
      amount:  ev.amount.toFixed(0),
      before:  snapshotValue(ev.snapshotBefore, valueCurrency, fxRate).toFixed(0),
      after:   snapshotValue(ev.snapshotAfter,  valueCurrency, fxRate).toFixed(0),
    }))
  )

  // ── 4. Compute sub-period returns ────────────────────────────────────────────
  const subPeriods: SubPeriodReturn[] = []
  let chainValue = 1

  // Total N+1 sub-periods where N = cashFlowEvents.length
  const totalPeriods = cashFlowEvents.length + 1

  for (let i = 0; i < totalPeriods; i++) {
    // Start snap: period-start standalone snap for i=0; snapshotAfter of prev CF otherwise
    const subStart: PortfolioSnapshot = i === 0
      ? startSnap
      : cashFlowEvents[i - 1].snapshotAfter

    // End snap: snapshotBefore of current CF for non-final periods; endSnap for the last
    const subEnd: PortfolioSnapshot = i < cashFlowEvents.length
      ? cashFlowEvents[i].snapshotBefore
      : endSnap

    const startValue = snapshotValue(subStart, valueCurrency, fxRate)
    const endValue   = snapshotValue(subEnd,   valueCurrency, fxRate)

    // Skip degenerate sub-periods (same snapshot, or empty start)
    if (startValue <= 0 || subStart === subEnd) {
      console.log(`  sub-period ${i}: skipped (startValue=${startValue.toFixed(0)}, same=${subStart === subEnd})`)
      continue
    }

    const returnPct = (endValue / startValue) - 1

    console.log(`  sub-period ${i}: ${new Date(subStart.timestamp).toISOString().slice(0,10)} → ${new Date(subEnd.timestamp).toISOString().slice(0,10)}  ${startValue.toFixed(0)} → ${endValue.toFixed(0)}  = ${(returnPct*100).toFixed(2)}%`)

    subPeriods.push({
      startDate:  new Date(subStart.timestamp),
      endDate:    new Date(subEnd.timestamp),
      startValue,
      endValue,
      cashFlow:   i === 0 ? 0 : cashFlowEvents[i - 1].amount,
      returnPct,
    })

    chainValue *= (1 + returnPct)
  }

  const twrPct = chainValue - 1
  console.log(`  Chained TWR: ${(twrPct * 100).toFixed(2)}%  (product of ${subPeriods.length} sub-periods)`)
  console.groupEnd()

  if (subPeriods.length === 0) {
    return { twrPct: 0, subPeriods: [] }
  }

  return { twrPct, subPeriods }
}

// ─── xirr ────────────────────────────────────────────────────────────────────

/**
 * Solve for the Internal Rate of Return using Newton-Raphson iteration.
 *
 * Convention (standard XIRR):
 *   - t_i = (date_i - date_0) / 365   (fractional years from the first date)
 *   - f(r)  = Σ C_i × (1 + r)^(-t_i)
 *   - f'(r) = Σ C_i × (-t_i) × (1 + r)^(-t_i - 1)
 *   - r_next = r - f(r) / f'(r)
 *
 * Tries several initial guesses before giving up.
 *
 * @returns The annualized rate as a decimal (e.g. 0.12 = 12%), or NaN if
 *          Newton-Raphson fails to converge after all guesses.
 */
export function xirr(cashFlows: { date: Date; amount: number }[]): number {
  if (cashFlows.length < 2) return NaN

  const t0Ms = cashFlows[0].date.getTime()
  const times = cashFlows.map(cf => (cf.date.getTime() - t0Ms) / (365 * 24 * 60 * 60 * 1000))
  const amounts = cashFlows.map(cf => cf.amount)

  const TOLERANCE  = 1e-7
  const MAX_ITER   = 1000
  const INITIAL_GUESSES = [0.1, 0.0, -0.5, 0.5, -0.9, 1.0]

  function npv(r: number): number {
    let sum = 0
    for (let i = 0; i < amounts.length; i++) {
      sum += amounts[i] * Math.pow(1 + r, -times[i])
    }
    return sum
  }

  function dnpv(r: number): number {
    let sum = 0
    for (let i = 0; i < amounts.length; i++) {
      sum += amounts[i] * (-times[i]) * Math.pow(1 + r, -times[i] - 1)
    }
    return sum
  }

  for (const guess of INITIAL_GUESSES) {
    let r = guess

    for (let iter = 0; iter < MAX_ITER; iter++) {
      if (1 + r <= 0) break   // rate can't go below -100%

      const f  = npv(r)
      const df = dnpv(r)

      if (df === 0) break     // zero derivative — can't continue

      const rNext = r - f / df

      if (Math.abs(rNext - r) < TOLERANCE) {
        return rNext          // converged
      }

      r = rNext
    }
  }

  return NaN   // failed to converge on all guesses
}

// ─── calculateMWR ────────────────────────────────────────────────────────────

export interface MWRCashFlow {
  date: Date
  amount: number   // negative = money invested (outflow), positive = money returned (inflow)
}

export interface MWRResult {
  mwrPct: number          // raw (non-annualized) return over the period, as decimal
  annualizedPct: number   // annualized XIRR rate, or NaN if calculation failed
  cashFlows: MWRCashFlow[]
}

/**
 * Calculate Money-Weighted Return (XIRR) for a portfolio over a period.
 *
 * Cash flow sign convention (investor's perspective):
 *   - CASH_DEPOSIT: money flows IN to the portfolio  → negative (investment outflow)
 *   - CASH_WITHDRAWAL: money flows OUT to investor   → positive (return inflow)
 *   - Starting portfolio value on startDate          → negative (initial investment)
 *   - Current portfolio value on currentDate         → positive (terminal value / liquidation)
 *
 * Only CASH_DEPOSIT and CASH_WITHDRAWAL are external flows. BUY/SELL/DCA/REBALANCE
 * are internal and do not appear in the XIRR cash flow list.
 *
 * @param operations    All operation records (any order — filtered/sorted internally)
 * @param currentValue  Current total portfolio value in valueCurrency
 * @param currentDate   Date at which currentValue is measured
 * @param startDate     Start of the measurement period
 * @param valueCurrency Currency for all amounts
 * @param fxRate        TWD per USD (used to convert cash flows if needed)
 */
export function calculateMWR(
  operations: Operation[],
  currentValue: number,
  currentDate: Date,
  startDate: Date,
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): MWRResult {
  const startMs   = startDate.getTime()
  const currentMs = currentDate.getTime()

  // ── 1. Collect CASH_DEPOSIT / CASH_WITHDRAWAL events within [startDate, currentDate] ──
  const externalFlows: MWRCashFlow[] = operations
    .filter(op => {
      if (op.type !== 'CASH_DEPOSIT' && op.type !== 'CASH_WITHDRAWAL') return false
      if (!op.cashFlow) return false
      const t = new Date(op.timestamp).getTime()
      return t >= startMs && t <= currentMs
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map(op => {
      const raw = op.cashFlow!.amount   // positive = deposit (money in)
      const converted = convertCashFlow(raw, op.cashFlow!.currency, valueCurrency, fxRate)
      // Investor perspective: deposit = outflow (negative), withdrawal = inflow (positive)
      const amount = op.type === 'CASH_DEPOSIT' ? -converted : converted
      return { date: new Date(op.timestamp), amount }
    })

  // ── 2. Find starting portfolio value (from the snapshotBefore of the earliest operation,
  //       or from snapshotAfter of the operation at startDate, whichever is available) ──
  //
  // We look for the earliest operation at or after startDate to get its snapshotBefore
  // as a proxy for "what the portfolio was worth at the start".
  const sortedOps = [...operations].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )
  const firstOpInPeriod = sortedOps.find(op => new Date(op.timestamp).getTime() >= startMs)
  const startingSnapshot = firstOpInPeriod?.snapshotBefore

  let startingValue = 0
  if (startingSnapshot) {
    startingValue = valueCurrency === 'TWD'
      ? startingSnapshot.totalValueBase
      : fxRate > 0 ? startingSnapshot.totalValueBase / fxRate : 0
  }

  // ── 3. Build the XIRR cash flow list ────────────────────────────────────────
  //
  // [ initial investment (neg), ...external flows, terminal value (pos) ]
  const xirrFlows: MWRCashFlow[] = []

  // Initial investment: starting portfolio value on startDate (negative = outflow)
  if (startingValue > 0) {
    xirrFlows.push({ date: startDate, amount: -startingValue })
  }

  // Intermediate external flows
  xirrFlows.push(...externalFlows)

  // Terminal value: current portfolio value (positive = inflow / liquidation proceeds)
  xirrFlows.push({ date: currentDate, amount: currentValue })

  // ── 4. Compute simple (non-annualized) MWR as a sanity figure ───────────────
  //
  // total invested = |initial| + Σ deposits
  // total returned = Σ withdrawals + currentValue
  const totalInvested = xirrFlows
    .filter(cf => cf.amount < 0)
    .reduce((s, cf) => s - cf.amount, 0)   // sum of absolute outflows

  const totalReturned = xirrFlows
    .filter(cf => cf.amount > 0)
    .reduce((s, cf) => s + cf.amount, 0)

  const mwrPct = totalInvested > 0 ? (totalReturned / totalInvested) - 1 : 0

  // ── 5. Run XIRR ─────────────────────────────────────────────────────────────
  const annualizedPct = xirrFlows.length >= 2 ? xirr(xirrFlows) : NaN

  return { mwrPct, annualizedPct, cashFlows: xirrFlows }
}

// ─── annualizeTWR ─────────────────────────────────────────────────────────────

/**
 * Annualize a TWR if the measurement period is at least 365 days.
 * For periods shorter than a year, returns the raw TWR — annualizing
 * short periods (e.g. 3 months at +10% → +46% annualized) is misleading.
 *
 * @param twrPct  Raw TWR as a decimal (e.g. 0.12 = 12%)
 * @param days    Number of calendar days in the measurement period
 * @returns       Annualized (or raw) TWR as a decimal
 */
export function annualizeTWR(twrPct: number, days: number): number {
  if (days < 365) return twrPct
  return Math.pow(1 + twrPct, 365 / days) - 1
}

// ─── calculateSleeveAttribution ───────────────────────────────────────────────

export interface HoldingAttribution {
  holdingId: string
  ticker: string
  startValue: number
  endValue: number
  absoluteReturn: number
  /** null when startValue = 0 (newly added holding — can't express as %) */
  returnPct: number | null
  /** This holding's absolute return as % of the sleeve's total absolute return */
  contributionPct: number
}

export interface SleeveAttribution {
  sleeveId: string
  sleeveName: string
  sleeveColor: string
  startValue: number
  endValue: number
  absoluteReturn: number
  /** null when startValue = 0 (sleeve was empty at period start) */
  returnPct: number | null
  /** This sleeve's absolute return as % of the portfolio's total absolute return */
  contributionPct: number
  holdings: HoldingAttribution[]
}

/**
 * Attribute portfolio return to each sleeve and its child holdings.
 *
 * Values are sourced from `snapshotStart` and `snapshotEnd` — the
 * `HoldingSnapshot.marketValueBase` fields are used as raw TWD values,
 * then divided by fxRate if valueCurrency is 'USD'.
 *
 * Returned array is sorted by |absoluteReturn| descending (biggest mover first).
 * Holdings within each sleeve follow the same sort order.
 *
 * @param snapshotStart   Portfolio snapshot at period start
 * @param snapshotEnd     Portfolio snapshot at period end
 * @param sleeves         All sleeve records for the portfolio
 * @param holdings        All holding records for the portfolio (for sleeveId lookup)
 * @param valueCurrency   Currency in which to express values
 * @param fxRate          TWD per USD
 */
export function calculateSleeveAttribution(
  snapshotStart: PortfolioSnapshot,
  snapshotEnd: PortfolioSnapshot,
  sleeves: Sleeve[],
  holdings: Holding[],
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): SleeveAttribution[] {
  const divisor = valueCurrency === 'USD' && fxRate > 0 ? fxRate : 1

  // Quick lookup: holdingId → sleeveId
  const holdingSleeveMap = new Map(holdings.map(h => [h.id, h.sleeveId]))

  // Index snapshot holdings by id for O(1) access
  const startByHolding = new Map(snapshotStart.holdings.map(h => [h.holdingId, h]))
  const endByHolding   = new Map(snapshotEnd.holdings.map(h => [h.holdingId, h]))

  // Collect all holdingIds that appear in either snapshot
  const allHoldingIds = new Set([
    ...snapshotStart.holdings.map(h => h.holdingId),
    ...snapshotEnd.holdings.map(h => h.holdingId),
  ])

  // Portfolio-level totals (needed for sleeve contributionPct)
  let portfolioAbsoluteReturn = 0

  // Build per-sleeve data in a map first
  const sleeveMap = new Map<string, {
    sleeve: Sleeve
    holdingRows: HoldingAttribution[]
    startValue: number
    endValue: number
  }>()

  for (const sleeve of sleeves) {
    sleeveMap.set(sleeve.id, { sleeve, holdingRows: [], startValue: 0, endValue: 0 })
  }

  // Accumulate holding-level data into sleeves
  for (const holdingId of allHoldingIds) {
    const sleeveId = holdingSleeveMap.get(holdingId)
    if (!sleeveId) continue   // orphaned holding — skip

    const sleeveEntry = sleeveMap.get(sleeveId)
    if (!sleeveEntry) continue   // sleeve not in list — skip

    const holding = holdings.find(h => h.id === holdingId)
    const ticker  = holding?.ticker ?? holdingId

    const startSnap = startByHolding.get(holdingId)
    const endSnap   = endByHolding.get(holdingId)

    const startValue = (startSnap?.marketValueBase ?? 0) / divisor
    const endValue   = (endSnap?.marketValueBase   ?? 0) / divisor
    const absoluteReturn = endValue - startValue
    const returnPct = startValue > 0 ? ((endValue / startValue) - 1) * 100 : null

    sleeveEntry.startValue += startValue
    sleeveEntry.endValue   += endValue
    sleeveEntry.holdingRows.push({
      holdingId,
      ticker,
      startValue,
      endValue,
      absoluteReturn,
      returnPct,
      contributionPct: 0,   // filled in below once sleeve total is known
    })
  }

  // Compute portfolio absolute return
  for (const { startValue, endValue } of sleeveMap.values()) {
    portfolioAbsoluteReturn += endValue - startValue
  }

  // Build final SleeveAttribution array
  const result: SleeveAttribution[] = []

  for (const { sleeve, holdingRows, startValue, endValue } of sleeveMap.values()) {
    const absoluteReturn = endValue - startValue
    const returnPct = startValue > 0 ? ((endValue / startValue) - 1) * 100 : null
    const contributionPct = portfolioAbsoluteReturn !== 0
      ? (absoluteReturn / portfolioAbsoluteReturn) * 100
      : 0

    // Fill holding contributionPct relative to sleeve absolute return
    for (const row of holdingRows) {
      row.contributionPct = absoluteReturn !== 0
        ? (row.absoluteReturn / absoluteReturn) * 100
        : 0
    }

    // Sort holdings by |absoluteReturn| desc
    holdingRows.sort((a, b) => Math.abs(b.absoluteReturn) - Math.abs(a.absoluteReturn))

    result.push({
      sleeveId: sleeve.id,
      sleeveName: sleeve.name,
      sleeveColor: sleeve.color,
      startValue,
      endValue,
      absoluteReturn,
      returnPct,
      contributionPct,
      holdings: holdingRows,
    })
  }

  // Sort sleeves by |absoluteReturn| desc
  result.sort((a, b) => Math.abs(b.absoluteReturn) - Math.abs(a.absoluteReturn))

  return result
}

// ─── calculateBenchmarkComparison ────────────────────────────────────────────

export interface BenchmarkComparison {
  benchmarkTicker: string
  benchmarkReturnPct: number   // as decimal (e.g. 0.12 = 12%)
  alphaPct: number             // portfolioTWR - benchmarkReturnPct (decimal)
  outperformed: boolean
}

/**
 * Compare portfolio TWR against a manually-entered benchmark price series.
 *
 * In MVP, benchmark prices are entered manually by the user (same mechanism
 * as regular holding prices — no live API). benchmarkStartPrice and
 * benchmarkEndPrice should be the benchmark's price at the start and end
 * of the same period used for TWR.
 *
 * @param portfolioTWR         TWR for the period as a decimal (e.g. 0.12)
 * @param benchmarkTicker      Display label for the benchmark (e.g. "VT")
 * @param benchmarkStartPrice  Benchmark price at period start
 * @param benchmarkEndPrice    Benchmark price at period end
 */
export function calculateBenchmarkComparison(
  portfolioTWR: number,
  benchmarkTicker: string,
  benchmarkStartPrice: number,
  benchmarkEndPrice: number,
): BenchmarkComparison {
  const benchmarkReturnPct = benchmarkStartPrice > 0
    ? (benchmarkEndPrice / benchmarkStartPrice) - 1
    : 0

  const alphaPct    = portfolioTWR - benchmarkReturnPct
  const outperformed = alphaPct > 0

  return { benchmarkTicker, benchmarkReturnPct, alphaPct, outperformed }
}

// ─── calculateRealizedPnL ─────────────────────────────────────────────────────

/**
 * Approximate realized P&L within a date range.
 *
 * For each SELL entry in the period:
 *   realizedPnL += (pricePerShare − holding.averageCostBasis) × shares
 *
 * ⚠️ MVP approximation: uses the CURRENT averageCostBasis, not the cost basis at
 * the time of the sale. Accuracy degrades when a holding has been traded multiple
 * times, since the average cost evolves with each trade.
 *
 * TODO: store costBasis snapshot on OperationEntry to enable precise realized PnL.
 */
export function calculateRealizedPnL(
  operations: Operation[],
  startDate: Date,
  endDate: Date,
  holdings: Holding[],
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): number {
  const startMs   = startDate.getTime()
  const endMs     = endDate.getTime()
  const holdingMap = new Map(holdings.map(h => [h.id, h]))

  let total = 0
  for (const op of operations) {
    const t = new Date(op.timestamp).getTime()
    if (t < startMs || t > endMs) continue

    for (const entry of op.entries) {
      if (entry.side !== 'SELL') continue
      const holding = holdingMap.get(entry.holdingId)
      if (!holding) continue

      const avgCost = holding.averageCostBasis ?? 0
      const pnlNative = (entry.pricePerShare - avgCost) * entry.shares
      // Convert to base currency (TWD), then to valueCurrency
      const pnlBase = holding.currency === 'USD' ? pnlNative * fxRate : pnlNative
      total += valueCurrency === 'TWD' ? pnlBase : (fxRate > 0 ? pnlBase / fxRate : 0)
    }
  }
  return total
}

// ─── calculateUnrealizedPnL ───────────────────────────────────────────────────

/**
 * Compute unrealized P&L across all holdings using live position fields.
 *
 * For each holding:
 *   unrealizedPnL += (currentPricePerShare − averageCostBasis) × currentShares
 *
 * Holdings missing any of the three required fields are skipped.
 */
export function calculateUnrealizedPnL(
  holdings: Holding[],
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): number {
  let total = 0
  for (const h of holdings) {
    const shares = h.currentShares ?? 0
    const price  = h.currentPricePerShare ?? 0
    const cost   = h.averageCostBasis ?? 0
    if (shares <= 0 || price <= 0 || cost <= 0) continue

    const pnlNative = (price - cost) * shares
    const pnlBase   = h.currency === 'USD' ? pnlNative * fxRate : pnlNative
    total += valueCurrency === 'TWD' ? pnlBase : (fxRate > 0 ? pnlBase / fxRate : 0)
  }
  return total
}

// ─── MoMDataPoint / calculateMoMGrowth ────────────────────────────────────────

export interface MoMDataPoint {
  /** Display label e.g. "Jan '25" */
  month: string
  /** Holdings-only portfolio value at end of month in valueCurrency */
  value: number
  /** Month-over-month growth as decimal; null for the first data point */
  growthPct: number | null
}

/**
 * Compute month-over-month portfolio value growth for the last `months` months.
 *
 * "Portfolio Value" = holdings only (cash excluded). For each calendar month,
 * the last snapshot of that month is used. Months with no snapshots are omitted.
 */
export function calculateMoMGrowth(
  snapshots: PortfolioSnapshot[],
  months: number,
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
): MoMDataPoint[] {
  const divisor = valueCurrency === 'USD' && fxRate > 0 ? fxRate : 1

  // Group by "YYYY-MM", keeping only the last snapshot per month
  const byMonth = new Map<string, PortfolioSnapshot>()
  for (const snap of snapshots) {
    const d   = new Date(snap.timestamp)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const existing = byMonth.get(key)
    if (!existing || new Date(snap.timestamp) > new Date(existing.timestamp)) {
      byMonth.set(key, snap)
    }
  }

  const sortedKeys   = [...byMonth.keys()].sort()
  const relevantKeys = sortedKeys.slice(-months)

  const result: MoMDataPoint[] = []
  let prevValue: number | null = null

  for (const key of relevantKeys) {
    const snap  = byMonth.get(key)!
    const value = snap.holdings.reduce((s, h) => s + h.marketValueBase, 0) / divisor

    const [yyyy, mm] = key.split('-')
    const label = new Date(Number(yyyy), Number(mm) - 1, 1).toLocaleDateString(undefined, {
      month: 'short',
      year: '2-digit',
    })

    result.push({
      month: label,
      value,
      growthPct: prevValue != null && prevValue > 0 ? (value / prevValue) - 1 : null,
    })
    prevValue = value
  }

  return result
}

// ─── PerfChartPoint / buildPerformanceChartData ───────────────────────────────

export interface PerfChartPoint {
  date: string
  /** Holdings-only portfolio value in valueCurrency */
  portfolioValue: number
  /** Σ (marketValueBase − costBasisBase) across holdings, in valueCurrency */
  unrealizedPnL: number
  /**
   * portfolioValue minus cumulative net capital deployed (deposits − withdrawals)
   * up to this snapshot. Approximates total P&L at each point in time.
   */
  totalPnL: number
  /**
   * Benchmark indexed to the portfolio's starting value, linearly interpolated
   * from benchmarkStartPrice → benchmarkCurrentPrice. Only set when both prices
   * are provided.
   */
  benchmarkValue?: number
}

/**
 * Build chart-ready data points from portfolio snapshots.
 *
 * "Portfolio Value"  = Σ snapshot.holdings[].marketValueBase (cash excluded).
 * "Unrealized P&L"   = Σ (marketValueBase − costBasisBase) per holding in snapshot.
 * "Total P&L"        = unrealizedPnL + cumulativeRealizedPnL
 *   where cumulativeRealizedPnL accumulates SELL profits from periodStartMs → snap.timestamp.
 *   Cash flows (deposits/withdrawals) are NEVER included in P&L.
 * "Benchmark"        = portfolio start value × (benchmarkCurrentPrice / benchmarkStartPrice),
 *                      linearly interpolated across data points.
 *
 * The chart's last data point therefore shares the same source of truth as the
 * metric cards in the UI (both derived from the last period snapshot).
 *
 * @param snapshots       Period snapshots (any order; sorted internally)
 * @param operations      All operations (used only for SELL entry realized PnL)
 * @param holdings        Current holding records (for averageCostBasis lookup)
 * @param periodStartMs   Epoch ms of the period start — realized PnL is only accumulated
 *                        from this point forward (matches the selected date range)
 * @param valueCurrency   Display currency
 * @param fxRate          TWD per USD
 * @param benchmarkStartPrice    Optional benchmark price at period start
 * @param benchmarkCurrentPrice  Optional benchmark price at period end
 */
export function buildPerformanceChartData(
  snapshots: PortfolioSnapshot[],
  operations: Operation[],
  holdings: Holding[],
  periodStartMs: number,
  valueCurrency: 'TWD' | 'USD',
  fxRate: number,
  benchmarkStartPrice?: number,
  benchmarkCurrentPrice?: number,
): PerfChartPoint[] {
  const divisor = valueCurrency === 'USD' && fxRate > 0 ? fxRate : 1

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )
  if (sorted.length === 0) return []

  // Pre-build a lookup for realized PnL per SELL entry
  const holdingMap = new Map(holdings.map(h => [h.id, h]))

  // Sort SELL-containing operations within [periodStartMs, ∞) ascending
  // We'll walk through them in order as we advance through snapshots.
  const sellOps = operations
    .filter(op => {
      const ms = new Date(op.timestamp).getTime()
      return ms >= periodStartMs && op.entries.some(e => e.side === 'SELL')
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  function realizedPnLForEntry(entry: { side: string; holdingId: string; pricePerShare: number; shares: number }): number {
    if (entry.side !== 'SELL') return 0
    const holding = holdingMap.get(entry.holdingId)
    if (!holding) return 0
    const avgCost   = holding.averageCostBasis ?? 0
    const pnlNative = (entry.pricePerShare - avgCost) * entry.shares
    const pnlBase   = holding.currency === 'USD' ? pnlNative * fxRate : pnlNative
    return valueCurrency === 'TWD' ? pnlBase : (fxRate > 0 ? pnlBase / fxRate : 0)
  }

  // Benchmark: indexed to portfolio start value, linearly interpolated
  const hasBenchmark = (benchmarkStartPrice ?? 0) > 0 && (benchmarkCurrentPrice ?? 0) > 0
  const bmReturn     = hasBenchmark ? (benchmarkCurrentPrice! / benchmarkStartPrice!) - 1 : 0
  const startPV      = sorted[0].holdings.reduce((s, h) => s + h.marketValueBase, 0) / divisor
  const n            = sorted.length

  // Running cumulative realized PnL — advanced in lockstep with the sorted snapshots
  let cumRealizedPnL = 0
  let sellIdx        = 0

  return sorted.map((snap, i) => {
    const snapMs = new Date(snap.timestamp).getTime()

    // Absorb all sell ops whose timestamp ≤ this snapshot
    while (sellIdx < sellOps.length) {
      const opMs = new Date(sellOps[sellIdx].timestamp).getTime()
      if (opMs > snapMs) break
      for (const entry of sellOps[sellIdx].entries) {
        cumRealizedPnL += realizedPnLForEntry(entry)
      }
      sellIdx++
    }

    const portfolioValue = snap.holdings.reduce((s, h) => s + h.marketValueBase, 0) / divisor
    const unrealizedPnL  = snap.holdings.reduce(
      (s, h) => s + (h.marketValueBase - h.costBasisBase), 0,
    ) / divisor
    // BUG 2 FIX: totalPnL is purely investment performance — no cash flows involved
    const totalPnL = unrealizedPnL + cumRealizedPnL

    const point: PerfChartPoint = {
      date: new Date(snap.timestamp).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric',
      }),
      portfolioValue,
      unrealizedPnL,
      totalPnL,
    }

    if (hasBenchmark && n > 1) {
      point.benchmarkValue = startPV * (1 + bmReturn * (i / (n - 1)))
    }

    return point
  })
}
