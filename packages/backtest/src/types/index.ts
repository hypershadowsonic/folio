// ─── App UI types ────────────────────────────────────────────────────────────

export type TabId = 'dashboard' | 'builds' | 'settings'
export type DisplayCurrency = 'USD' | 'TWD'
export type Theme = 'light' | 'dark'
export type ApiStatus = 'online' | 'offline-cached' | 'offline-no-cache'

// ─── Yahoo Finance client types ───────────────────────────────────────────────

export interface TickerSearchResult {
  ticker: string
  name: string
  exchange: string
  type: string
}

export interface PricePoint {
  date: string         // ISO date string YYYY-MM-DD
  adjustedClose: number
}

export interface CacheStats {
  tickerCount: number
  totalPricePoints: number
  oldestFetchedAt: Date | null
}

// ─── Domain types (PRD §8) ───────────────────────────────────────────────────

export type RebalanceTrigger = 'on-dca' | 'periodic' | 'threshold'

export interface BuildHolding {
  ticker: string
  name: string
  currency: 'USD' | 'TWD'
  targetAllocationPct: number    // 0-100, must sum to 100
}

export interface Build {
  id: string
  name: string
  holdings: BuildHolding[]
  dcaAmount: number
  dcaCurrency: 'USD' | 'TWD'
  dcaFrequency: 'weekly' | 'biweekly' | 'monthly'
  startDate: Date
  endDate: Date                  // default: today
  rebalanceStrategy: 'soft' | 'hard'
  rebalanceTriggers: RebalanceTrigger[]
  thresholdPct?: number          // for 'threshold' trigger, default 5
  periodicFrequency?: 'monthly' | 'quarterly' | 'annually'  // for 'periodic' trigger
  isFavorite: boolean
  createdAt: Date
  updatedAt: Date
  lastBacktestResult?: BacktestResult
}

export interface Benchmark {
  id: string
  ticker: string
  name: string
  currency: 'USD' | 'TWD'
  startDate: Date
  endDate: Date
  isFavorite: boolean
  createdAt: Date
  lastBacktestResult?: BacktestResult  // using default monthly DCA $1,000/month
}

export interface CompareItem {
  type: 'build' | 'benchmark'
  refId: string                  // Build.id or Benchmark.id
}

export interface Compare {
  id: string
  name: string
  items: CompareItem[]           // 2-4 items
  isFavorite: boolean
  createdAt: Date
  lastCompareResult?: CompareResult
}

// ─── Backtest result types ────────────────────────────────────────────────────

export interface BacktestDataPoint {
  date: Date
  portfolioValue: number         // in build's dcaCurrency
  costBasis: number              // total invested so far
  unrealizedPnL: number
  totalReturnPct: number         // (portfolioValue / costBasis - 1) × 100
  holdings: {
    ticker: string
    shares: number
    value: number
    allocationPct: number
    driftFromTarget: number
  }[]
  rebalanceTriggered: boolean    // did a rebalance happen on this date
  rebalanceType?: 'soft' | 'hard'
}

export interface BacktestSummary {
  totalReturn: number            // absolute: endValue - totalInvested
  totalReturnPct: number
  annualizedReturnPct: number
  totalInvested: number
  endValue: number
  maxDrawdownPct: number
  bestMonthPct: number
  worstMonthPct: number
  totalRebalances: number
  yoyGrowthPct: number | null    // null if < 1 year of data
  momGrowthPct: number | null    // null if < 1 month of data
}

export interface BacktestResult {
  buildId: string
  runAt: Date
  params: {                      // snapshot of params at run time
    dcaAmount: number
    dcaCurrency: 'USD' | 'TWD'
    dcaFrequency: string
    startDate: Date
    endDate: Date
    rebalanceStrategy: string
    rebalanceTriggers: string[]
  }
  timeSeries: BacktestDataPoint[]
  summary: BacktestSummary
}

export interface CompareResult {
  compareId: string
  runAt: Date
  alignedParams: {               // the shared DCA params used
    dcaAmount: number
    dcaCurrency: 'USD' | 'TWD'
    dcaFrequency: string
    startDate: Date
    endDate: Date
  }
  items: {
    refId: string
    name: string
    type: 'build' | 'benchmark'
    result: BacktestResult
  }[]
}

// ─── Price cache ──────────────────────────────────────────────────────────────

export interface PriceCache {
  ticker: string                 // primary key
  startDate: Date
  endDate: Date
  interval: '1d'
  prices: PricePoint[]
  fetchedAt: Date
}
