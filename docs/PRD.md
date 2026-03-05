# Folio — Investment Portfolio Operations & Performance Tracker

## 1. Overview

Folio is a cross-platform (web + mobile PWA) investment portfolio tracker designed for systematic, rules-based investors who manage multi-market ETF portfolios with DCA, tactical rebalancing, and drawdown deployment strategies.

Unlike generic portfolio trackers (Yahoo Finance, Google Finance) that focus on price watching, or brokerage apps that are transaction-centric, Folio is **operations-centric** — it tracks *what you did, why you did it, and how it performed against your strategy*, not just what your holdings are worth.

**Core thesis**: The gap in existing tools is between "trade log" and "performance dashboard." Systematic investors need a tool that understands their allocation model and evaluates every operation against it.

**Reference product**: YNAB — not for budgeting logic, but for its opinionated methodology baked into UX, cross-platform PWA approach, and the philosophy that the tool enforces a discipline rather than being a neutral spreadsheet.

---

## 2. User Persona

**Primary: Evan, 32, Media Designer / Systematic Investor**

- Manages a 10-holding ETF framework across US and Taiwan markets via IBKR
- Uses DCA with monthly contributions, tactical sleeve rotation, and a two-tier cash reserve (ammunition pool) for drawdown deployment
- Currently tracks everything in Google Sheets + IBKR Flex Query — functional but fragmented
- Wants a single interface to log operations, see allocation drift, and review performance — accessible from phone during market hours and desktop for analysis
- Pain points:
  - Google Sheets doesn't alert when allocation drifts past threshold
  - No unified view of "what should I do this month" based on current allocation vs target
  - Performance attribution is manual (did the tactical sleeve rotation actually help?)
  - Can't quickly review operation history with context (why did I make this trade?)

---

## 3. Core Concepts (Domain Model)

These are the foundational abstractions. Claude Code should implement these as the data model layer first.

### 3.1 Portfolio Model

A Portfolio contains:
- **Holdings**: ticker, target allocation %, current shares, cost basis
- **Sleeves**: named groups of holdings with a collective target allocation
  - Example: "Core" sleeve (VOO + VEA + 0050 = 50%), "Thematic" sleeve (VHT + SMH + ITA = 20%), "Tactical" sleeve (POWR ↔ VGLT = 10%), "Alternatives" (GLDM + IBIT = 10%), "Cash" (SGOV = 10%)
- **Allocation Targets**: per-holding and per-sleeve target %
- **Drift Thresholds**: per-holding tolerance band (e.g., ±2%) that triggers rebalance signals

### 3.2 Cash Account

Cash is a first-class entity, not just a side effect of operations:
- **Cash Balances**: per-currency (TWD, USD), updated by deposits, withdrawals, FX conversions, and trade settlements
- **Deposits/Withdrawals**: explicit records of money moving into/out of the brokerage
- **Sufficiency Check**: before any trade plan is generated, verify cash is available in the required currency

### 3.3 FX Transaction & FIFO Cost Basis

Foreign exchange conversions are tracked as discrete transactions:
- **FX Transaction**: date, from-currency, to-currency, rate, amount, fees
- **FIFO Queue**: each FX conversion creates a "lot" of foreign currency. When that currency is spent (buying ETFs), the cost basis is calculated using the oldest unconsumed lot first.
- **Example**: User converts TWD→USD three times at rates 31.5, 32.0, 31.8. When buying VOO for $500, the first $500 of USD is costed at 31.5 TWD/USD (or a blend if the first lot is smaller than $500).
- **Current Value FX Rate**: the most recent FX transaction rate is used to convert foreign-currency holdings back to the base currency (TWD) for portfolio valuation display.

### 3.4 Operation

An Operation is any portfolio action. Every operation has:
- **Type**: `BUY` | `SELL` | `REBALANCE` | `DCA` | `TACTICAL_ROTATION` | `DRAWDOWN_DEPLOY` | `DIVIDEND_REINVEST` | `FX_EXCHANGE` | `CASH_DEPOSIT` | `CASH_WITHDRAWAL`
- **Timestamp**
- **Holdings involved** (ticker, shares, price, fees)
- **Rationale** (free text — why you did this)
- **Tag** (optional: `monthly-dca`, `rebalance-q1`, `drawdown-2025`, etc.)
- **Strategy context** (auto-linked: which sleeve, what was the drift before/after)

### 3.5 Ammunition Pool

Two-tier cash reserve system:
- **Tier 1 (Ready)**: Immediately deployable cash (e.g., SGOV holdings earmarked for next drawdown tranche)
- **Tier 2 (Reserve)**: Longer-term reserves, deployed only in deeper drawdowns
- **Deployment rules**: configurable triggers (e.g., "deploy Tier 1 at -10% from ATH, Tier 2 at -20%")

### 3.6 Performance Snapshot

Point-in-time capture of portfolio state:
- Total value, cost basis, unrealized P&L
- Per-holding and per-sleeve performance
- Allocation drift from targets
- TWR (Time-Weighted Return) and MWR (Money-Weighted Return)

---

## 4. User Stories & Flows (MVP)

### Flow 1a: Dashboard (Home Tab)

```
Open app → Dashboard shows:
  1. Portfolio total value line chart (default: 1 year)
  2. Quick stats bar: total value, unrealized P&L %, today's change
  3. Allocation donut/bar (current vs target, color-coded by drift)
  4. Ammunition pool status (Tier 1 / Tier 2)
  5. Cash balances by currency (TWD, USD)
  6. Last 3 operations (compact list)
```

**User Stories:**
- As a user, I want to see my portfolio's trajectory over the past year the moment I open the app
- As a user, I want to glance at allocation health without navigating away from home
- As a user, I want to see how much cash I have available in each currency

### Flow 1b: DCA Planner (Separate Tab)

```
Navigate to DCA Planner tab →
  1. Select rebalance strategy:
     ┌─────────────────────────────────────────────────────────┐
     │  ○ Soft Rebalance (buy-only)                           │
     │    Don't sell anything. Over-allocate to underweight    │
     │    holdings, under-allocate to overweight holdings.     │
     │                                                        │
     │  ○ Hard Rebalance (sell overweight + buy underweight)   │
     │    Sell overweight holdings to free up cash, then       │
     │    buy underweight holdings to restore targets.         │
     └─────────────────────────────────────────────────────────┘
  2. Select DCA allocation method:
     ○ Proportional-to-drift (more money to most underweight)
     ○ Equal-weight (split evenly across underweight holdings)
  3. Enter this month's DCA budget (pre-filled from settings)
  4. App generates suggested trade list:
     - Per holding: ticker, action (BUY/SELL), suggested shares, estimated cost
     - Highlights if cash balance is insufficient → "Add TWD/USD" warning
  5. User executes trades in IBKR
  6. User fills in actual execution prices & fees per row
  7. One-tap "Log All" → creates Operation with all entries →
     Portfolio updates → New snapshot captured
```

**User Stories:**
- As a user, I want to choose between soft and hard rebalancing depending on market conditions
- As a user, I want the app to calculate exact share quantities for my monthly DCA budget using my preferred allocation method
- As a user, I want to fill in actual execution prices and log all trades as a single operation with one tap
- As a user, I want to be warned if my cash balance in the required currency is insufficient for the planned trades

### Flow 2: Log an Operation

```
Tap "+" → Select operation type → Enter details:
  - Ticker (autocomplete from portfolio)
  - Shares & price
  - Rationale (text)
  - Tag (optional)
→ App auto-captures: pre/post allocation, drift change, sleeve impact
→ Saved to operation log
```

**User Stories:**
- As a user, I want to record why I made each trade so I can review my decision-making later
- As a user, I want every operation to automatically capture the portfolio state before and after

### Flow 3: Performance Review

```
Open Performance tab → Select time range →
  See: total return, per-sleeve attribution, benchmark comparison
  Drill into: specific sleeve → specific holding → operation history
```

**User Stories:**
- As a user, I want to know if my tactical sleeve rotation (POWR ↔ VGLT) added value vs holding one static position
- As a user, I want to compare my portfolio return against a simple VOO benchmark
- As a user, I want to see my actual return (MWR) accounting for the timing of my contributions

### Flow 4: Drift Alert & Rebalance

```
(Background check or on-open)
Holdings drift past threshold → Badge/notification →
  User opens rebalance view → Sees suggested trades →
  Executes in IBKR → Logs rebalance operation
```

**User Stories:**
- As a user, I want to be notified when any holding drifts beyond my tolerance band
- As a user, I want rebalance suggestions that minimize number of trades (sell overweight → buy underweight)

### Flow 5: Cash & Foreign Exchange Management

```
User deposits TWD into brokerage → Logs cash deposit (TWD) →
  User converts TWD to USD → Logs FX transaction (rate, amount, fees) →
  USD cash balance updates →
  When buying USD-denominated ETF:
    Cost basis calculated using FIFO from FX transaction history
    (earliest unconsumed USD lot used first)

Cash balances visible on Dashboard.
If user tries to plan DCA and USD cash < required amount:
  → Warning: "Insufficient USD. You need to convert ~X TWD at current rate."
```

**User Stories:**
- As a user, I want to record every currency exchange so my cost basis in TWD reflects actual FX costs, not an arbitrary rate
- As a user, I want FIFO-based FX cost tracking so I know the true TWD cost of each USD purchase
- As a user, I want to see my cash balances per currency and be warned before I plan trades I can't afford

---

## 5. Feature Spec (MVP)

### F1: Portfolio Setup

**Description**: Define holdings, sleeves, target allocations, drift thresholds.

**Acceptance Criteria**:
- User can add/remove holdings (ticker + target %)
- User can create sleeves and assign holdings to them
- Target allocations must sum to 100% (validation)
- Drift threshold configurable per holding (default ±2%)
- Multi-currency support: each holding tagged with its denomination (USD or TWD)
- Cash accounts created automatically for each currency (TWD, USD) with starting balance input
- Default DCA settings: monthly budget, preferred rebalance strategy (soft/hard), allocation method (proportional/equal-weight)

**UI Behavior**: Wizard-style onboarding for first setup; editable settings page after.

---

### F2: Dashboard

**Description**: Home screen showing portfolio trajectory and health at a glance.

**Acceptance Criteria**:
- Hero element: portfolio total value line chart (default range: 1 year, selectable: 1M/3M/6M/YTD/1Y/ALL). Currency toggle (TWD / USD) switches the valuation currency for the chart and all displayed values.
- Quick stats bar: total value (TWD), unrealized P&L (amount + %), today's change
- Allocation overview: current vs target per-sleeve (horizontal stacked bar or donut), color-coded by drift status
- Cash balances: shows TWD and USD cash available, with TWD-equivalent total
- Ammunition pool status: Tier 1 / Tier 2 levels and deployment trigger proximity
- Recent operations: last 3 operations (compact cards: date, type, ticker, amount)
- Does NOT contain DCA suggestion (that lives in DCA Planner tab)

**UI Behavior**: This is the home screen / first tab. Pull-to-refresh on mobile. All values computed from manually-entered data (no live price feed in MVP — see Out of Scope).

---

### F3: Operation Logger

**Description**: Record any portfolio operation with full context.

**Acceptance Criteria**:
- Form with: operation type, ticker(s), shares, price, fees, rationale, tag
- Auto-captures portfolio snapshot (before/after state)
- Operation type determines required fields (e.g., TACTICAL_ROTATION needs "from" and "to" ticker)
- Rationale field required (enforces journaling discipline — this is a YNAB-like opinionated design choice)
- Operations are immutable after creation (can add notes, cannot edit core data)

**UI Behavior**: Floating "+" button. Operation type selector determines form layout. Quick-entry mode for DCA (pre-filled from suggestion).

---

### F4: Operation History

**Description**: Searchable, filterable log of all operations.

**Acceptance Criteria**:
- Chronological list with: date, type, holdings, P&L impact
- Filter by: type, sleeve, tag, date range
- Tap to expand: full details including rationale and before/after snapshot
- Export to CSV

**UI Behavior**: Infinite scroll. Search bar for text search across rationale field.

---

### F5: Performance Analytics

**Description**: Portfolio and sleeve-level performance attribution.

**Acceptance Criteria**:
- Time-weighted return (TWR) for selected period
- Money-weighted return (MWR/XIRR) accounting for cash flows
- Per-sleeve performance breakdown
- Benchmark comparison (configurable, default: VOO)
- Simple line chart of portfolio value over time

**UI Behavior**: Date range selector (1M, 3M, 6M, YTD, 1Y, ALL, custom). Tap sleeve to drill into holding-level detail.

---

### F6: Allocation Drift Monitor

**Description**: Visual and alert system for allocation drift.

**Acceptance Criteria**:
- Current vs target allocation visualization (per-holding and per-sleeve)
- Color coding: green (within band), yellow (approaching threshold), red (exceeded)
- Rebalance suggestion: minimum trades to restore targets within bands
- Badge on app icon when any holding exceeds threshold (PWA notification if permitted)

**UI Behavior**: Accessible from dashboard and as dedicated tab.

---

### F7: DCA Planner

**Description**: Dedicated tab for monthly DCA planning with rebalance strategy selection and one-tap operation logging.

**Acceptance Criteria**:
- Rebalance strategy selector:
  - **Soft Rebalance (buy-only)**: no sells; over-allocate DCA budget to underweight holdings, under-allocate to overweight. Overweight holdings get $0.
  - **Hard Rebalance (sell + buy)**: generate sell orders for overweight holdings, then buy orders for underweight. Net cash flow shown.
- DCA allocation method selector:
  - **Proportional-to-drift**: allocate more budget to the most underweight holdings, proportional to their drift magnitude
  - **Equal-weight**: split budget evenly across all underweight holdings
- Monthly DCA budget input (pre-filled from Portfolio settings, editable per session)
- Generated trade plan table: ticker, action (BUY/SELL), suggested shares (fractional amounts allowed), estimated cost, currency
- **Cash sufficiency check**: if planned trades exceed available cash in the required currency, show inline warning with shortfall amount (e.g., "Need additional $1,200 USD — convert ~TWD 38,400")
- **Execution logging**: each row has editable fields for actual price and actual fees (pre-filled with suggested values). User adjusts after executing in IBKR.
- **One-tap "Log All"**: creates a single Operation of type `DCA` or `REBALANCE` containing all entries, captures before/after snapshot, requires rationale

**UI Behavior**: Separate tab in bottom navigation (not inside Dashboard). Strategy and method selections persist across sessions (saved in settings). "Log All" button disabled until at least one row has actual price filled.

---

### F8: Cash & FX Management

**Description**: Track cash balances per currency and foreign exchange transactions with FIFO cost basis.

**Acceptance Criteria**:
- **Cash Accounts**: display current balance per currency (TWD, USD). Updated automatically when operations are logged.
- **Cash Deposit/Withdrawal**: log money moving into or out of the brokerage account (amount, currency, date, note)
- **FX Transaction Logger**: record currency conversions with: date, from-currency, from-amount, to-currency, to-amount, rate (auto-calculated or manual), fees, note
- **FIFO Queue Display**: show the current FX lot queue — each unconsumed lot with: date, rate, remaining amount. Consumed lots shown as greyed out.
- **Auto-consumption on trade**: when a BUY operation is logged in a foreign currency (USD), the app automatically consumes from the oldest FX lot(s) and records the FIFO-blended cost basis in the base currency (TWD)
- **Cost basis in base currency**: every holding's cost basis has a TWD-equivalent calculated from the FX lots consumed at purchase time
- **Latest rate for valuation**: the most recent FX transaction rate is stored as the "current rate" for converting foreign holdings to TWD in portfolio valuation. User can also manually override this.
- **Insufficient cash warning**: surfaced in DCA Planner (F7) and Operation Logger (F3) when available cash < required amount

**UI Behavior**: Accessible from Portfolio settings section. FX transaction history is a scrollable list with lot status indicators. Cash balances also shown on Dashboard (F2) as a compact summary.

---

## 6. Information Architecture

```
App (Bottom Tab Navigation)
├── Dashboard (home tab)
│   ├── Portfolio Value Chart (1Y default, selectable range)
│   ├── Quick Stats (total value, P&L, today's change)
│   ├── Allocation Overview (drift visualization, per-sleeve)
│   ├── Cash Balances (TWD, USD)
│   ├── Ammunition Pool Status
│   └── Recent Operations (last 3)
│
├── DCA Planner (tab)
│   ├── Rebalance Strategy Selector (soft / hard)
│   ├── Allocation Method Selector (proportional-to-drift / equal-weight)
│   ├── Budget Input
│   ├── Generated Trade Plan Table
│   ├── Cash Sufficiency Warning (conditional)
│   └── Execution Logger + "Log All" Button
│
├── Operations (tab)
│   ├── Operation History (list + filters + search)
│   └── Log Operation (form, accessed via "+" FAB)
│       ├── Standard trade (BUY/SELL/REBALANCE/etc.)
│       ├── Cash Deposit/Withdrawal
│       └── FX Exchange
│
├── Performance (tab)
│   ├── Portfolio Returns (chart + TWR/MWR metrics)
│   ├── Sleeve Attribution
│   └── Benchmark Comparison
│
└── Settings (tab or gear icon)
    ├── Portfolio Config
    │   ├── Holdings & Targets
    │   ├── Sleeves
    │   ├── Drift Thresholds
    │   ├── Ammunition Pool Rules
    │   └── Benchmark Selection
    ├── Cash & FX
    │   ├── Cash Accounts (balances)
    │   ├── FX Transaction History (with FIFO lot queue)
    │   └── Current FX Rate Override
    ├── DCA Settings
    │   ├── Monthly Budget (default)
    │   └── Default Rebalance Strategy & Method
    └── App Settings
        ├── Data Export/Import (JSON)
        └── Theme (light/dark)
```

---

## 7. Tech Stack & Architecture

### Frontend
- **Framework**: React + TypeScript
- **UI Library**: Tailwind CSS + shadcn/ui (clean, YNAB-like aesthetic)
- **State Management**: Zustand (lightweight, good for offline-first)
- **Charts**: Recharts (lightweight, React-native)
- **PWA**: Workbox for service worker, manifest for installability
- **Build**: Vite

### Data Layer
- **Local-first**: IndexedDB via Dexie.js (all data lives on device)
- **Sync (post-MVP)**: CRDTs or simple last-write-wins via Supabase/Firebase
- **Schema**: TypeScript interfaces → Dexie tables

### Backend (MVP: None)
- MVP is fully client-side. All data in IndexedDB.
- Price data: manual entry in MVP (user enters execution price when logging operations)
- Post-MVP: optional Supabase backend for cross-device sync and price API integration

### Deployment
- **Web**: Vercel (free tier sufficient for static PWA)
- **Mobile**: PWA installed via browser (iOS Safari, Android Chrome)
- No native app wrapper needed in MVP — PWA provides home screen icon, offline access, and push notifications

### Why This Stack
- React + Vite because you've worked with React before and Claude Code generates excellent React
- Local-first because it eliminates backend complexity for MVP and gives instant performance
- PWA over React Native because one codebase, no app store review, and YNAB proves this approach works at scale
- Zustand over Redux because the state shape is simple and predictable

---

## 8. Data Model (TypeScript Interfaces)

```typescript
interface Portfolio {
  id: string;
  name: string;
  baseCurrency: 'TWD';           // base currency for valuation
  supportedCurrencies: ('USD' | 'TWD')[];
  monthlyDCABudget: number;
  monthlyDCABudgetCurrency: 'USD' | 'TWD';
  defaultRebalanceStrategy: 'soft' | 'hard';
  defaultAllocationMethod: 'proportional-to-drift' | 'equal-weight';
  createdAt: Date;
  updatedAt: Date;
}

interface Holding {
  id: string;
  portfolioId: string;
  ticker: string;
  name: string;
  sleeveId: string;
  targetAllocationPct: number;  // 0-100
  driftThresholdPct: number;    // default 2
  currency: 'USD' | 'TWD';     // denomination of the holding
}

interface Sleeve {
  id: string;
  portfolioId: string;
  name: string;
  targetAllocationPct: number;  // sum of child holdings
  color: string;                // for visualization
}

// --- Cash & FX ---

interface CashAccount {
  id: string;
  portfolioId: string;
  currency: 'USD' | 'TWD';
  balance: number;              // current balance, updated by operations
}

interface FxTransaction {
  id: string;
  portfolioId: string;
  timestamp: Date;
  fromCurrency: 'USD' | 'TWD';
  toCurrency: 'USD' | 'TWD';
  fromAmount: number;
  toAmount: number;
  rate: number;                 // toAmount / fromAmount
  fees: number;
  feesCurrency: 'USD' | 'TWD';
  note?: string;
}

interface FxLot {
  id: string;
  fxTransactionId: string;      // which conversion created this lot
  currency: 'USD' | 'TWD';     // the currency of this lot
  originalAmount: number;       // amount when created
  remainingAmount: number;      // unconsumed amount (decreases as trades use it)
  rate: number;                 // FX rate at time of conversion
  timestamp: Date;              // for FIFO ordering
}

// --- Operations ---

interface Operation {
  id: string;
  portfolioId: string;
  type: 'BUY' | 'SELL' | 'REBALANCE' | 'DCA' | 'TACTICAL_ROTATION'
      | 'DRAWDOWN_DEPLOY' | 'DIVIDEND_REINVEST'
      | 'FX_EXCHANGE' | 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL';
  timestamp: Date;
  entries: OperationEntry[];    // trade legs (empty for FX/CASH types)
  fxTransactionId?: string;     // linked FX transaction (for FX_EXCHANGE type)
  cashFlow?: CashFlow;          // linked cash movement (for CASH_DEPOSIT/WITHDRAWAL)
  rationale: string;            // required
  tag?: string;
  snapshotBefore: PortfolioSnapshot;
  snapshotAfter: PortfolioSnapshot;
}

interface OperationEntry {
  holdingId: string;
  side: 'BUY' | 'SELL';
  shares: number;               // fractional amounts allowed (e.g., 0.573)
  pricePerShare: number;        // in holding's currency
  fees: number;
  currency: 'USD' | 'TWD';
  fxCostBasis?: {               // populated on BUY of foreign-currency holdings
    fxLotsConsumed: { lotId: string; amount: number; rate: number }[];
    blendedRate: number;        // weighted average rate from consumed lots
    baseCurrencyCost: number;   // total cost in TWD
  };
}

interface CashFlow {
  currency: 'USD' | 'TWD';
  amount: number;               // positive = deposit, negative = withdrawal
  note?: string;
}

// --- Snapshots ---

interface PortfolioSnapshot {
  timestamp: Date;
  totalValueBase: number;       // total value in base currency (TWD)
  currentFxRate: number;        // USD/TWD rate used for this snapshot
  cashBalances: { currency: string; balance: number }[];
  holdings: HoldingSnapshot[];
}

interface HoldingSnapshot {
  holdingId: string;
  shares: number;
  pricePerShare: number;        // in holding's currency
  marketValue: number;          // in holding's currency
  marketValueBase: number;      // in TWD
  costBasis: number;            // in holding's currency
  costBasisBase: number;        // in TWD (using FIFO FX rates)
  allocationPct: number;
  driftFromTarget: number;
}

interface AmmunitionPool {
  portfolioId: string;
  tier1: { holdingId: string; value: number; deployTriggerPct: number };
  tier2: { holdingId: string; value: number; deployTriggerPct: number };
}
```

---

## 9. Non-functional Requirements

- **Offline-first**: App must work fully offline. All data in IndexedDB.
- **Performance**: Dashboard loads in <1s on 4G connection. All interactions feel instant (optimistic UI).
- **Responsive**: Usable on 375px (iPhone SE) through 1920px desktop.
- **Accessibility**: WCAG 2.1 AA minimum. All charts have tabular fallbacks.
- **Data portability**: Full JSON export/import at any time. User owns their data.
- **i18n ready**: Structure supports zh-TW and en-US (implement en-US first, add zh-TW post-MVP).

---

## 10. Out of Scope (MVP)

**Claude Code: do NOT implement these features.**

- Live price feeds or market data API integration
- Live FX rate feeds (user manually logs FX transactions)
- Automatic IBKR sync or broker connection
- Backend server or database (MVP is fully client-side)
- Cross-device sync
- Tax lot tracking or tax optimization (note: FX FIFO lots are in scope for cost basis, but tax reporting is not)
- Options or derivatives tracking
- Social/sharing features
- AI-powered trade suggestions
- Multi-portfolio support (MVP: single portfolio)
- Native mobile app (iOS/Android)
- Backtesting engine (use the existing `dca-rebalancer` tool for this)
- News feed or market commentary

---

## 11. Success Metrics

After 1 month of personal use:
1. Every DCA operation logged with rationale (100% capture rate)
2. Time to answer "where should I put this month's DCA?" < 30 seconds (currently ~10 min in spreadsheet)
3. Can identify allocation drift without opening IBKR or Google Sheets
4. Can review the performance impact of any past tactical decision in < 3 taps

---

## 12. Implementation Phases (for Claude Code)

### Phase 1: Foundation (Day 1-2)
- Project scaffold (Vite + React + TS + Tailwind + shadcn/ui)
- Data model + Dexie.js schema (all interfaces from Section 8, including FxLot and CashAccount)
- Portfolio setup wizard (F1) — holdings, sleeves, cash accounts, DCA defaults
- Basic CRUD for holdings and sleeves

### Phase 2: Cash & FX Engine (Day 3-4)
- Cash account tracking (deposits, withdrawals, balance updates) (F8)
- FX transaction logger with automatic lot creation (F8)
- FIFO lot queue with consumption logic (F8)
- Cash balance display + sufficiency checks

### Phase 3: Core Operations (Day 5-6)
- Operation logger for all types including FX_EXCHANGE, CASH_DEPOSIT/WITHDRAWAL (F3)
- Auto-population of fxCostBasis on BUY operations using FIFO engine
- Operation history with filters (F4)
- Dashboard — value chart + allocation overview + cash balances (F2)

### Phase 4: DCA Planner (Day 7-8)
- Rebalance strategy engine: soft (buy-only) and hard (sell+buy) (F7)
- Allocation method engine: proportional-to-drift and equal-weight (F7)
- Trade plan generation with cash sufficiency warnings (F7)
- Execution logging with actual prices → one-tap "Log All" (F7)

### Phase 5: Intelligence & Monitoring (Day 9-10)
- Drift monitor with threshold alerts and color coding (F6)
- Ammunition pool status and deployment trigger proximity
- Snapshot system: capture on every operation + weekly auto-snapshot via service worker

### Phase 6: Performance (Day 11-12)
- TWR and MWR calculation engine (with proper handling of multi-currency cash flows)
- Performance charts (F5)
- Sleeve-level attribution
- Benchmark comparison (VOO default)

### Phase 7: Polish & Deploy (Day 13-14)
- PWA setup (manifest, service worker, offline)
- Data export/import (JSON — must include FX lots and cash accounts)
- Dark mode
- Responsive layout refinement
- Deploy to Vercel

---

## 13. Resolved Decisions

1. **DCA allocation method**: User-selectable per session. Two options: proportional-to-drift (default) and equal-weight. Stored as portfolio default, overridable in DCA Planner.
2. **FX rate handling**: Cost basis uses FIFO from user's FX transaction history. Current valuation uses the most recent FX transaction rate, with manual override option. No external FX API in MVP.
3. **Snapshot frequency**: On every operation + weekly auto-snapshot if app is opened (via service worker check).

---

## 14. Resolved Decisions (Round 2)

1. **Dashboard currency**: TWD/USD toggle on the value chart and all displayed values. Default to TWD (base currency).
2. **Fractional shares**: DCA Planner and hard rebalance suggestions use fractional share amounts. IBKR supports fractional for most ETFs.
3. **FX lot fee tracking**: Keep fees as a separate field on `FxTransaction`. Do not bake into effective rate. The FIFO blended cost calculation uses `rate` only; fees are tracked for reporting but not mixed into the rate to preserve data fidelity.
