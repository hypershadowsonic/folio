# Folio — Investment Portfolio Operations & Performance Tracker

## About This Project

Folio is a **local-first, offline-first PWA** for systematic investors who run rules-based ETF portfolios with DCA, tactical rebalancing, and drawdown deployment.

Core philosophy: **operations-centric**, not price-centric. Every trade is logged with rationale, pre/post snapshots, and strategy context. Think YNAB for portfolio management — the tool enforces discipline.

Full PRD: `docs/PRD.md`

## Current Status

**Phases 1–12 complete. Entering Phase 13 (Polish & Deploy).**

| Phase | Status | What It Covers |
|-------|--------|----------------|
| 1. Foundation | ✅ Done | Vite + React + TS scaffold, Dexie schema, Portfolio setup wizard |
| 2. Cash & FX Engine | ✅ Done | Cash accounts, FX transactions, FIFO lot queue + consumption |
| 3. Core Operations | ✅ Done | Operation logger (all types), auto fxCostBasis on BUY, history + filters, Dashboard |
| 4. DCA Planner | ✅ Done | Soft/hard/none rebalance engine, proportional-to-drift / equal-weight, trade plan + "Log All" |
| 5. Intelligence | ✅ Done | Drift monitor + threshold alerts, ammunition pool status, snapshot system |
| 6. Performance | ✅ Done | TWR/MWR engine, performance charts, sleeve attribution, benchmark comparison |
| 7. Build Foundation | ✅ Done | Mode toggle, BuildCreator wizard, backtest engine, Yahoo Finance API + price cache |
| 8. Benchmarks & Compares | ✅ Done | BenchmarkCreator, CompareCreator, multi-item overlay chart |
| 9. Build Dashboard | ✅ Done | Favorite item hero card, YoY/MoM metrics, quick-nav to detail |
| 10. Build Settings | ✅ Done | JSON export/import for Build data, price cache management |
| 11. Build Polish | ✅ Done | Compare tab wired, BuildDetail metrics, mode persistence |
| 12. Promote/Fork | ✅ Done | Promote Build→Portfolio, Fork Portfolio→Build, EntityLink lineage |
| 13. Polish & Deploy | 🔜 Next | PWA manifest + service worker, Portfolio JSON export/import, dark mode, responsive refinement, Vercel deploy |

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | React 18 + TypeScript (strict) | Claude Code generates excellent React; strict TS catches domain logic bugs early |
| Build | Vite | Fast HMR, simple config |
| UI | Tailwind CSS + shadcn/ui | Clean YNAB-like aesthetic; shadcn components are copy-pasted, not npm-installed |
| State | Zustand | Lightweight, good for offline-first; simple and predictable state shape |
| Data | Dexie.js (IndexedDB) | Local-first, all data lives on device, no backend in MVP |
| Charts | Recharts | Lightweight, React-native chart library |
| PWA | Workbox | Service worker + offline caching (Phase 7) |
| Deploy | Vercel | Free tier, static PWA hosting |

## Key Directories

```
src/
├── components/           # Shared UI components
│   ├── ui/               # shadcn/ui primitives (Button, Card, Dialog, Input, etc.)
│   ├── BottomNav.tsx     # Bottom navigation (5 tabs Portfolio / 4 tabs Build)
│   ├── ModeToggle.tsx    # Top-right Portfolio ↔ Build mode switcher
│   ├── ApiStatus.tsx     # Yahoo Finance API connectivity indicator
│   └── ErrorBoundary.tsx # Tab-level error boundary (class component)
├── features/             # Feature modules (tab-level pages + sub-components)
│   ├── dashboard/        # Portfolio Dashboard: drift monitor, ammo pool, price update
│   ├── dca-planner/      # DCA Planner: soft/hard/none rebalance trade plan
│   ├── operations/       # Operation logger, history, cash/FX dialogs
│   ├── performance/      # Performance analytics: TWR/MWR, charts, attribution
│   ├── settings/         # Portfolio config, Cash & FX manager, setup wizard, ForkToBuild
│   └── build/            # Build mode (all tabs)
│       ├── dashboard/    # Build Dashboard: favorite item hero card
│       ├── builds/       # BuildCard, BuildCreator, BuildDetail, PromoteToPortfolio
│       ├── benchmarks/   # BenchmarkCard, BenchmarkCreator, BenchmarkDetail
│       ├── compares/     # CompareCard, CompareCreator, CompareDetail
│       └── settings/     # Build Settings: JSON export/import, cache management
├── engine/               # Pure business logic (no React)
│   ├── fifo.ts           # FIFO FX lot queue + consumption engine
│   ├── rebalance.ts      # Soft/hard/none rebalance calculation engine
│   ├── performance.ts    # TWR, MWR, PnL, chart data calculations
│   ├── drift.ts          # Drift monitor + threshold alerts
│   ├── ammunition.ts     # Ammunition pool status engine
│   ├── cash.ts           # Cash sufficiency + balance helpers
│   ├── backtest.ts       # DCA simulation engine (Build mode)
│   └── compare.ts        # Compare alignment engine (Build mode)
├── db/                   # Dexie.js database layer
│   ├── index.ts          # Barrel re-export (convenience imports)
│   ├── database.ts       # FolioDB Dexie class + schema (v5) — all 10 tables
│   ├── hooks.ts          # useLiveQuery hooks for Portfolio tables
│   ├── buildHooks.ts     # useLiveQuery hooks for Build tables + useLinksForBuild
│   ├── entityLinkService.ts # EntityLink CRUD helpers
│   ├── holdingService.ts # Holding CRUD operations
│   ├── operationService.ts # Operation write + snapshot trigger
│   ├── snapshotService.ts  # Portfolio snapshot capture
│   └── cashFxService.ts  # Cash account + FX lot writes
├── services/             # App-level side-effect services
│   ├── yahooFinance.ts   # Yahoo Finance price/search client + PriceCache reads/writes
│   ├── autoSnapshot.ts   # Automatic daily snapshot scheduler
│   ├── holdingLifecycle.ts # Holding status transitions
│   └── notifications.ts  # Drift/threshold notification helpers
├── stores/               # Zustand stores
│   ├── modeStore.ts      # Active mode (portfolio/build) — persisted to localStorage
│   ├── portfolioStore.ts # Portfolio + holdings state
│   ├── backtestStore.ts  # Build backtest run state
│   └── uiStore.ts        # UI state (active tab, modals, etc.)
├── hooks/                # Custom React hooks
│   ├── usePortfolio.ts   # Portfolio data aggregation hook
│   └── useDebounce.ts    # Generic debounce hook
├── types/
│   └── index.ts          # All TypeScript domain interfaces (Portfolio + Build)
├── lib/
│   ├── utils.ts          # cn() helper (Tailwind class merging)
│   └── ibkrParser.ts     # IBKR Activity Statement CSV parser
└── App.tsx               # App shell: mode routing + tab routing + ErrorBoundary wrappers
api/
├── prices.js             # Vercel serverless: daily adjusted close prices (Yahoo Finance)
└── search.js             # Vercel serverless: ticker autocomplete (Yahoo Finance)
docs/
└── PRD.md                # Full product requirements document
```

> **If the actual directory structure differs from the above, trust the codebase, not this file.** Run `find src -type f -name "*.ts" -o -name "*.tsx" | head -60` to orient yourself.

## Domain Model — Critical Concepts

Read `docs/PRD.md` Section 10 for full TypeScript interfaces. Here's the mental model:

### Two-mode architecture (兩模式架構)
The app has two switchable modes — **Portfolio** (live portfolio tracking, cyan blue accent) and **Build** (strategy simulation, orange accent). A persistent toggle in the top-right header switches modes at any time. Each mode has its own bottom navigation tabs. Mode is persisted to localStorage via `modeStore.ts`.

### Operations are the core entity (操作是核心實體)
Every portfolio action is an `Operation` with type, entries, rationale, and before/after snapshots. Operations are **immutable** after creation. Rationale is **required** (opinionated design choice).

### Cash is first-class (現金是一等公民)
Cash balances (TWD, USD) are explicit `CashAccount` entities updated by every operation. Always check cash sufficiency before generating trade plans.

### FX uses FIFO lots (外匯用先進先出批次)
Each TWD→USD conversion creates an `FxLot`. When buying USD-denominated ETFs, the oldest unconsumed lot is consumed first. This gives accurate TWD cost basis. **Never bypass the FIFO engine for cost basis calculations.**

### Sleeves group holdings (組別分組持股)
Holdings belong to Sleeves (e.g., "Core", "Thematic", "Tactical"). Target allocations must sum to 100% at both holding and sleeve level.

### Ammunition Pool (彈藥池)
Two-tier cash reserve: Tier 1 deploys at configurable drawdown trigger (e.g., -10% from ATH), Tier 2 at deeper drawdown (e.g., -20%). SGOV holdings are earmarked, not generic cash.

### Realized PnL uses weighted-average cost basis
Not FIFO for share lots — only FX lots use FIFO. Share cost basis uses `averageCostBasis` (weighted average method).

### Build mode uses backtesting (Build 模式使用回測)
`Build` entities define hypothetical DCA portfolios. The backtest engine (`src/engine/backtest.ts`) simulates DCA + rebalancing using Yahoo Finance historical prices (fetched via `api/prices.js`). Output: `BacktestResult` with time series and summary metrics. Builds can be promoted to live Portfolios.

### EntityLink tracks lineage (EntityLink 追蹤血緣)
`EntityLink` records the relationship when a Build is promoted to a Portfolio (`relationType: 'promoted_from'`) or a Portfolio is forked to a Build (`relationType: 'forked_from'`). Stored in the `entityLinks` Dexie table. Informational only — not auto-synchronized.

## Coding Standards

### TypeScript
- **Strict mode always on** (`"strict": true` in tsconfig)
- Prefer `interface` over `type` for domain objects
- No `any` — use `unknown` and narrow with type guards
- All financial calculations in dedicated `lib/` functions, not in components
- Use `Decimal.js` or equivalent if precision issues arise with floating point — **never use raw `number` for currency arithmetic in production** without verifying precision is acceptable

### React & Components
- Functional components only, no class components
- shadcn/ui components live in `src/components/ui/` — import from there, not from npm
- Keep components thin: business logic lives in `lib/`, state in Zustand stores, components just render + dispatch
- Use `React.memo` judiciously for expensive chart renders, not everywhere

### Styling
- Tailwind utility classes only — no custom CSS files unless absolutely necessary
- Follow shadcn/ui patterns for component styling
- Dark mode support via Tailwind `dark:` variants (Phase 7)
- Mobile-first responsive: design for 375px, scale up

### State & Data
- Zustand stores for UI state and derived portfolio state
- Dexie.js for persistence — all reads/writes go through Dexie, not Zustand
- Pattern: Component → Zustand action → Dexie write → Zustand state update from Dexie read
- Optimistic UI: update Zustand immediately, write to Dexie async, handle errors gracefully

### Naming
- Files: `kebab-case.ts` / `kebab-case.tsx`
- Components: `PascalCase`
- Zustand stores: `use[Name]Store.ts`
- Dexie tables: `camelCase` matching interface names
- Operation types: `SCREAMING_SNAKE_CASE` (e.g., `TACTICAL_ROTATION`)

## Common Commands

```bash
npm run dev          # Start Vite dev server (localhost:5173)
npm run build        # Production build
npm run preview      # Preview production build locally
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

## Hard Constraints — Do NOT Violate

1. **No backend.** MVP is fully client-side. All data in IndexedDB. Do not introduce any server, API endpoint, or external database.
2. **No live price feeds in Portfolio mode.** Portfolio operation prices are manually entered by the user. **Build mode** fetches historical prices via `api/prices.js` (Yahoo Finance proxy) for backtesting. Do not add streaming prices or WebSocket feeds to either mode.
3. **No live FX rates in Portfolio mode.** Portfolio FX rates come from the user's manually logged FX transactions (most recent rate used for current valuation). Build mode fetches `USDTWD=X` historical rates from Yahoo Finance alongside price data.
4. **No live broker integration.** No IBKR API, no live Flex Query. IBKR Activity Statement CSV import (file-based, offline) is in scope — see `src/lib/ibkrParser.ts` and `src/features/settings/IBKRImport.tsx`.
5. **Single portfolio only.** MVP does not support multiple portfolios.
6. **Operations are immutable.** After creation, core data (type, entries, amounts) cannot be edited. Users can only add notes.
7. **Rationale is required** on every Operation. Do not make it optional — this is a deliberate design choice.
8. **FIFO is sacred for FX lots.** Do not implement LIFO, average cost, or any other method for FX cost basis. Share-level realized PnL uses weighted-average cost, not FIFO.
9. **Allocation targets must sum to 100%.** Validate at both holding level and sleeve level. Reject invalid configurations.
10. **Data portability.** Full JSON export/import must include all entities: holdings, sleeves, cash accounts, FX lots, operations, snapshots, builds, benchmarks, compares, entityLinks. Never leave an entity type out of export.

## Out of Scope (MVP)

Claude Code: do NOT implement these. If asked, refer to PRD Section 10.

- Live price/FX feeds or market data APIs
- Backend server or database
- Cross-device sync
- Tax lot tracking or tax reporting (FX FIFO lots are in scope, tax reporting is not)
- Options/derivatives tracking
- Multi-portfolio support
- Native mobile app
- AI-powered trade suggestions
- Social/sharing features

## Phase 13 Checklist

This is what's next. Implement in this order:

1. **PWA manifest + service worker** (Workbox): offline access, home screen installability
2. **Portfolio JSON export/import**: full data portability (all Dexie tables → single JSON file, and reverse) — must include entityLinks; Build JSON export/import already done in Phase 10
3. **Dark mode**: Tailwind `dark:` variants, theme toggle in Settings, respect system preference
4. **Responsive layout refinement**: test on 375px (iPhone SE) through 1920px desktop, fix breakpoints
5. **Deploy to Vercel**: configure build, test PWA installation on iOS Safari + Android Chrome

## Asking Clarifying Questions

If a task is ambiguous or could conflict with the architecture, **ask before implementing.** Specifically:
- If a change would affect the FIFO engine or cost basis calculations
- If a change would introduce a new external dependency
- If a change would modify the Operation data structure
- If a UX change contradicts the "operations-centric" philosophy (e.g., making rationale optional)
