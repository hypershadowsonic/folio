/**
 * Folio Build — DCA Backtest Engine
 *
 * Pure TypeScript, no React, no Dexie, no side effects.
 * All internal date handling uses YYYY-MM-DD strings for safe string comparison.
 */

import type {
  Build,
  Benchmark,
  PricePoint,
  BacktestResult,
  BacktestDataPoint,
  BacktestSummary,
} from '@/types'

// ─── Internal simulation state ────────────────────────────────────────────────

interface SimHolding {
  ticker: string
  currency: 'USD' | 'TWD'
  targetAllocationPct: number  // 0–100, must sum to 100
  shares: number               // fractional
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return toDateStr(d)
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const targetDay = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + months, 1)
  // Clamp to last day of resulting month
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(targetDay, lastDay))
  return toDateStr(d)
}

/**
 * Generate DCA contribution dates from startDate to endDate (inclusive).
 * - weekly: every +7 days
 * - biweekly: every +14 days
 * - monthly: same calendar day each month, clamped to last day of month
 */
export function generateDcaDates(
  startDate: Date,
  endDate: Date,
  frequency: 'weekly' | 'biweekly' | 'monthly',
): string[] {
  const start = toDateStr(startDate)
  const end = toDateStr(endDate)
  if (start > end) return []

  const dates: string[] = []
  let current = start

  while (current <= end) {
    dates.push(current)
    if (frequency === 'weekly') {
      current = addDays(current, 7)
    } else if (frequency === 'biweekly') {
      current = addDays(current, 14)
    } else {
      current = addMonths(current, 1)
    }
  }

  return dates
}

// ─── Price lookup helpers ─────────────────────────────────────────────────────

/**
 * Forward-fill: returns the price of the first trading day on or after dateStr,
 * within maxDaysForward days. Returns null if no price exists in that window.
 * The 10-day default handles holiday clusters without allowing years-in-the-future
 * prices for pre-listing tickers.
 */
export function getPriceOnOrAfter(
  prices: PricePoint[],
  dateStr: string,
  maxDaysForward = 10,
): number | null {
  const cutoff = addDays(dateStr, maxDaysForward)
  for (const p of prices) {
    if (p.date < dateStr) continue
    if (p.date <= cutoff) return p.adjustedClose
    break  // prices are sorted; once beyond cutoff no match possible
  }
  return null
}

/**
 * Backward-fill: returns the most recent price on or before dateStr.
 * Returns null if dateStr is before the first available price.
 */
export function getFxRateOnOrBefore(fxRates: PricePoint[], dateStr: string): number | null {
  let rate: number | null = null
  for (const p of fxRates) {
    if (p.date <= dateStr) rate = p.adjustedClose
    else break
  }
  return rate
}

// ─── Currency conversion ──────────────────────────────────────────────────────

/**
 * Convert amount from fromCurrency to dcaCurrency.
 * fxRate = TWD per 1 USD (e.g. 30.5 means 1 USD = 30.5 TWD)
 */
function toDcaCurrency(
  amount: number,
  fromCurrency: 'USD' | 'TWD',
  dcaCurrency: 'USD' | 'TWD',
  fxRate: number,
): number {
  if (fromCurrency === dcaCurrency) return amount
  if (fromCurrency === 'USD' && dcaCurrency === 'TWD') return amount * fxRate
  // fromCurrency === 'TWD' && dcaCurrency === 'USD'
  return amount / fxRate
}

// ─── Periodic trigger bucket ──────────────────────────────────────────────────

function getPeriodicBucket(
  dateStr: string,
  freq: 'monthly' | 'quarterly' | 'annually',
): string {
  const year = dateStr.slice(0, 4)
  const month = parseInt(dateStr.slice(5, 7), 10)

  if (freq === 'annually') return year
  if (freq === 'quarterly') {
    const q = Math.ceil(month / 3)
    return `${year}-Q${q}`
  }
  // monthly
  return dateStr.slice(0, 7)  // YYYY-MM
}

// ─── Rebalance algorithms ─────────────────────────────────────────────────────

/**
 * Soft rebalance (buy-only):
 * Allocates dcaAmount to underweight holdings proportional to |drift|.
 * Fallback: allocate proportional to targetAllocationPct when all at/above target.
 *
 * Mutates holdings[].shares in place.
 */
function applySoftRebalance(
  dcaAmount: number,
  dcaCurrency: 'USD' | 'TWD',
  holdings: SimHolding[],
  priceMap: Record<string, number>,   // price per ticker in holding's native currency
  fxRate: number,
): void {
  // Compute current portfolio value and drifts
  const portfolioValue = holdings.reduce((sum, h) => {
    const price = priceMap[h.ticker] ?? 0
    return sum + toDcaCurrency(h.shares * price, h.currency, dcaCurrency, fxRate)
  }, 0)

  const totalValue = portfolioValue + dcaAmount
  const currentPcts = holdings.map((h) => {
    const price = priceMap[h.ticker] ?? 0
    const val = toDcaCurrency(h.shares * price, h.currency, dcaCurrency, fxRate)
    return totalValue > 0 ? (val / totalValue) * 100 : 0
  })

  const drifts = holdings.map((h, i) => currentPcts[i] - h.targetAllocationPct)

  // Find underweight holdings (drift < -epsilon)
  const underweightIdxs = drifts.reduce<number[]>((acc, d, i) => {
    if (d < -1e-9) acc.push(i)
    return acc
  }, [])

  let weights: number[]
  if (underweightIdxs.length > 0) {
    const totalAbsDrift = underweightIdxs.reduce((sum, i) => sum + Math.abs(drifts[i]), 0)
    weights = holdings.map((_, i) =>
      underweightIdxs.includes(i)
        ? Math.abs(drifts[i]) / totalAbsDrift
        : 0,
    )
  } else {
    // All at/above target: buy proportional to target allocation
    const totalTarget = holdings.reduce((sum, h) => sum + h.targetAllocationPct, 0)
    weights = holdings.map((h) => h.targetAllocationPct / totalTarget)
  }

  // Apply buys
  holdings.forEach((h, i) => {
    if (weights[i] <= 0) return
    const buyAmountDca = dcaAmount * weights[i]
    const priceInDca = toDcaCurrency(priceMap[h.ticker] ?? 0, h.currency, dcaCurrency, fxRate)
    if (priceInDca > 0) {
      h.shares += buyAmountDca / priceInDca
    }
  })
}

/**
 * Hard rebalance (sell + buy):
 * Targets each holding at exactly targetAllocationPct of (currentPortfolioValue + dcaAmount).
 * Sells overweight, buys underweight. All done atomically with fractional shares.
 *
 * Mutates holdings[].shares in place.
 */
function applyHardRebalance(
  dcaAmount: number,
  dcaCurrency: 'USD' | 'TWD',
  holdings: SimHolding[],
  priceMap: Record<string, number>,
  fxRate: number,
): void {
  const portfolioValue = holdings.reduce((sum, h) => {
    const price = priceMap[h.ticker] ?? 0
    return sum + toDcaCurrency(h.shares * price, h.currency, dcaCurrency, fxRate)
  }, 0)

  const totalAvailable = portfolioValue + dcaAmount

  holdings.forEach((h) => {
    const priceInDca = toDcaCurrency(priceMap[h.ticker] ?? 0, h.currency, dcaCurrency, fxRate)
    if (priceInDca <= 0) return

    const targetValue = totalAvailable * (h.targetAllocationPct / 100)
    const currentValue = toDcaCurrency(h.shares * (priceMap[h.ticker] ?? 0), h.currency, dcaCurrency, fxRate)
    const deltaShares = (targetValue - currentValue) / priceInDca

    h.shares = Math.max(0, h.shares + deltaShares)
  })
}

/**
 * No-rebalance buy: allocate dcaAmount proportional to target allocation.
 *
 * Mutates holdings[].shares in place.
 */
function applyProportionalBuy(
  dcaAmount: number,
  dcaCurrency: 'USD' | 'TWD',
  holdings: SimHolding[],
  priceMap: Record<string, number>,
  fxRate: number,
): void {
  const totalTarget = holdings.reduce((sum, h) => sum + h.targetAllocationPct, 0)

  holdings.forEach((h) => {
    const weight = h.targetAllocationPct / totalTarget
    const buyAmountDca = dcaAmount * weight
    const priceInDca = toDcaCurrency(priceMap[h.ticker] ?? 0, h.currency, dcaCurrency, fxRate)
    if (priceInDca > 0) {
      h.shares += buyAmountDca / priceInDca
    }
  })
}

// ─── Summary computation ──────────────────────────────────────────────────────

function computeMaxDrawdown(timeSeries: BacktestDataPoint[]): number {
  if (timeSeries.length === 0) return 0
  let peak = timeSeries[0].portfolioValue
  let maxDrawdown = 0
  for (const pt of timeSeries) {
    if (pt.portfolioValue > peak) peak = pt.portfolioValue
    const drawdown = peak > 0 ? ((pt.portfolioValue - peak) / peak) * 100 : 0
    if (drawdown < maxDrawdown) maxDrawdown = drawdown
  }
  return maxDrawdown
}

/**
 * Best and worst period returns across consecutive DCA data points.
 * Named "month" by convention (PRD), but operates on consecutive DCA periods
 * regardless of frequency.
 */
function computeBestWorstPeriod(timeSeries: BacktestDataPoint[]): { best: number; worst: number } {
  if (timeSeries.length < 2) return { best: 0, worst: 0 }
  let best = -Infinity
  let worst = Infinity
  for (let i = 1; i < timeSeries.length; i++) {
    const prev = timeSeries[i - 1].portfolioValue
    const curr = timeSeries[i].portfolioValue
    if (prev > 0) {
      const ret = ((curr / prev) - 1) * 100
      if (ret > best) best = ret
      if (ret < worst) worst = ret
    }
  }
  return {
    best: best === -Infinity ? 0 : best,
    worst: worst === Infinity ? 0 : worst,
  }
}

function computeSummary(
  timeSeries: BacktestDataPoint[],
  totalInvested: number,
): BacktestSummary {
  if (timeSeries.length === 0) {
    return {
      totalReturn: 0,
      totalReturnPct: 0,
      annualizedReturnPct: 0,
      totalInvested,
      endValue: 0,
      maxDrawdownPct: 0,
      bestMonthPct: 0,
      worstMonthPct: 0,
      totalRebalances: 0,
      yoyGrowthPct: null,
      momGrowthPct: null,
    }
  }

  const first = timeSeries[0]
  const last = timeSeries[timeSeries.length - 1]
  const endValue = last.portfolioValue
  const totalReturn = endValue - totalInvested
  const totalReturnPct = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0

  // Annualized return: CAGR over actual days
  const firstDate = new Date(first.date)
  const lastDate = new Date(last.date)
  const totalDays = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)
  let annualizedReturnPct = 0
  if (totalDays >= 365 && totalInvested > 0 && endValue > 0) {
    annualizedReturnPct = (Math.pow(endValue / totalInvested, 365 / totalDays) - 1) * 100
  } else if (totalDays > 0 && totalInvested > 0 && endValue > 0) {
    // Less than 1 year: annualize anyway (extrapolated)
    annualizedReturnPct = (Math.pow(endValue / totalInvested, 365 / totalDays) - 1) * 100
  }

  const maxDrawdownPct = computeMaxDrawdown(timeSeries)
  const { best: bestMonthPct, worst: worstMonthPct } = computeBestWorstPeriod(timeSeries)
  const totalRebalances = timeSeries.filter((pt) => pt.rebalanceTriggered).length

  // YoY growth
  let yoyGrowthPct: number | null = null
  if (totalDays >= 365) {
    const oneYearAgoStr = addDays(toDateStr(lastDate), -365)
    const target = timeSeries.find((pt) => toDateStr(new Date(pt.date)) >= oneYearAgoStr)
    if (target && target.portfolioValue > 0) {
      yoyGrowthPct = ((endValue / target.portfolioValue) - 1) * 100
    }
  }

  // MoM growth (last 30 days)
  let momGrowthPct: number | null = null
  if (totalDays >= 30) {
    const oneMonthAgoStr = addDays(toDateStr(lastDate), -30)
    const target = timeSeries.find((pt) => toDateStr(new Date(pt.date)) >= oneMonthAgoStr)
    if (target && target.portfolioValue > 0) {
      momGrowthPct = ((endValue / target.portfolioValue) - 1) * 100
    }
  }

  return {
    totalReturn,
    totalReturnPct,
    annualizedReturnPct,
    totalInvested,
    endValue,
    maxDrawdownPct,
    bestMonthPct,
    worstMonthPct,
    totalRebalances,
    yoyGrowthPct,
    momGrowthPct,
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run a DCA backtest simulation.
 *
 * @param build    The portfolio configuration
 * @param prices   Pre-fetched price data: Record<ticker, PricePoint[]> sorted asc by date
 * @param fxRates  USDTWD=X price series (empty array if not needed)
 * @returns        Complete BacktestResult with timeSeries and summary
 *
 * @throws If any ticker has no price data at all.
 */
export function runBacktest(
  build: Build,
  prices: Record<string, PricePoint[]>,
  fxRates: PricePoint[],
): BacktestResult {
  const { dcaCurrency, dcaFrequency, dcaAmount, rebalanceStrategy, rebalanceTriggers } = build

  // Validate all tickers have data
  const missingTickers = build.holdings.filter((h) => !prices[h.ticker] || prices[h.ticker].length === 0)
  if (missingTickers.length > 0) {
    throw new Error(`No price data for: ${missingTickers.map((h) => h.ticker).join(', ')}`)
  }

  // Check if FX is needed
  const needsFx = build.holdings.some((h) => h.currency !== dcaCurrency)
  if (needsFx && fxRates.length === 0) {
    throw new Error('FX rate data (USDTWD=X) is required for multi-currency builds but was not provided.')
  }

  // Initialize simulation holdings
  const holdings: SimHolding[] = build.holdings.map((h) => ({
    ticker: h.ticker,
    currency: h.currency,
    targetAllocationPct: h.targetAllocationPct,
    shares: 0,
  }))

  // Generate DCA dates
  const dcaDates = generateDcaDates(build.startDate, build.endDate, dcaFrequency)

  let totalInvested = 0
  let lastPeriodicBucket: string | null = null
  let lastKnownFxRate: number | null = fxRates.length > 0 ? null : 1  // 1 = no conversion needed

  const timeSeries: BacktestDataPoint[] = []

  for (const dateStr of dcaDates) {
    // Resolve prices for holdings that have data on this date
    const priceMap: Record<string, number> = {}
    for (const h of holdings) {
      const price = getPriceOnOrAfter(prices[h.ticker], dateStr)
      if (price !== null) priceMap[h.ticker] = price
    }

    // Skip entirely only if no holdings have a price yet
    if (Object.keys(priceMap).length === 0) continue

    // Redistribute DCA among available holdings: temporarily scale target allocations
    // so they sum to 100% for holdings that have a price (e.g., if ETHB isn't listed yet,
    // its DCA share goes to the other holdings proportionally).
    const totalAvailablePct = holdings
      .filter((h) => h.ticker in priceMap)
      .reduce((sum, h) => sum + h.targetAllocationPct, 0)
    const originalAllocations = holdings.map((h) => h.targetAllocationPct)
    holdings.forEach((h) => {
      h.targetAllocationPct = h.ticker in priceMap
        ? (h.targetAllocationPct / totalAvailablePct) * 100
        : 0
    })

    // Resolve FX rate
    let fxRate = lastKnownFxRate ?? 1
    if (needsFx) {
      const rate = getFxRateOnOrBefore(fxRates, dateStr)
      if (rate !== null) {
        fxRate = rate
        lastKnownFxRate = rate
      } else if (lastKnownFxRate === null) {
        // No rate available at all yet — skip until we have one
        continue
      }
      // else: use lastKnownFxRate as fallback
    }

    // Accumulate investment
    totalInvested += dcaAmount

    // Evaluate rebalance triggers
    let triggered = false
    for (const trigger of rebalanceTriggers) {
      if (trigger === 'on-dca') {
        triggered = true
        break
      }

      if (trigger === 'threshold') {
        const portfolioValue = holdings.reduce((sum, h) => {
          return sum + toDcaCurrency(h.shares * (priceMap[h.ticker] ?? 0), h.currency, dcaCurrency, fxRate)
        }, 0)
        const totalWithDca = portfolioValue + dcaAmount
        if (totalWithDca > 0) {
          for (const h of holdings) {
            const val = toDcaCurrency(h.shares * (priceMap[h.ticker] ?? 0), h.currency, dcaCurrency, fxRate)
            const currentPct = (val / totalWithDca) * 100
            if (Math.abs(currentPct - h.targetAllocationPct) > (build.thresholdPct ?? 5)) {
              triggered = true
              break
            }
          }
        }
        if (triggered) break
      }

      if (trigger === 'periodic') {
        const freq = build.periodicFrequency ?? 'monthly'
        const bucket = getPeriodicBucket(dateStr, freq)
        if (bucket !== lastPeriodicBucket) {
          lastPeriodicBucket = bucket
          triggered = true
          break
        }
      }
    }

    // Apply buy/rebalance strategy
    if (triggered) {
      if (rebalanceStrategy === 'soft') {
        applySoftRebalance(dcaAmount, dcaCurrency, holdings, priceMap, fxRate)
      } else {
        applyHardRebalance(dcaAmount, dcaCurrency, holdings, priceMap, fxRate)
      }
    } else {
      applyProportionalBuy(dcaAmount, dcaCurrency, holdings, priceMap, fxRate)
    }

    // Restore original target allocations before computing drift/snapshots
    holdings.forEach((h, i) => { h.targetAllocationPct = originalAllocations[i] })

    // Compute portfolio value after buys
    const portfolioValue = holdings.reduce((sum, h) => {
      return sum + toDcaCurrency(h.shares * (priceMap[h.ticker] ?? 0), h.currency, dcaCurrency, fxRate)
    }, 0)

    const unrealizedPnL = portfolioValue - totalInvested
    const totalReturnPct = totalInvested > 0 ? ((portfolioValue / totalInvested) - 1) * 100 : 0

    // Per-holding breakdown
    const holdingSnapshots = holdings.map((h) => {
      const price = priceMap[h.ticker] ?? 0
      const value = toDcaCurrency(h.shares * price, h.currency, dcaCurrency, fxRate)
      const allocationPct = portfolioValue > 0 ? (value / portfolioValue) * 100 : 0
      const driftFromTarget = allocationPct - h.targetAllocationPct
      return {
        ticker: h.ticker,
        shares: h.shares,
        value,
        allocationPct,
        driftFromTarget,
      }
    })

    timeSeries.push({
      date: new Date(dateStr + 'T00:00:00Z'),
      portfolioValue,
      costBasis: totalInvested,
      unrealizedPnL,
      totalReturnPct,
      holdings: holdingSnapshots,
      rebalanceTriggered: triggered,
      rebalanceType: triggered ? rebalanceStrategy : undefined,
    })
  }

  const summary = computeSummary(timeSeries, totalInvested)

  return {
    buildId: build.id,
    runAt: new Date(),
    params: {
      dcaAmount: build.dcaAmount,
      dcaCurrency: build.dcaCurrency,
      dcaFrequency: build.dcaFrequency,
      startDate: build.startDate,
      endDate: build.endDate,
      rebalanceStrategy: build.rebalanceStrategy,
      rebalanceTriggers: build.rebalanceTriggers,
    },
    timeSeries,
    summary,
  }
}

// ─── Benchmark runner ─────────────────────────────────────────────────────────

/**
 * Run a backtest for a single-ticker Benchmark by synthesizing a Build.
 * Uses monthly $1,000 USD by default; overrideParams allows Compare to inject aligned DCA params.
 */
export function runBenchmark(
  benchmark: Benchmark,
  allPriceData: Record<string, PricePoint[]>,
  fxRates: PricePoint[],
  overrideParams?: {
    dcaAmount?: number
    dcaCurrency?: 'USD' | 'TWD'
    dcaFrequency?: 'weekly' | 'biweekly' | 'monthly'
    startDate?: Date
    endDate?: Date
  },
): BacktestResult {
  const syntheticBuild: Build = {
    id: benchmark.id,
    name: benchmark.name,
    holdings: [{
      ticker: benchmark.ticker,
      name: benchmark.name,
      currency: benchmark.currency,
      targetAllocationPct: 100,
    }],
    dcaAmount:    overrideParams?.dcaAmount    ?? 1000,
    dcaCurrency:  overrideParams?.dcaCurrency  ?? 'USD',
    dcaFrequency: overrideParams?.dcaFrequency ?? 'monthly',
    startDate:    overrideParams?.startDate    ?? benchmark.startDate,
    endDate:      overrideParams?.endDate      ?? benchmark.endDate,
    rebalanceStrategy: 'soft',
    rebalanceTriggers: ['on-dca'],
    isFavorite: benchmark.isFavorite,
    createdAt: benchmark.createdAt,
    updatedAt: new Date(),
  }
  return runBacktest(syntheticBuild, allPriceData, fxRates)
}
