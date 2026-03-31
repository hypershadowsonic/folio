# Folio Build — DCA Portfolio Backtester

## 1. Overview

Folio Build is a DCA (Dollar-Cost Averaging) portfolio construction and backtesting tool. It answers the question every systematic investor asks before committing real money: **"If I had been doing this for the past X years, how would it have performed?"**

Users build hypothetical portfolios, set DCA parameters and rebalancing rules, and run backtests against real historical price data (Yahoo Finance). Multiple portfolios and benchmarks can be compared side by side.

Folio Build is the simulation counterpart to Folio (the live tracking app). Folio Build helps you decide **what** to invest in. Folio helps you **execute and track** it.

**Reference product**: Portfolio Visualizer's backtest tools — but opinionated toward DCA investors rather than lump-sum, and with a clean mobile-friendly UI instead of a dense desktop spreadsheet.

---

## 2. User Persona

**Primary: Evan, 32, Media Designer / Systematic Investor**

Same persona as Folio. Relevant context for this app:
- Manages a 10-holding ETF framework and periodically reconsiders the allocation
- Wants to test "what if I add IBIT at 5% and reduce GLDM to 5%?" before committing real money
- Wants to compare his current portfolio construct against simpler alternatives (e.g., 100% VOO)
- Uses DCA with monthly contributions — needs backtests that model DCA, not lump-sum
- Wants to evaluate whether his rebalancing discipline (soft/hard) actually adds value over time

---

## 3. Core Concepts

### 3.1 Build

A Build is a hypothetical portfolio configuration with DCA and rebalancing parameters. It is the central entity.

A Build contains:
- **Name**: user-defined (e.g., "10-ETF Core", "Simple 3-Fund", "All-Weather")
- **Holdings**: list of tickers with target allocation % (must sum to 100%)
- **DCA Settings**:
  - Amount per period (e.g., $1,000)
  - Currency: USD or TWD
  - Frequency: weekly, biweekly, monthly
  - Start date: the first DCA contribution date
  - End date: defaults to today, configurable
- **Rebalance Settings**:
  - Strategy: `soft` (buy-only) | `hard` (sell + buy) — same algorithms as Folio
  - Trigger: one or more of:
    - `on-dca`: check and rebalance on every DCA contribution
    - `periodic`: on a schedule (monthly, quarterly, annually)
    - `threshold`: when any holding's drift exceeds ±X%
  - Threshold value (if trigger includes threshold): default ±5%

### 3.2 Benchmark

A Benchmark is a single-ticker reference used for comparison.

- **Ticker**: e.g., VOO, 0050, QQQ
- **Name**: user-defined or defaults to ticker
- No DCA settings of its own — when compared against a Build, the Benchmark adopts the Build's DCA amount, frequency, and date range. All money goes into the single ticker.
- On the Builds tab card, standalone display uses monthly DCA frequency as default for the preview chart.

### 3.3 Compare

A Compare is a saved comparison set of up to 4 items (Builds and/or Benchmarks).

- **Name**: user-defined (e.g., "Core vs Simple vs VOO")
- **Items**: 2–4 references to Builds or Benchmarks
- **Alignment rules**: all items use the same DCA amount, frequency, and date range — inherited from the first Build in the list. If only Benchmarks, uses the first Benchmark with monthly frequency.
- **Chart modes**: absolute value ($) or growth rate (%), toggleable

### 3.4 Favorite

One item from the Builds tab (a Build, a Benchmark, or a Compare) can be pinned as the Favorite. The Favorite's chart and metrics are displayed on the Dashboard for quick access.

---

## 4. User Flows

### Flow 1: Create and Run a Build

```
Builds tab → Menu → "Add Build" →
  Step 1: Name the build
  Step 2: Add holdings (ticker search via Yahoo Finance → autocomplete)
    - Enter target allocation % per holding
    - Validation: must sum to 100%
  Step 3: DCA settings
    - Amount + currency
    - Frequency (weekly / biweekly / monthly)
    - Start date (calendar picker, max = today)
  Step 4: Rebalance settings
    - Strategy: soft / hard
    - Trigger: checkboxes for on-dca / periodic / threshold
    - If periodic: frequency selector (monthly / quarterly / annually)
    - If threshold: % input (default ±5%)
  → "Run Backtest" →
  App fetches historical prices from Yahoo Finance →
  Simulates DCA + rebalancing for each period →
  Displays result card with chart + metrics →
  Saved to Builds list
```

### Flow 2: Create a Benchmark

```
Builds tab → Menu → "Add Benchmark" →
  Enter ticker (search via Yahoo Finance) →
  → Benchmark created, preview chart shown using monthly DCA
  → Saved to Builds list
```

### Flow 3: Compare

```
Builds tab → Menu → "Compare" →
  Select 2–4 items from existing Builds and Benchmarks →
  Name the comparison →
  App aligns all items to the same DCA parameters (from first Build) →
  App runs/reruns backtests for each item →
  Displays overlay chart with all lines + comparison metrics table →
  Toggle: absolute value ($) ↔ growth rate (%) →
  Saved to Builds list as a Compare card
```

### Flow 4: Dashboard Quick View

```
Open app → Dashboard shows Favorite item:
  - If a Build: chart + YoY/MoM/Overall growth
  - If a Benchmark: chart + YoY/MoM/Overall growth
  - If a Compare: overlay chart + comparison table
  - If no Favorite set: prompt to set one
```

---

## 5. Feature Spec

### F1: Build Creator

**Description**: Create and configure a DCA portfolio for backtesting.

**Acceptance Criteria**:
- Ticker search with Yahoo Finance API autocomplete (debounced, shows ticker + company name + exchange)
- Holdings table: ticker, name, allocation %, remove button
- Allocation must sum to 100% (real-time validation with remaining % display)
- DCA amount: number input + currency selector (USD / TWD)
- DCA frequency: radio group (weekly / biweekly / monthly)
- Start date: date picker, cannot be future, earliest = oldest available data from Yahoo Finance for all holdings
- Rebalance strategy: radio group (soft / hard)
- Rebalance trigger: checkbox group (on-dca / periodic / threshold) — at least one must be selected
- Periodic frequency: dropdown (monthly / quarterly / annually) — only shown if periodic trigger selected
- Threshold: number input with ±% label — only shown if threshold trigger selected
- "Run Backtest" button → executes simulation → navigates to result view
- Build is editable after creation — changing parameters shows "Re-run Backtest" button

**UI Behavior**: Full-screen form, wizard-style or single scrollable page. On mobile, step-by-step; on desktop, single page.

---

### F2: Backtest Engine

**Description**: Simulate DCA investing with rebalancing over historical data.

**Acceptance Criteria**:
- Fetches adjusted close prices from Yahoo Finance for all holdings from start date to end date
- On each DCA date:
  a. Add DCA amount to available cash
  b. Check rebalance trigger conditions:
     - `on-dca`: always trigger
     - `periodic`: trigger if this date matches the periodic schedule
     - `threshold`: trigger if any holding's drift exceeds threshold
  c. If rebalance triggered:
     - `soft`: allocate DCA cash to underweight holdings proportionally (no selling)
     - `hard`: sell overweight, buy underweight, plus allocate new DCA cash
  d. If no rebalance: allocate DCA cash to all holdings proportionally to target %
  e. Record: date, portfolio value, cost basis, per-holding shares and values
- If a DCA date falls on a non-trading day, use the next available trading day's close price
- Handle stock splits and dividends via Yahoo Finance adjusted close (this is automatic with adjusted close data)
- For TWD-denominated holdings in a USD-denominated build (or vice versa): fetch USD/TWD exchange rate history from Yahoo Finance (ticker: USDTWD=X) and convert at each DCA date

**Output**: time series of { date, portfolioValue, costBasis, unrealizedPnL, totalReturnPct, holdings[] }

---

### F3: Benchmark Runner

**Description**: Run a single-ticker DCA simulation for comparison.

**Acceptance Criteria**:
- When displayed standalone on Builds tab: uses monthly frequency, $1,000 USD, from earliest available date
- When used in a Compare: adopts the first Build's DCA amount, frequency, and date range
- Same engine as F2 but with a single holding at 100% allocation and no rebalancing
- Output format identical to F2 for easy comparison

---

### F4: Compare View

**Description**: Side-by-side comparison of up to 4 Builds/Benchmarks.

**Acceptance Criteria**:
- Select 2–4 items from existing Builds and Benchmarks
- All items aligned to same DCA parameters (from first Build in list; if no Build, use first Benchmark with monthly frequency)
- Chart: overlay line chart with one line per item, color-coded
  - Y axis toggle: absolute value ($) ↔ growth rate (%)
  - Growth rate: normalized to 0% at start date, each point = (currentValue / totalInvested - 1) × 100
  - X axis: dates
  - Tooltip: date, each item's value/growth, and rank
  - Legend: item names with color indicators
- Comparison metrics table below chart:
  | Metric | Build A | Build B | Benchmark |
  | Total Return % | +45.2% | +38.1% | +41.5% |
  | Annualized Return % | +12.3% | +10.5% | +11.2% |
  | Total Value | $145,200 | $138,100 | $141,500 |
  | Total Invested | $100,000 | $100,000 | $100,000 |
  | Max Drawdown % | -18.3% | -22.1% | -33.9% |
  | Best Month % | +8.2% | +6.5% | +12.3% |
  | Worst Month % | -12.1% | -9.8% | -16.5% |
  - Highlight the best value in each row (green/bold)
- Display currency: user-selectable (USD / TWD), applies to all items in the comparison

---

### F5: Dashboard

**Description**: Quick access to the user's Favorite Build, Benchmark, or Compare.

**Acceptance Criteria**:
- Hero card: the Favorite item's chart
  - If Build or Benchmark: single line chart showing portfolio value over time
  - If Compare: overlay chart with all items
  - Date range: full history from start date to today
- Metrics cards below chart:
  - YoY (Year-over-Year) growth: (current value / value 1 year ago - 1) × 100%
  - MoM (Month-over-Month) growth: (current value / value 1 month ago - 1) × 100%
  - Overall growth: (current value / total invested - 1) × 100%
  - Total value and total invested (in selected currency)
- If no Favorite is set: show placeholder card with "Pin a Build or Compare as your Favorite from the Builds tab"
- "Open in Builds →" link to navigate to the Favorite item's detail view
- Currency toggle: USD / TWD

**UI Behavior**: Home tab. Minimal, focused on the one thing the user cares about most.

---

### F6: Builds Tab

**Description**: Card-based list of all Builds, Benchmarks, and Compares.

**Acceptance Criteria**:
- Three types of cards, visually distinct:
  - **Build card**: mini chart (sparkline), name, total return %, annualized return %, allocation summary (e.g., "5 holdings"), star icon for Favorite
  - **Benchmark card**: mini chart, ticker prominently displayed, total return %, star icon
  - **Compare card**: mini overlay chart (tiny version of the compare chart), name, number of items, star icon
- Cards are sorted: Favorite first (pinned), then by creation date descending
- Star icon: tap to set/unset as Favorite (only one item can be Favorite at a time)
- Tap a card to open its detail view:
  - Build: full chart + all metrics + "Edit" button + "Re-run" button
  - Benchmark: full chart + metrics
  - Compare: full compare view (F4)
- Long-press or swipe to reveal: "Duplicate", "Delete"
- Menu button (FAB or top-right): "Add Build", "Add Benchmark", "Compare"

**UI Behavior**: Scrollable card list. On desktop: 2-column grid. On mobile: single column.

---

### F7: Settings

**Description**: App settings, data management, and Folio integration stub.

**Acceptance Criteria**:
- **Import**: import Builds/Benchmarks/Compares from a JSON file (for sharing between devices or with friends)
- **Export for Backup**: export all data as JSON
- **Export to Folio**: (post-MVP stub) button that shows "Coming soon — will export your Build as a Folio portfolio with sleeves and target allocations"
- **Display Currency**: default currency for new Builds and displays (USD / TWD)
- **Theme**: light / dark
- **Cache Management**: Yahoo Finance price data is cached in IndexedDB. Show cache size and "Clear Cache" button.

---

## 6. Information Architecture

```
App (Bottom Tab Navigation)
├── Dashboard (home tab)
│   ├── Favorite Chart (Build / Benchmark / Compare)
│   ├── Growth Metrics (YoY, MoM, Overall)
│   └── "Open in Builds →" link
│
├── Builds (tab)
│   ├── Card List (Builds, Benchmarks, Compares)
│   │   ├── Build Card → Build Detail (chart + metrics + edit)
│   │   ├── Benchmark Card → Benchmark Detail (chart + metrics)
│   │   └── Compare Card → Compare View (overlay chart + table)
│   └── Menu: Add Build / Add Benchmark / Compare
│
└── Settings (tab)
    ├── Import / Export / Export to Folio
    ├── Display Currency
    ├── Theme
    └── Cache Management
```

---

## 7. Tech Stack

### Frontend
- **Framework**: React + TypeScript
- **UI Library**: Tailwind CSS + shadcn/ui (same design language as Folio)
- **State Management**: Zustand
- **Charts**: Recharts
- **Build**: Vite

### Data Layer
- **Local storage**: IndexedDB via Dexie.js — Builds, Benchmarks, Compares, cached price data
- **Price data**: Yahoo Finance API (unofficial endpoints or yfinance-compatible proxy)
- **Price cache**: fetched prices cached in IndexedDB by ticker + date range. Re-fetch only for new dates.

### Yahoo Finance Integration
- **Backend**: Python serverless functions in `api/` directory using `yfinance` library
- **Endpoints**:
  - `GET /api/prices?ticker=VOO&start=2020-01-01&end=2026-03-23` → returns daily adjusted close prices
  - `GET /api/search?q=voo` → returns matching tickers with name and exchange
- **How it works**: Vercel automatically detects `.py` files in the `api/` folder and deploys them as serverless functions. No separate server needed — push to GitHub, Vercel deploys frontend + API together.
- **Why yfinance over raw API**: handles ticker format differences (台股 = `0050.TW`), exchange rates (`USDTWD=X`), splits, dividends, and Yahoo API changes. The yfinance community maintains compatibility.
- **CORS**: handled by adding `Access-Control-Allow-Origin` headers in the Python function response
- **Dependencies**: `requirements.txt` at project root with `yfinance` — Vercel installs automatically on deploy
- **Exchange rate**: fetch `USDTWD=X` via same yfinance endpoint for TWD conversion
- **Rate limiting**: debounce ticker search (300ms), cache prices in IndexedDB by ticker + date range, re-fetch only for dates not yet cached
- **Local development**: use `vercel dev` to run both frontend and Python functions locally. Install the Vercel CLI: `npm i -g vercel`.

### Project Structure (API portion)
```
folio-build/
├── src/                    ← React frontend
├── api/
│   ├── prices.py           ← price history endpoint
│   └── search.py           ← ticker search endpoint
├── requirements.txt        ← yfinance
├── vercel.json             ← routes config (optional)
├── package.json
└── ...
```

### Deployment
- **Web**: Vercel (same as Folio). Push to GitHub → Vercel auto-deploys frontend + Python API.
- **Mobile**: PWA
- No separate server, no Docker, no infrastructure to maintain.

---

## 8. Data Model

```typescript
// --- Build ---

interface Build {
  id: string;
  name: string;
  holdings: BuildHolding[];
  dcaAmount: number;
  dcaCurrency: 'USD' | 'TWD';
  dcaFrequency: 'weekly' | 'biweekly' | 'monthly';
  startDate: Date;
  endDate: Date;                    // default: today
  rebalanceStrategy: 'soft' | 'hard';
  rebalanceTriggers: RebalanceTrigger[];
  thresholdPct?: number;            // for 'threshold' trigger, default 5
  periodicFrequency?: 'monthly' | 'quarterly' | 'annually';  // for 'periodic' trigger
  isFavorite: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastBacktestResult?: BacktestResult;
}

type RebalanceTrigger = 'on-dca' | 'periodic' | 'threshold';

interface BuildHolding {
  ticker: string;
  name: string;
  currency: 'USD' | 'TWD';
  targetAllocationPct: number;      // 0-100, must sum to 100
}

// --- Benchmark ---

interface Benchmark {
  id: string;
  ticker: string;
  name: string;
  currency: 'USD' | 'TWD';
  isFavorite: boolean;
  createdAt: Date;
  lastBacktestResult?: BacktestResult;  // using default monthly DCA
}

// --- Compare ---

interface Compare {
  id: string;
  name: string;
  items: CompareItem[];             // 2-4 items
  isFavorite: boolean;
  createdAt: Date;
  lastCompareResult?: CompareResult;
}

interface CompareItem {
  type: 'build' | 'benchmark';
  refId: string;                    // Build.id or Benchmark.id
}

// --- Backtest Results ---

interface BacktestResult {
  buildId: string;
  runAt: Date;
  params: {                         // snapshot of params at run time
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
  portfolioValue: number;           // in build's dcaCurrency
  costBasis: number;                // total invested so far
  unrealizedPnL: number;
  totalReturnPct: number;           // (portfolioValue / costBasis - 1) × 100
  holdings: {
    ticker: string;
    shares: number;
    value: number;
    allocationPct: number;
    driftFromTarget: number;
  }[];
  rebalanceTriggered: boolean;      // did a rebalance happen on this date
  rebalanceType?: 'soft' | 'hard';
}

interface BacktestSummary {
  totalReturn: number;              // absolute: endValue - totalInvested
  totalReturnPct: number;
  annualizedReturnPct: number;
  totalInvested: number;
  endValue: number;
  maxDrawdownPct: number;
  bestMonthPct: number;
  worstMonthPct: number;
  totalRebalances: number;
  yoyGrowthPct: number | null;      // null if < 1 year of data
  momGrowthPct: number | null;      // null if < 1 month of data
}

interface CompareResult {
  compareId: string;
  runAt: Date;
  alignedParams: {                  // the shared DCA params used
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

// --- Price Cache ---

interface PriceCache {
  ticker: string;
  startDate: Date;
  endDate: Date;
  interval: '1d';
  prices: { date: Date; adjustedClose: number }[];
  fetchedAt: Date;
}
```

---

## 9. Non-functional Requirements

- **Performance**: backtest for 10 holdings × 10 years of monthly data should complete in < 3 seconds
- **Offline**: cached price data allows re-running backtests offline. New ticker searches require network.
- **Responsive**: usable on 375px (iPhone SE) through 1920px desktop
- **Price data freshness**: cache prices for 24 hours. Show "last updated" timestamp. Manual refresh button.
- **Error handling**: if Yahoo Finance is unreachable, show clear error with retry button. Don't lose the user's Build configuration.

---

## 10. Out of Scope (MVP)

**Do NOT implement these:**
- User accounts or authentication
- Backend database (all data local in IndexedDB)
- Cross-device sync
- Real-time price streaming
- Options, futures, or leveraged product simulation
- Tax impact simulation
- Dividend reinvestment as a separate toggle (adjusted close already accounts for this)
- Export to Folio integration (stub only in Settings)
- Sharpe ratio, Sortino ratio, or other advanced risk metrics (can add post-MVP)
- Social sharing or public Build links

---

## 11. Implementation Phases

### Phase 1: Foundation + Yahoo Finance (Day 1-3)
- Project scaffold (Vite + React + TS + Tailwind + shadcn/ui + Dexie + Recharts + Zustand)
- Data model + Dexie schema
- Yahoo Finance API: `api/prices.py` and `api/search.py` using yfinance
- Yahoo Finance client (frontend): fetch prices, search tickers, IndexedDB cache layer
- `vercel dev` setup for local development
- Basic 3-tab navigation shell (Dashboard, Builds, Settings)

### Phase 2: Build Creator + Backtest Engine (Day 4-7)
- Build creation form (F1)
- Backtest engine core algorithm (F2):
  - DCA simulation loop
  - Soft/hard rebalance logic (port from Folio's rebalance engine)
  - Rebalance trigger evaluation (on-dca / periodic / threshold)
  - Multi-currency handling with FX rate fetching
- Build detail view with chart + summary metrics

### Phase 3: Benchmarks + Compare (Day 8-10)
- Benchmark creation (F3)
- Benchmark runner (adapted from backtest engine, single holding)
- Compare creation and item selection (F4)
- Compare chart: overlay lines with Y-axis toggle (absolute / growth %)
- Comparison metrics table

### Phase 4: Dashboard + Builds Tab (Day 11-12)
- Builds tab card layout (F6): Build cards, Benchmark cards, Compare cards
- Favorite system: star toggle, persist to Dexie
- Dashboard (F5): Favorite chart + YoY/MoM/Overall metrics
- Menu: Add Build / Add Benchmark / Compare

### Phase 5: Polish + Deploy (Day 13-14)
- Settings: import/export JSON, Export to Folio stub, cache management
- Currency toggle (USD/TWD) throughout
- Dark mode
- PWA setup
- Responsive layout refinement
- Deploy to Vercel (frontend + Python API functions deploy together from one push)

---

## 12. Resolved Decisions

1. **Price data source**: Yahoo Finance via `yfinance` Python library, deployed as Vercel Serverless Functions alongside the React frontend. No separate server needed — push to GitHub and Vercel deploys everything.
2. **DCA amount**: fixed amount per period in a single currency (USD or TWD). No percentage-of-income or variable amount.
3. **Compare chart Y-axis**: toggleable between absolute value ($) and growth rate (%).
4. **Rebalance triggers**: all three options available (on-dca, periodic, threshold). User selects one or more.
5. **Rebalance strategies**: soft (buy-only) and hard (sell+buy) — same algorithms as Folio.
6. **Compare limit**: maximum 4 items per Compare.
7. **Display currency**: user-selectable (USD / TWD). TWD holdings converted via USDTWD=X rate from Yahoo Finance.
8. **Benchmark standalone display**: uses monthly DCA with $1,000 USD default for the preview card. In Compare, adopts the first Build's parameters.
9. **Realized PnL**: not tracked in backtesting (it's a simulation — all gains are unrealized until the hypothetical end date).
