# Folio — Unified Portfolio & Strategy Tracker

## 1. Product Overview

Folio is a cross-platform (web + mobile PWA) investment toolkit for systematic, rules-based investors. It unifies two disciplines into a single app with two switchable modes:

| Mode | Purpose | Accent Color |
|------|---------|--------------|
| **Portfolio** (formerly Folio) | Live portfolio tracking — log operations, monitor drift, plan DCA | Cyan blue |
| **Build** (formerly Folio Build) | Strategy simulation — backtest DCA portfolios, compare against benchmarks | Light orange |

**Core thesis**: Research in Build, execute in Portfolio. The same engine that powers your backtest governs your live portfolio — so what you simulate is what you actually run.

**App shell**: A persistent mode toggle in the top-right corner switches between modes at any time. Each mode has its own bottom navigation tabs. Accent color shifts to reflect the active mode.

**Reference products**: YNAB (opinionated discipline, operations-centric) + Portfolio Visualizer (DCA backtesting) — designed for mobile-first use during market hours and desktop analysis.

---

## 2. Core Philosophy

### Portfolio mode — operations-centric
Every portfolio action is a first-class event: what you did, why you did it, and the before/after state. The tool enforces discipline (rationale required, immutable operations) rather than being a neutral spreadsheet.

### Build mode — simulation-centric
Hypothetical portfolios with real historical prices. The backtest engine mirrors the live rebalance engine exactly — so a strategy that works in simulation uses the same algorithms in production.

### Shared discipline
DCA engine, rebalance engine, drift monitor, ticker search, and live price infrastructure are shared between modes. No configuration drift between simulation and live portfolio.

---

## 3. Primary User

**Evan, 32, Media Designer / Systematic Investor**

- Manages a 10-holding ETF framework across US and Taiwan markets via IBKR
- Uses monthly DCA with tactical rebalancing and a two-tier cash reserve for drawdown deployment
- Currently tracks in Google Sheets + IBKR — functional but fragmented
- Wants to test allocation changes in Build before committing to Portfolio
- Pain points: no drift alerts, no unified "what should I do this month" view, no simulation tool tied to his actual strategy

---

## 4. Modes & App Shell

### 4.1 Mode Toggle

- Always-visible toggle in the top-right corner of the app header
- Toggle switch with labels: **Portfolio** | **Build**
- Switching mode: swaps the bottom navigation tabs, shifts accent color, preserves scroll position per mode
- Current mode persisted in localStorage across sessions

### 4.2 Portfolio Mode Navigation (5 tabs)

| Tab | Icon | Purpose |
|-----|------|---------|
| Dashboard | Home | Portfolio health at a glance |
| DCA Planner | Calculator | Monthly trade plan generation |
| Operations | History | Log and review all operations |
| Performance | Chart | Returns, P&L, benchmark comparison |
| Settings | Gear | Portfolio config, cash & FX, IBKR import |

### 4.3 Build Mode Navigation (4 tabs)

| Tab | Icon | Purpose |
|-----|------|---------|
| Dashboard | Home | Favorite Build/Benchmark/Compare quick view |
| Builds | Layers | All Builds, Benchmarks, Compares |
| Compare | GitCompare | Create/view comparison sets |
| Settings | Gear | Cache, export/import, display currency |

---

## 5. Domain Model — Core Concepts

### 5.1 FolioLive (Portfolio entity)

A live portfolio contains:
- **Holdings**: ticker, target allocation %, current shares, average cost basis
- **Sleeves**: named groups of holdings with a collective target allocation (e.g., "Core" = 50%, "Thematic" = 20%)
- **Target Allocations**: per-holding % and per-sleeve %; all holdings must sum to 100%
- **Drift Thresholds**: per-holding tolerance band (default ±2%) for rebalance signals
- **Cash Accounts**: per-currency (TWD, USD) — first-class entities updated by every operation
- **FX Lots**: FIFO queue of currency conversion lots for accurate TWD cost basis
- **Operations**: immutable log of every portfolio action
- **Snapshots**: point-in-time portfolio state captured on every operation

### 5.2 BuildStrategy (Build entity)

A hypothetical portfolio for simulation:
- **Name**: user-defined
- **Holdings**: tickers with target allocation % (must sum to 100%)
- **DCA Settings**: amount, currency, frequency (weekly/biweekly/monthly), start date, end date
- **Rebalance Settings**: strategy (soft/hard), triggers (on-dca/periodic/threshold), threshold %, periodic frequency
- **Backtest Results**: cached time-series and summary metrics from the last run
- **Metadata**: created at, updated at, favorite flag
- **Source Info**: lineage link if promoted from or forked from another entity

### 5.3 EntityLink (Lineage)

Tracks the relationship between a BuildStrategy and a FolioLive:
- `sourceBuildId`: ID of the originating Build (if relationType is promoted_from)
- `sourceFolioId`: ID of the originating Portfolio (if relationType is forked_from)
- `targetBuildId`: ID of the resulting Build (if relationType is forked_from)
- `targetFolioId`: ID of the resulting Portfolio (if relationType is promoted_from)
- `relationType`: `promoted_from` | `forked_from`
- `createdAt`: timestamp of the promotion/fork action

### 5.4 Cash Account & FIFO FX Lots

Cash is a first-class entity — not a side effect of operations.
- Each currency (TWD, USD) has an explicit `CashAccount` updated by deposits, withdrawals, FX conversions, and trade settlements
- FX conversions create `FxLot` entries with a FIFO queue. When buying USD-denominated ETFs, the oldest unconsumed lot is consumed first.
- **FIFO is sacred**: never use LIFO, average cost, or any other method for FX cost basis. Share-level realized P&L uses weighted-average cost basis (not FIFO).
- The most recent FX transaction rate serves as the live FX rate for Portfolio valuation (supplements/falls back from Yahoo Finance rate)

### 5.5 Ammunition Pool

Two-tier cash reserve for drawdown deployment:
- **Tier 1 (Ready)**: deploys at configurable drawdown trigger (e.g., -10% from ATH). Typically earmarked SGOV holdings.
- **Tier 2 (Reserve)**: deploys at deeper drawdown (e.g., -20%)
- Trigger proximity shown on Portfolio Dashboard

---

## 6. Portfolio Mode — Feature Spec

### F-P1: Portfolio Setup

**Description**: Define holdings, target allocations, drift thresholds, DCA defaults.

**Acceptance Criteria**:
- Add/remove holdings: ticker search (Yahoo Finance autocomplete), target allocation %, denomination currency (USD/TWD), drift threshold (default ±2%), sleeve assignment
- Create/edit sleeves: name, color, collective target allocation %
- Target allocations must sum to 100% at both holding level and sleeve level (real-time validation)
- Multi-currency: each holding tagged with denomination (USD or TWD)
- Cash accounts created for each currency with starting balance
- Default DCA settings: monthly budget, currency, rebalance strategy (soft/hard), allocation method (proportional-to-drift/equal-weight)
- Ammunition pool config: tier 1 holding, tier 1 trigger %, tier 2 holding, tier 2 trigger %
- Benchmark selection (for Performance tab comparison, default: VOO)

**UI Behavior**: Wizard-style onboarding on first launch; editable via Settings tab afterward.

---

### F-P2: Portfolio Dashboard

**Description**: Home screen showing portfolio trajectory and health at a glance.

**Acceptance Criteria**:
- Hero: portfolio total value line chart (default: 1Y, selectable: 1M/3M/6M/YTD/1Y/ALL)
- Currency toggle (TWD/USD) switches all displayed values
- Quick stats bar: total value, unrealized P&L (amount + %), today's change (from previous day's close via live prices)
- Allocation overview: current vs target per-holding, color-coded by drift status (green/yellow/red)
- Cash balances: TWD and USD, with TWD-equivalent total
- Ammunition pool status: Tier 1/Tier 2 levels and deployment trigger proximity
- Recent operations: last 3 (compact cards: date, type, ticker, amount)

**UI Behavior**: First tab. Pull-to-refresh triggers price refresh for all holdings. "Price last updated" timestamp shown.

---

### F-P3: DCA Planner

**Description**: Monthly trade plan generation with one-tap operation logging.

**Acceptance Criteria**:
- Rebalance strategy selector:
  - **Soft (buy-only)**: over-allocate DCA budget to underweight holdings, skip overweight holdings
  - **Hard (sell+buy)**: sell overweight, buy underweight, net new DCA cash applied to result
- Allocation method selector:
  - **Proportional-to-drift**: more budget to the most underweight holdings
  - **Equal-weight**: split evenly across underweight holdings
- DCA budget input (pre-filled from settings, editable per session)
- Generated trade plan: ticker, action (BUY/SELL), suggested shares, estimated cost, currency
- **Cash sufficiency check**: inline warning if planned trades exceed available cash (e.g., "Need $1,200 more USD — convert ~TWD 38,400 at current rate")
- **Execution logging**: each row has editable actual price + fees fields (pre-filled with current live price)
- **One-tap "Log All"**: creates a single `DCA` or `REBALANCE` Operation with all entries, captures before/after snapshot, requires rationale. Disabled until at least one row has actual price filled.

**UI Behavior**: Separate tab. Strategy/method selections persist across sessions.

---

### F-P4: Operation Logger & History

**Description**: Record and review all portfolio operations.

**Acceptance Criteria (Logger)**:
- Operation types: `BUY` | `SELL` | `REBALANCE` | `DCA` | `TACTICAL_ROTATION` | `DRAWDOWN_DEPLOY` | `DIVIDEND_REINVEST` | `FX_EXCHANGE` | `CASH_DEPOSIT` | `CASH_WITHDRAWAL`
- Fields: type, ticker(s), shares, price (editable, pre-filled with live price), fees, rationale (required), tag (optional)
- Auto-captures portfolio snapshot before and after
- Operations are **immutable** after creation (can add notes, cannot edit core data)
- Ticker field: autocomplete from portfolio holdings and Yahoo Finance search

**Acceptance Criteria (History)**:
- Chronological list: date, type, holdings, P&L impact
- Filter by: type, tag, date range
- Tap to expand: full details including rationale, before/after snapshot
- Export to CSV
- Full-text search across rationale field

**UI Behavior**: History list in Operations tab. "+" FAB opens logger form.

---

### F-P5: Performance

**Description**: Portfolio returns and P&L attribution.

**Acceptance Criteria**:
- Dual-axis line chart: Portfolio Value (left axis), Unrealized P&L and Total P&L (right axis)
- Key metrics: Portfolio Value (excl. cash), Unrealized P&L, Realized P&L (weighted-avg cost basis), Total P&L
- Month-over-month growth: current month + trailing 12-month bar chart
- Benchmark comparison: overlay line against user-selected benchmark (e.g., VOO), using same contribution dates and amounts as the user's actual deposits
- Period summary: start/end value, deposits, withdrawals, net gain
- Per-holding breakdown: each holding's contribution to total P&L
- Date range selector: 1M/3M/6M/YTD/1Y/ALL/custom
- Currency toggle: TWD/USD

**Out of scope in MVP**: TWR (Time-Weighted Return) and MWR (Money-Weighted Return) — deferred to a future phase.

**UI Behavior**: Portfolio value on this tab always excludes cash balances. Tap a holding row to open its operation history filtered to that ticker.

---

### F-P6: Drift Monitor

**Description**: Visual alert system for allocation drift.

**Acceptance Criteria**:
- Per-holding drift visualization: current allocation vs target, ±threshold band
- Color coding: green (within band), yellow (within 50% of band), red (exceeded)
- Badge on Operations/Dashboard tabs when any holding exceeds threshold
- PWA notification if permitted (on open or daily check)

**UI Behavior**: Embedded in Portfolio Dashboard allocation section. Also surfaced as alerts.

---

### F-P7: Cash & FX Management

**Description**: Track cash balances and FX transactions with FIFO cost basis.

**Acceptance Criteria**:
- Cash accounts: current balance per currency (TWD, USD), updated by operations
- Cash deposit/withdrawal logger: amount, currency, date, note
- FX transaction logger: date, from-currency, from-amount, to-currency, to-amount, rate (auto-calculated or manual), fees, note
- FIFO lot queue display: each unconsumed lot with date, rate, remaining amount; consumed lots greyed out
- Auto-consumption on BUY: oldest FX lot(s) consumed, FIFO-blended cost basis stored on OperationEntry
- Current FX rate: sourced from Yahoo Finance (USDTWD=X), with manual override option
- Cash sufficiency check surfaced in DCA Planner and Operation Logger

**UI Behavior**: Accessible from Settings tab → Cash & FX section.

---

### F-P8: IBKR Import

**Description**: Import trades from Interactive Brokers Activity Statement CSV.

**Acceptance Criteria**:
- Upload IBKR Activity Statement CSV (offline, no API connection)
- Parse and preview trades before import
- Map IBKR tickers to portfolio holdings
- Import as Operations (auto-fills price, shares, fees from CSV)
- Duplicate detection: skip rows already logged

**Source**: `src/lib/ibkrParser.ts` + `src/features/settings/IBKRImport.tsx` (already implemented in Phase 3)

---

## 7. Build Mode — Feature Spec

### F-B1: Build Creator

**Description**: Create and configure a hypothetical DCA portfolio for backtesting.

**Acceptance Criteria**:
- Ticker search: Yahoo Finance autocomplete (debounced 300ms, shows ticker + name + exchange)
- Holdings table: ticker, name, allocation %, denomination (USD/TWD), remove button
- Allocation must sum to 100% (real-time validation with remaining % display)
- DCA settings: amount, currency (USD/TWD), frequency (weekly/biweekly/monthly), start date (calendar, no future dates), end date (default: today)
- Rebalance settings:
  - Strategy: soft (buy-only) | hard (sell+buy)
  - Triggers: checkboxes for on-dca / periodic / threshold (at least one required)
  - Periodic frequency: monthly/quarterly/annually (shown only if periodic selected)
  - Threshold %: input with ±% label (shown only if threshold selected), default ±5%
- "Run Backtest" → executes simulation → shows result with chart + metrics
- Editable after creation — changing params shows "Re-run Backtest" button

**UI Behavior**: Wizard-style on mobile, single scrollable page on desktop.

---

### F-B2: Backtest Engine

**Description**: Simulate DCA + rebalancing over historical Yahoo Finance data.

**Acceptance Criteria**:
- Fetches adjusted close prices from `api/prices.py` for all holdings from start to end date
- Simulation loop on each DCA date:
  1. Add DCA amount to available cash
  2. Evaluate rebalance triggers (on-dca: always; periodic: schedule match; threshold: any holding drift > threshold)
  3. If rebalance triggered: apply soft or hard rebalance logic (shared rebalance engine)
  4. If no rebalance: allocate DCA cash proportionally to target %
  5. Record: date, portfolio value, cost basis, per-holding shares/values
- Non-trading days: use next available trading day's close price
- Splits/dividends: handled automatically via Yahoo Finance adjusted close
- Multi-currency: fetch USDTWD=X via `api/prices.py` and convert at each DCA date

**Output**: `BacktestResult` with time series + summary metrics

---

### F-B3: Benchmark Runner

**Description**: Single-ticker DCA simulation for comparison baseline.

**Acceptance Criteria**:
- Ticker search (Yahoo Finance)
- Standalone preview: monthly $1,000 USD, earliest available data to today
- In Compare: adopts first Build's DCA amount, frequency, and date range
- Same engine as F-B2 with single holding at 100%, no rebalancing
- Identical output format to F-B2 for seamless comparison

---

### F-B4: Compare View

**Description**: Side-by-side comparison of up to 4 Builds/Benchmarks.

**Acceptance Criteria**:
- Select 2–4 items from existing Builds and Benchmarks
- Alignment: all items use same DCA params from first Build (or first Benchmark if no Build)
- Chart: overlay line chart, one line per item, color-coded
  - Y-axis toggle: absolute value ($) ↔ growth rate (%)
  - Growth rate: normalized to 0% at start, each point = (value/invested - 1) × 100
  - Tooltip: date + each item's value/growth + rank
- Comparison metrics table:

  | Metric | Item A | Item B | Item C |
  |--------|--------|--------|--------|
  | Total Return % | | | |
  | Annualized Return % | | | |
  | Total Value | | | |
  | Total Invested | | | |
  | Max Drawdown % | | | |
  | Best Month % | | | |
  | Worst Month % | | | |

  Best value in each row highlighted (green/bold)
- Display currency: USD/TWD toggle, applies to all items
- Save as a named Compare object

---

### F-B5: Build Dashboard

**Description**: Quick view of the user's pinned Favorite item.

**Acceptance Criteria**:
- Hero card: Favorite item's full-history chart
  - Build or Benchmark: single line
  - Compare: overlay chart with all items
- Metrics below chart: YoY growth, MoM growth, Overall growth, Total Value, Total Invested
- If no Favorite: placeholder with "Pin a Build or Compare as your Favorite from the Builds tab"
- "Open in Builds →" link to navigate to detail view
- Currency toggle: USD/TWD

---

### F-B6: Builds Tab

**Description**: Card-based list of all Builds, Benchmarks, and Compares.

**Acceptance Criteria**:
- Card types:
  - **Build card**: sparkline, name, total return %, annualized return %, allocation summary (N holdings), star for Favorite
  - **Benchmark card**: sparkline, ticker prominently, total return %, star
  - **Compare card**: mini overlay sparkline, name, N items, star
- Sort: Favorite pinned first, then by creation date descending
- Tap card → detail view (chart + metrics + Edit/Re-run for Builds)
- Long-press/swipe → Duplicate, Delete
- FAB or top-right menu: "Add Build" | "Add Benchmark" | "Compare"
- Desktop: 2-column grid. Mobile: single column.

---

### F-B7: Build Settings

**Description**: Data management and cache for Build mode.

**Acceptance Criteria**:
- Import Builds/Benchmarks/Compares from JSON
- Export all Build data as JSON
- Display currency default: USD/TWD
- Price cache: show cache size and "Clear Cache" button (Yahoo Finance data cached in IndexedDB)
- Theme toggle (links to shared setting)

---

## 8. Shared Features & Engines

### 8.1 Ticker Search

- **API**: `GET /api/search?q={query}` via Python serverless (`api/search.py`, yfinance)
- Debounced 300ms, returns: ticker, company name, exchange, currency
- Used in: Portfolio holding setup, Build creator, Benchmark creator, Operation Logger

### 8.2 Live Price Fetching

- **API**: `GET /api/prices?ticker={ticker}&start={date}&end={date}` via `api/prices.py`
- Returns daily adjusted close prices
- **Price cache**: stored in Dexie `PriceCache` table (ticker + date range), TTL 24 hours
- **FX rate**: `USDTWD=X` fetched via same endpoint
- **Portfolio mode**: latest price used for current portfolio valuation and pre-filling operation entry prices. Operations still store the actual execution price entered by the user.
- **Build mode**: full history used for backtest simulation
- Manual refresh button + "last updated" timestamp shown throughout

### 8.3 Rebalance Engine

Shared pure function in `src/engine/rebalance.ts`:
- Inputs: current holdings (shares, price), target allocations, DCA budget (optional), strategy, allocation method
- **Soft rebalance**: allocate new cash only to underweight holdings, proportional-to-drift or equal-weight
- **Hard rebalance**: generate SELL orders for overweight holdings, then BUY orders to restore targets
- Output: `TradePlan[]` with ticker, action, shares, estimated cost, estimated drift post-trade
- Used in: Portfolio DCA Planner, Build Backtest Engine

### 8.4 DCA Engine

Shared calculation in `src/engine/dca.ts`:
- Inputs: DCA amount, currency, frequency, holdings, rebalance settings
- Determines contribution dates, per-holding allocation amounts
- Used in: Portfolio DCA Planner, Build Backtest Engine

### 8.5 Drift Monitor

Shared calculation in `src/engine/drift.ts`:
- Inputs: current allocations, target allocations, per-holding drift thresholds
- Output: `DriftStatus[]` with per-holding drift amount, status (ok/warning/alert)
- Used in: Portfolio Dashboard drift visualization, Build threshold trigger evaluation

---

## 9. Portfolio ↔ Build Linking

### 9.1 Promote Build → Portfolio

**When**: User has created and validated a Build, and wants to start live-tracking it as a Portfolio.

**Flow**:
1. In Build detail view → "Promote to Portfolio" action
2. User selects base currency (TWD recommended for IBKR users in Taiwan)
3. User optionally adjusts DCA defaults before promotion
4. App creates a new `FolioLive` entity with:
   - Holdings and target allocations from Build
   - DCA settings from Build
   - Rebalance strategy from Build
5. `EntityLink` created: `{ sourceBuildId: Build.id, targetFolioId: newFolio.id, relationType: 'promoted_from' }`
6. App switches to Portfolio mode and opens the new Portfolio

**What is transferred**:
- Holdings + target allocations
- Rebalance strategy and trigger settings
- Default DCA settings (amount, currency, frequency)
- Display/base currency

**What is NOT transferred**:
- Historical backtest results
- Benchmark compare objects
- Hypothetical shares or simulated cost basis

---

### 9.2 Fork Portfolio → Build

**When**: User wants to use the backtest feature based on their live portfolio, or wants to test a variation of it.

**Flow**:
1. In Portfolio Settings → "Fork to Build" action
2. User selects source type:
   - **Target Allocation**: creates a Build based on current Portfolio's target allocations and DCA settings
   - **Historical Snapshot**: creates a Build reflecting actual holdings on a selected past date (from snapshot history)
3. User optionally includes DCA defaults and rebalance settings from Portfolio
4. User names the new Build
5. App creates a new `BuildStrategy` entity
6. `EntityLink` created: `{ sourceFolioId: Portfolio.id, targetBuildId: newBuild.id, relationType: 'forked_from' }`
7. App switches to Build mode and opens the new Build

**What is transferred** (always):
- Holdings + target allocations (from chosen source)

**What is optionally transferred** (user chooses):
- DCA defaults (amount, currency, frequency)
- Rebalance strategy and settings

---

### 9.3 Lineage Display

- In Build detail view: if promoted from a Portfolio, show "Promoted from [Portfolio Name]" with link to Portfolio mode
- In Portfolio Settings: if forked from or promoted from a Build, show "Linked Build: [Build Name]" with link to Build mode
- EntityLinks are informational only — not synchronized automatically

---

## 10. Data Model (TypeScript Interfaces)

```typescript
// ===== SHARED =====

interface PriceCache {
  ticker: string;
  startDate: Date;
  endDate: Date;
  interval: '1d';
  prices: { date: Date; adjustedClose: number }[];
  fetchedAt: Date;
}

// ===== PORTFOLIO MODE =====

interface FolioLive {
  id: string;
  name: string;
  baseCurrency: 'TWD' | 'USD';
  supportedCurrencies: ('USD' | 'TWD')[];
  monthlyDCABudget: number;
  monthlyDCABudgetCurrency: 'USD' | 'TWD';
  defaultRebalanceStrategy: 'soft' | 'hard';
  defaultAllocationMethod: 'proportional-to-drift' | 'equal-weight';
  benchmarkTicker: string;       // default: 'VOO'
  createdAt: Date;
  updatedAt: Date;
}

interface Holding {
  id: string;
  folioId: string;
  ticker: string;
  name: string;
  sleeveId: string;
  targetAllocationPct: number;   // 0–100; all holdings must sum to 100
  driftThresholdPct: number;     // default 2
  currency: 'USD' | 'TWD';
  averageCostBasis: number;      // weighted average cost per share, in holding's currency
  totalShares: number;
}

interface Sleeve {
  id: string;
  folioId: string;
  name: string;
  targetAllocationPct: number;   // sum of child holdings
  color: string;                 // for visualization
}

interface CashAccount {
  id: string;
  folioId: string;
  currency: 'USD' | 'TWD';
  balance: number;
}

interface FxTransaction {
  id: string;
  folioId: string;
  timestamp: Date;
  fromCurrency: 'USD' | 'TWD';
  toCurrency: 'USD' | 'TWD';
  fromAmount: number;
  toAmount: number;
  rate: number;                  // toAmount / fromAmount
  fees: number;
  feesCurrency: 'USD' | 'TWD';
  note?: string;
}

interface FxLot {
  id: string;
  fxTransactionId: string;
  currency: 'USD' | 'TWD';
  originalAmount: number;
  remainingAmount: number;
  rate: number;
  timestamp: Date;
}

interface Operation {
  id: string;
  folioId: string;
  type: 'BUY' | 'SELL' | 'REBALANCE' | 'DCA' | 'TACTICAL_ROTATION'
      | 'DRAWDOWN_DEPLOY' | 'DIVIDEND_REINVEST'
      | 'FX_EXCHANGE' | 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL';
  timestamp: Date;
  entries: OperationEntry[];
  fxTransactionId?: string;
  cashFlow?: CashFlow;
  rationale: string;             // REQUIRED — not optional
  tag?: string;
  snapshotBefore: PortfolioSnapshot;
  snapshotAfter: PortfolioSnapshot;
}

interface OperationEntry {
  holdingId: string;
  side: 'BUY' | 'SELL';
  shares: number;
  pricePerShare: number;         // actual execution price in holding's currency
  fees: number;
  currency: 'USD' | 'TWD';
  fxCostBasis?: {
    fxLotsConsumed: { lotId: string; amount: number; rate: number }[];
    blendedRate: number;
    baseCurrencyCost: number;    // total cost in TWD
  };
}

interface CashFlow {
  currency: 'USD' | 'TWD';
  amount: number;                // positive = deposit, negative = withdrawal
  note?: string;
}

interface PortfolioSnapshot {
  timestamp: Date;
  totalValueBase: number;        // total value in base currency
  currentFxRate: number;         // USD/TWD rate used for this snapshot
  cashBalances: { currency: string; balance: number }[];
  holdings: HoldingSnapshot[];
}

interface HoldingSnapshot {
  holdingId: string;
  ticker: string;
  shares: number;
  pricePerShare: number;
  marketValue: number;           // in holding's currency
  marketValueBase: number;       // in base currency
  costBasis: number;             // in holding's currency (weighted average)
  costBasisBase: number;         // in base currency (using FIFO FX rates)
  allocationPct: number;
  driftFromTarget: number;
}

interface AmmunitionPool {
  folioId: string;
  tier1: { holdingId: string; deployTriggerPct: number };
  tier2: { holdingId: string; deployTriggerPct: number };
}

// ===== BUILD MODE =====

interface BuildStrategy {
  id: string;
  name: string;
  holdings: BuildHolding[];
  dcaAmount: number;
  dcaCurrency: 'USD' | 'TWD';
  dcaFrequency: 'weekly' | 'biweekly' | 'monthly';
  startDate: Date;
  endDate: Date;
  rebalanceStrategy: 'soft' | 'hard';
  rebalanceTriggers: RebalanceTrigger[];
  thresholdPct?: number;         // for 'threshold' trigger, default 5
  periodicFrequency?: 'monthly' | 'quarterly' | 'annually';
  isFavorite: boolean;
  sourceInfo?: {                 // populated if forked from Portfolio
    sourceFolioId: string;
    forkType: 'target_allocation' | 'historical_snapshot';
    snapshotDate?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
  lastBacktestResult?: BacktestResult;
}

type RebalanceTrigger = 'on-dca' | 'periodic' | 'threshold';

interface BuildHolding {
  ticker: string;
  name: string;
  currency: 'USD' | 'TWD';
  targetAllocationPct: number;   // 0–100; must sum to 100
}

interface Benchmark {
  id: string;
  ticker: string;
  name: string;
  currency: 'USD' | 'TWD';
  isFavorite: boolean;
  createdAt: Date;
  lastBacktestResult?: BacktestResult;
}

interface Compare {
  id: string;
  name: string;
  items: CompareItem[];          // 2–4 items
  isFavorite: boolean;
  createdAt: Date;
  lastCompareResult?: CompareResult;
}

interface CompareItem {
  type: 'build' | 'benchmark';
  refId: string;
}

interface BacktestResult {
  buildId: string;
  runAt: Date;
  params: {
    dcaAmount: number;
    dcaCurrency: 'USD' | 'TWD';
    dcaFrequency: string;
    startDate: Date;
    endDate: Date;
    rebalanceStrategy: string;
    rebalanceTriggers: string[];
  };
  timeSeries: BacktestDataPoint[];
  summary: BacktestSummary;
}

interface BacktestDataPoint {
  date: Date;
  portfolioValue: number;
  costBasis: number;
  unrealizedPnL: number;
  totalReturnPct: number;
  holdings: {
    ticker: string;
    shares: number;
    value: number;
    allocationPct: number;
    driftFromTarget: number;
  }[];
  rebalanceTriggered: boolean;
  rebalanceType?: 'soft' | 'hard';
}

interface BacktestSummary {
  totalReturn: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  totalInvested: number;
  endValue: number;
  maxDrawdownPct: number;
  bestMonthPct: number;
  worstMonthPct: number;
  totalRebalances: number;
  yoyGrowthPct: number | null;
  momGrowthPct: number | null;
}

interface CompareResult {
  compareId: string;
  runAt: Date;
  alignedParams: {
    dcaAmount: number;
    dcaCurrency: 'USD' | 'TWD';
    dcaFrequency: string;
    startDate: Date;
    endDate: Date;
  };
  items: {
    refId: string;
    name: string;
    type: 'build' | 'benchmark';
    result: BacktestResult;
  }[];
}

// ===== LINEAGE =====

interface EntityLink {
  id: string;
  sourceBuildId?: string;        // set when relationType is 'promoted_from'
  sourceFolioId?: string;        // set when relationType is 'forked_from'
  targetFolioId?: string;        // set when relationType is 'promoted_from'
  targetBuildId?: string;        // set when relationType is 'forked_from'
  relationType: 'promoted_from' | 'forked_from';
  createdAt: Date;
}
```

---

## 11. Tech Stack

### Frontend
| Layer | Choice |
|-------|--------|
| Framework | React 18 + TypeScript (strict) |
| Build | Vite |
| UI | Tailwind CSS v3 + shadcn/ui |
| State | Zustand |
| Charts | Recharts |
| Local DB | Dexie.js (IndexedDB) |
| PWA | Workbox (Phase 13) |
| Deployment | Vercel |

### Backend (Yahoo Finance proxy only)
| Layer | Choice |
|-------|--------|
| Runtime | JavaScript (Node.js 18) serverless functions in `api/` — Vercel auto-deploys |
| API source | Yahoo Finance v8 chart API (no API key required) via native `fetch` |
| Endpoints | `GET /api/prices` · `GET /api/search` |
| CORS | `Access-Control-Allow-Origin: *` header in function response |
| Local dev | `vercel dev` runs frontend + JS functions together |

> **Note**: The `api/` functions use native Node.js `fetch` — no Python, no `yfinance` library. `packages/backtest/api/prices.js` and `search.js` are the reference implementations.

### Project Structure (target after merge)
```
folio/
├── src/
│   ├── components/           shared UI (ui/*, BottomNav, ModeToggle, ErrorBoundary)
│   ├── features/
│   │   ├── dashboard/        Portfolio: dashboard
│   │   ├── dca-planner/      Portfolio: DCA planner
│   │   ├── operations/       Portfolio: operation logger + history
│   │   ├── performance/      Portfolio: performance analytics
│   │   ├── settings/         Portfolio: portfolio config, cash/FX, IBKR
│   │   └── build/            Build mode (ported from packages/backtest)
│   │       ├── dashboard/
│   │       ├── builds/
│   │       ├── compares/
│   │       └── settings/
│   ├── engine/               shared pure logic
│   │   ├── rebalance.ts      soft/hard rebalance (Portfolio + Build shared)
│   │   ├── drift.ts          drift monitor (Portfolio + Build shared)
│   │   ├── backtest.ts       DCA simulation (ported from packages/backtest)
│   │   ├── compare.ts        compare alignment engine (ported)
│   │   ├── fifo.ts           FIFO FX lot queue (Portfolio only)
│   │   └── performance.ts    P&L calculations (Portfolio only)
│   ├── services/
│   │   ├── yahooFinance.ts   Yahoo Finance client + PriceCache (ported from packages/backtest)
│   │   ├── autoSnapshot.ts   daily snapshot scheduler
│   │   └── notifications.ts  drift alert notifications
│   ├── db/
│   │   └── database.ts       Dexie schema (all tables, Portfolio + Build)
│   ├── stores/
│   │   ├── modeStore.ts      active mode (portfolio/build) — new
│   │   ├── portfolioStore.ts Portfolio state
│   │   ├── buildStore.ts     Build state (ported from packages/backtest)
│   │   └── uiStore.ts        shared UI state
│   ├── hooks/
│   ├── types/index.ts        all domain interfaces (Portfolio + Build merged)
│   └── lib/utils.ts          cn() helper
├── api/
│   ├── prices.js             price history endpoint (copy from packages/backtest/api/)
│   └── search.js             ticker search endpoint (copy from packages/backtest/api/)
├── vercel.json               Vercel config
└── docs/PRD.md               this file
```

---

## 12. Information Architecture

### Portfolio Mode
```
App (Portfolio mode — cyan blue accent)
│  [Portfolio ●  ○ Build]  ← mode toggle (top-right)
│
├── Dashboard
│   ├── Portfolio Value Chart (1Y default)
│   ├── Quick Stats (value, P&L, today's change)
│   ├── Allocation Overview (drift per holding, color-coded)
│   ├── Cash Balances (TWD, USD)
│   ├── Ammunition Pool Status
│   └── Recent Operations (last 3)
│
├── DCA Planner
│   ├── Rebalance Strategy (soft / hard)
│   ├── Allocation Method (proportional / equal-weight)
│   ├── Budget Input
│   ├── Generated Trade Plan
│   ├── Cash Sufficiency Warning (conditional)
│   └── Execution Logger + "Log All"
│
├── Operations
│   ├── Operation History (list + filters + search)
│   └── Log Operation (via "+" FAB)
│       ├── Trade (BUY/SELL/REBALANCE/etc.)
│       ├── Cash Deposit/Withdrawal
│       └── FX Exchange
│
├── Performance
│   ├── Portfolio Value + P&L Chart
│   ├── Key Metrics (Unrealized P&L, Realized P&L, Total P&L)
│   ├── MoM Growth (current + 12-month bar)
│   ├── Per-holding Breakdown
│   └── Benchmark Comparison
│
└── Settings
    ├── Portfolio Config
    │   ├── Holdings & Target Allocations
    │   ├── Sleeves
    │   ├── Drift Thresholds
    │   ├── Ammunition Pool Rules
    │   └── Benchmark Selection
    ├── Cash & FX
    │   ├── Cash Accounts
    │   ├── FX Transaction History (FIFO lot queue)
    │   └── Current FX Rate
    ├── DCA Settings (defaults)
    ├── IBKR Import
    ├── Fork to Build
    └── App Settings (JSON export/import, theme)
```

### Build Mode
```
App (Build mode — light orange accent)
│  [○ Portfolio  ● Build]  ← mode toggle (top-right)
│
├── Dashboard
│   ├── Favorite Chart (Build / Benchmark / Compare)
│   ├── Growth Metrics (YoY, MoM, Overall)
│   └── "Open in Builds →"
│
├── Builds
│   ├── Card List (Builds, Benchmarks, Compares)
│   │   ├── Build Card → Build Detail + Edit + Re-run
│   │   ├── Benchmark Card → Benchmark Detail
│   │   └── Compare Card → Compare View
│   └── Menu: Add Build / Add Benchmark / Compare
│
├── Compare
│   ├── Select Items (2–4 Builds/Benchmarks)
│   ├── Overlay Chart (absolute $ / growth % toggle)
│   └── Metrics Table
│
└── Settings
    ├── Import / Export JSON
    ├── Display Currency (USD / TWD)
    ├── Price Cache Management
    └── Theme
```

---

## 13. Non-functional Requirements

- **Offline-first**: app works fully offline. All data in IndexedDB. Cached prices allow offline backtest re-runs.
- **Performance**: Dashboard loads < 1s on 4G. Backtest for 10 holdings × 10 years completes < 3s.
- **Responsive**: usable on 375px (iPhone SE) through 1920px desktop. Mobile-first design.
- **Price freshness**: cached for 24 hours. "Last updated" timestamp shown. Manual refresh available.
- **Accessibility**: WCAG 2.1 AA minimum. Charts have tabular fallbacks.
- **Data portability**: full JSON export/import covering all Dexie tables at any time.
- **Error resilience**: if Yahoo Finance is unreachable, show clear error with retry. Never lose user's configuration.

---

## 14. Hard Constraints

1. **No user-facing backend.** All user data in IndexedDB on device. The Python `api/` functions are price-data proxies only — they do not store, receive, or transmit user portfolio data.
2. **Price feeds via Yahoo Finance only.** Use `api/prices.py` + `api/search.py`. No other market data APIs.
3. **No live broker integration.** IBKR CSV import (offline, file-based) is in scope. No IBKR API.
4. **Single portfolio only.** MVP does not support multiple `FolioLive` instances.
5. **Operations are immutable.** After creation, core data cannot be edited. Notes can be added.
6. **Rationale is required** on every Operation. Not optional — deliberate design choice.
7. **FIFO is sacred for FX lots.** Do not use LIFO, average cost, or any other method for FX cost basis.
8. **Portfolio target allocations must sum to 100%.** Validate at both holding and sleeve level in real time.
9. **Data portability.** Full JSON export/import must include all entity types: holdings, cash accounts, FX lots, operations, snapshots, builds, benchmarks, compares, price cache, entity links.

---

## 15. Out of Scope (MVP)

**Do NOT implement these.** Refer to this section if asked.

- TWR (Time-Weighted Return) and MWR (Money-Weighted Return) — deferred post-MVP
- Multi-portfolio support
- Cross-device sync or cloud backup
- Tax lot tracking or tax reporting (FX FIFO lots for cost basis are in scope; tax reports are not)
- Options, derivatives, or leveraged product tracking
- AI-powered trade suggestions
- Social sharing or public Build links
- Sharpe ratio, Sortino ratio, or other advanced risk metrics
- Native mobile app (iOS/Android) — PWA only
- Real-time price streaming (polling on refresh/open only)
- Automatic portfolio-to-build sync (EntityLink is informational only)
- News feed or market commentary

---

## 16. Implementation Phases

### Existing Codebase Snapshot

Two fully-working apps to merge. Key facts that govern the remaining phases:

| Location | State | Notes |
|----------|-------|-------|
| `src/` (main Folio app) | Phases 1–6 complete | 87 files, ~6,300 LOC |
| `packages/backtest/` | Feature-complete | 42 files, ~5,100 LOC — all Build mode features done |
| `packages/backtest/api/prices.js` + `search.js` | Done | JS/Node.js serverless, Yahoo Finance v8 |
| `packages/backtest/src/api/yahooFinance.ts` | Done | Price cache client (24h TTL, offline fallback) |
| `packages/backtest/src/engine/backtest.ts` | Done | 619 LOC, full DCA simulation engine |
| `packages/backtest/src/engine/compare.ts` | Done | 116 LOC, multi-item alignment + runner |
| `src/types/index.ts` | Has `Sleeve`, `sleeveId` on `Holding` | Sleeves kept as-is |
| `src/db/database.ts` | Dexie v2, 9 tables | Each remaining phase may increment version |
| `vite-plugin-pwa` | Installed | PWA partially configured already |
| `src/services/notifications.ts` | Stub | Phase 13 implements |
| Deployment | gh-pages (not Vercel) | Phase 13 migrates to Vercel for JS API functions |
| **Naming note** | `Portfolio` in code = `FolioLive` in PRD | No rename needed — conceptual mapping only |
| **TWR/MWR note** | Fully implemented in `performance.ts` | Code stays; hide metric cards from MVP UI |

---

### Phase 1–6 Status (Portfolio mode)

| Phase | Status | What was built |
|-------|--------|----------------|
| 1. Foundation | ✅ Done | Vite + React + TS scaffold, Dexie v1 schema (9 tables), SetupWizard (6-step wizard), holdings + sleeves CRUD |
| 2. Cash & FX Engine | ✅ Done | CashAccount, FxTransaction, FxLot, FIFO consumption engine (`fifo.ts`), `cashFxService.ts`, 4-tier FX rate resolution |
| 3. Core Operations | ✅ Done | OperationLogger (8 types, 42.7 KB), OperationHistory (filters + search), Dashboard |
| 4. DCA Planner | ✅ Done | `rebalance.ts` (31.5 KB, fully tested), soft/hard + proportional/equal-weight, cash sufficiency, "Log All" |
| 5. Intelligence | ✅ Done | DriftMonitor (3-severity, sleeve-level aggregation), AmmunitionPool 2-tier status, weekly auto-snapshot |
| 6. Performance | ✅ Done | TWR + MWR (`performance.ts`, 35.7 KB, tested), realized/unrealized P&L, sleeve attribution, benchmark comparison |

---

### Phase 7 — App Shell & Mode Toggle
**Effort**: Small (~2 days) | **Risk**: Low

**New files**:
- `src/stores/modeStore.ts` — `mode: 'portfolio' | 'build'`, persisted via Zustand `persist`
- `src/components/ModeToggle.tsx` — toggle switch rendered in app header

**Modified files**:
- `src/App.tsx` — add top header bar with `ModeToggle`; `mode === 'build'` renders Build shell (stub for now), `mode === 'portfolio'` unchanged
- `src/components/BottomNav.tsx` — accept `mode` prop; define `PORTFOLIO_TABS` and `BUILD_TABS` arrays; render correct set
- `src/stores/uiStore.ts` — add Build tab IDs to `TabId` union
- `src/index.css` — add `--color-accent` CSS custom property; swap value under `[data-mode="build"]` on `<html>`

---

### Phase 8 — Live Price Integration
**Effort**: Medium (~3–4 days) | **Risk**: Low (the implementation already exists in `packages/backtest`)

**Copy/move from `packages/backtest`**:
- `packages/backtest/api/prices.js` → `api/prices.js` (root level for Vercel)
- `packages/backtest/api/search.js` → `api/search.js`
- `packages/backtest/src/api/yahooFinance.ts` → `src/services/yahooFinance.ts` (shared price cache service)

**Modified files**:
- `src/db/database.ts` — **Dexie v3**: add `priceCaches: 'ticker, fetchedAt'` table (same schema as `packages/backtest/src/db/index.ts`)
- `src/types/index.ts` — add `PriceCache`, `TickerSearchResult` interfaces (copy from `packages/backtest/src/types/index.ts`)
- `src/features/dashboard/Dashboard.tsx` — call `yahooFinance.refreshAll(holdings)` on mount + pull-to-refresh; show "Prices last updated HH:MM" footer; replace manual-only `PriceUpdateDialog` with "Refresh from Yahoo" button
- `src/features/operations/OperationLogger.tsx` — auto-fill `pricePerShare` from latest cached price when user selects a holding; user can override
- `src/features/settings/PortfolioSettings.tsx` — use `yahooFinance.search()` for ticker autocomplete when adding holdings

**Note**: `OperationEntry.pricePerShare` always stores the user's confirmed execution price, not the live price.

---

### Phase 10 — Build Mode Integration (Port from `packages/backtest`)
**Effort**: Medium (~4–5 days) | **Risk**: Low (all logic is done — this is porting + wiring, not new code)

**What already exists** in `packages/backtest/src/`:
- `engine/backtest.ts` (619 LOC) — full DCA simulation, soft/hard rebalance, 3 trigger types, multi-currency
- `engine/compare.ts` (116 LOC) — multi-item alignment and runner
- `features/builds/` — BuildCreator (860 LOC), BuildDetail (489 LOC), BuildCard (79 LOC), builds index (305 LOC)
- `features/benchmarks/` — BenchmarkCreator (334 LOC), BenchmarkDetail (396 LOC), BenchmarkCard (67 LOC)
- `db/index.ts` + `db/hooks.ts` — Dexie schema for builds, benchmarks, compares, priceCache

**Work to do**:
- Copy `packages/backtest/src/engine/backtest.ts` → `src/engine/backtest.ts`
- Copy `packages/backtest/src/engine/compare.ts` → `src/engine/compare.ts`
- Copy `packages/backtest/src/features/{builds,benchmarks}/` → `src/features/build/{builds,benchmarks}/`; update import paths
- Create `src/stores/buildStore.ts` (adapt from `packages/backtest/src/stores/`)
- **Dexie v4**: merge Build tables (`builds`, `benchmarks`) into main `src/db/database.ts`
- Wire Build features into the mode shell added in Phase 7
- Resolve any type naming conflicts between the two `types/index.ts` files

---

### Phase 11 — Build Compare + Dashboard (Port from `packages/backtest`)
**Effort**: Small-Medium (~2–3 days) | **Risk**: Low

**What already exists** in `packages/backtest/src/features/`:
- `compares/` — CompareCreator (402 LOC), CompareDetail (406 LOC), CompareCard (71 LOC)
- `dashboard/index.tsx` (531 LOC) — Favorite visualization with YoY/MoM/Overall metrics
- `settings/index.tsx` (146 LOC) — cache management, display currency, theme

**Work to do**:
- Copy `packages/backtest/src/features/{compares,dashboard,settings}/` → `src/features/build/{compares,dashboard,settings}/`; update import paths
- **Dexie v4** (combined with Phase 10): add `compares` table
- Wire into Build mode shell

---

### Phase 12 — Promote/Fork Workflows
**Effort**: Medium (~4–5 days) | **Risk**: Low (new functionality, well-defined data flow)

**New files** (no equivalent in either existing app):
- `src/features/build/PromoteToPortfolio.tsx` — dialog: shows what transfers vs what doesn't, currency selector, confirmation. Creates new `Portfolio` record from `BuildStrategy` fields.
- `src/features/settings/ForkToBuild.tsx` — source selector (Target Allocation vs Historical Snapshot date picker), optional DCA/rebalance rule inclusion, build name input. Creates new `BuildStrategy` from Portfolio.
- `src/db/entityLinkService.ts` — EntityLink CRUD

**Modified files**:
- `src/features/build/builds/BuildDetail.tsx` — add "Promote to Portfolio" action button + lineage badge
- `src/features/settings/` — add "Fork to Build" entry in settings panel + lineage display

**Dexie v5**: add `entityLinks: 'id, sourceBuildId, sourceFolioId, targetBuildId, targetFolioId'`

---

### Phase 13 — Polish & Deploy
**Effort**: Medium (~4–5 days) | **Risk**: Low

**Already partially done**:
- `vite-plugin-pwa` installed + basic config — needs offline testing and install prompt verification
- `uiStore.ts` has `theme`, `toggleTheme()`, `applyTheme()` — infrastructure complete; `packages/backtest` has full dark mode CSS vars to reference
- `src/features/settings/DataManager.tsx` exists as partial stub

**Remaining work**:
- **PWA**: verify offline mode; test install prompt on iOS Safari + Android Chrome
- **Dark mode audit**: many Portfolio mode components may lack `dark:` Tailwind variants — audit and add
- **JSON export/import** (`DataManager.tsx`): expand to cover all new tables from Phases 10–12 (`builds`, `benchmarks`, `compares`, `entityLinks`, `priceCaches`)
- **Notifications** (`src/services/notifications.ts` stub): implement drift alert push notifications
- **Deploy to Vercel**: migrate from gh-pages — update `package.json` deploy scripts, add `vercel.json`, verify `api/prices.js` and `api/search.js` deploy alongside React frontend
- **Responsive refinement**: audit new Build mode components at 375px

---

## 17. Resolved Decisions

1. **DCA allocation method**: user-selectable per session (proportional-to-drift default). Stored as portfolio default.
2. **FX rate source**: Yahoo Finance `USDTWD=X` as primary; most recent user-logged FX transaction rate as fallback; manual override available.
3. **Snapshot frequency**: on every operation + daily auto-snapshot if app is opened.
4. **Dashboard currency**: TWD/USD toggle. Default: base currency (TWD).
5. **Fractional shares**: DCA Planner and rebalance suggestions support fractional shares. IBKR supports fractional ETFs.
6. **FX lot fee tracking**: fees stored as separate field on `FxTransaction`, not baked into effective rate.
7. **Compare alignment**: all items use DCA params from the first Build in the Compare. If no Build, use first Benchmark with monthly $1,000 USD as default.
8. **Benchmark standalone preview**: monthly $1,000 USD from earliest available data.
9. **Build mode realized P&L**: not tracked (simulation — all gains are unrealized until the hypothetical end date).
10. **Sleeves**: kept as-is from the existing Portfolio mode implementation. Sleeves group holdings and carry their own target allocation %. Both holding-level and sleeve-level allocations must sum to 100%. Sleeve removal is deferred — risk vs benefit not justified for current scope.
11. **TWR/MWR**: removed from MVP. Performance tab shows absolute P&L and benchmark comparison only.
12. **Live price in operations**: prices auto-filled from Yahoo Finance when opening the log form. User can override with actual execution price. The stored `pricePerShare` is always the actual execution price, not the live price at time of logging.
