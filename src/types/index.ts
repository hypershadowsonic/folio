// ─── Portfolio ────────────────────────────────────────────────────────────────

export interface BenchmarkConfig {
  ticker: string
  startPrice: number
  currentPrice: number
  currency: 'USD' | 'TWD'
  updatedAt: Date
}

export interface Portfolio {
  id: string
  name: string
  baseCurrency: 'TWD'           // base currency for valuation
  supportedCurrencies: ('USD' | 'TWD')[]
  monthlyDCABudget: number
  monthlyDCABudgetCurrency: 'USD' | 'TWD'
  defaultRebalanceStrategy: 'soft' | 'hard'
  defaultAllocationMethod: 'proportional-to-drift' | 'equal-weight'
  /**
   * The TWD/USD rate entered during setup. Used as a fallback when no real
   * FX lots exist yet (e.g. right after first-run wizard, before any FX
   * exchange is logged). Real rates from FxLots take precedence.
   */
  initialFxRate?: number
  /**
   * User-set manual override for the current valuation rate (TWD per USD).
   * When set, this takes precedence over the auto-derived rate from FxLots,
   * allowing ad-hoc rate corrections between actual FX transactions.
   */
  fxRateOverride?: number
  /**
   * Optional benchmark for performance comparison.
   * ticker must match a holding ticker for "Update from Holdings" auto-fill.
   * startPrice and currentPrice are manually entered (no live API in MVP).
   */
  benchmarkConfig?: BenchmarkConfig
  /**
   * Minimum buy amount per trade in each currency.
   * If a holding's calculated buy amount is below this threshold the trade is
   * skipped and its budget is redistributed to the remaining eligible holdings.
   * 0 or undefined = no minimum (disabled).
   */
  minimumBuyAmountUSD?: number
  minimumBuyAmountTWD?: number
  createdAt: Date
  updatedAt: Date
}

export type HoldingStatus = 'active' | 'legacy' | 'archived'

export interface Holding {
  id: string
  portfolioId: string
  ticker: string
  name: string
  sleeveId: string
  targetAllocationPct: number   // 0-100; always 0 for legacy/archived
  driftThresholdPct: number     // default 2
  currency: 'USD' | 'TWD'      // denomination of the holding
  /**
   * Lifecycle status:
   *   active   — invested, has target allocation, participates in DCA + drift
   *   legacy   — still held but no longer part of strategy (庫存); excluded from DCA
   *   archived — fully sold (shares = 0); excluded from all active views
   *
   * Defaults to 'active' for all existing holdings (set by DB migration).
   */
  status: HoldingStatus
  /** Timestamp when status was last set to 'archived'. Used for sort/display. */
  archivedAt?: Date
  // ── Position tracking (updated by operationService on every trade) ─────────
  currentShares?: number              // accumulated net shares
  currentPricePerShare?: number       // last manually-entered price per share
  averageCostBasis?: number           // weighted avg cost per share in holding's currency
  averageCostBasisBase?: number       // weighted avg cost per share in TWD (via FIFO FX)
}

export interface Sleeve {
  id: string
  portfolioId: string
  name: string
  targetAllocationPct: number   // sum of child holdings
  color: string                 // for visualization
}

// ─── Cash & FX ────────────────────────────────────────────────────────────────

export interface CashAccount {
  id: string
  portfolioId: string
  currency: 'USD' | 'TWD'
  balance: number               // current balance, updated by operations
}

export interface FxTransaction {
  id: string
  portfolioId: string
  timestamp: Date
  fromCurrency: 'USD' | 'TWD'
  toCurrency: 'USD' | 'TWD'
  fromAmount: number
  toAmount: number
  rate: number                  // toAmount / fromAmount
  fees: number
  feesCurrency: 'USD' | 'TWD'
  note?: string
}

export interface FxLot {
  id: string
  fxTransactionId: string       // which conversion created this lot
  currency: 'USD' | 'TWD'      // the currency of this lot
  originalAmount: number        // amount when created
  remainingAmount: number       // unconsumed amount (decreases as trades use it)
  rate: number                  // FX rate at time of conversion
  timestamp: Date               // for FIFO ordering
}

// ─── Operations ───────────────────────────────────────────────────────────────

// Extracted as a named union for reuse across the codebase
export type OperationType =
  | 'BUY'
  | 'SELL'
  | 'REBALANCE'
  | 'DCA'
  | 'TACTICAL_ROTATION'
  | 'DRAWDOWN_DEPLOY'
  | 'DIVIDEND_REINVEST'
  | 'FX_EXCHANGE'
  | 'CASH_DEPOSIT'
  | 'CASH_WITHDRAWAL'

export interface Operation {
  id: string
  portfolioId: string
  type: OperationType
  timestamp: Date
  entries: OperationEntry[]     // trade legs (empty for FX/CASH types)
  fxTransactionId?: string      // linked FX transaction (for FX_EXCHANGE type)
  cashFlow?: CashFlow           // linked cash movement (for CASH_DEPOSIT/WITHDRAWAL)
  rationale: string             // required
  tag?: string
  snapshotBefore: PortfolioSnapshot
  snapshotAfter: PortfolioSnapshot
}

export interface OperationEntry {
  holdingId: string
  side: 'BUY' | 'SELL'
  shares: number                // fractional amounts allowed (e.g., 0.573)
  pricePerShare: number         // in holding's currency
  fees: number
  currency: 'USD' | 'TWD'
  fxCostBasis?: {               // populated on BUY of foreign-currency holdings
    fxLotsConsumed: { lotId: string; amount: number; rate: number }[]
    blendedRate: number         // weighted average rate from consumed lots
    baseCurrencyCost: number    // total cost in TWD
  }
}

export interface CashFlow {
  currency: 'USD' | 'TWD'
  amount: number                // positive = deposit, negative = withdrawal
  note?: string
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

export interface PortfolioSnapshot {
  timestamp: Date
  totalValueBase: number        // total value in base currency (TWD)
  currentFxRate: number         // USD/TWD rate used for this snapshot
  cashBalances: { currency: string; balance: number }[]
  holdings: HoldingSnapshot[]
}

export interface HoldingSnapshot {
  holdingId: string
  shares: number
  pricePerShare: number         // in holding's currency
  marketValue: number           // in holding's currency
  marketValueBase: number       // in TWD
  costBasis: number             // in holding's currency
  costBasisBase: number         // in TWD (using FIFO FX rates)
  allocationPct: number
  driftFromTarget: number
}

// ─── Ammunition Pool ──────────────────────────────────────────────────────────

export interface AmmunitionPool {
  portfolioId: string
  tier1: { holdingId: string | null; value: number; deployTriggerPct: number }
  tier2: { holdingId: string | null; value: number; deployTriggerPct: number }
}

// ─── DCA Planner (derived types, used by Phase 4 engine) ─────────────────────

export type RebalanceStrategy = 'soft' | 'hard'
export type AllocationMethod = 'proportional-to-drift' | 'equal-weight'

export interface TradePlanRow {
  holdingId: string
  ticker: string
  side: 'BUY' | 'SELL'
  suggestedShares: number
  estimatedCost: number         // in holding's currency
  currency: 'USD' | 'TWD'
  // filled in by user after execution in IBKR
  actualPricePerShare?: number
  actualFees?: number
}

export interface DcaPlan {
  strategy: RebalanceStrategy
  allocationMethod: AllocationMethod
  budget: number
  budgetCurrency: 'USD' | 'TWD'
  rows: TradePlanRow[]
  totalEstimatedCost: number
  cashSufficient: boolean
  cashShortfall?: number
}
