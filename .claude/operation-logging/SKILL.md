---
name: operation-logging
description: Operation creation, snapshot capture, and operation history. Use when working on the Operation Logger form, Operation history list, snapshot logic, operation types, or any code that creates or displays Operations.
allowed-tools: Read, Grep, Glob, Edit, Write
---

# Operation Logging — Rules & Patterns

## When This Skill Applies

Any task involving:
- The "+" FAB and operation creation form
- Operation type selection and form layout switching
- Snapshot capture (before/after)
- Operation history list, filters, and search
- CSV export of operations
- Operation immutability enforcement

## Operation Types & Required Fields

| Type | Required Fields | Side Effects |
|------|----------------|--------------|
| `BUY` | ticker, shares, price, fees, currency | −cash, +holding shares, FIFO consumption if USD |
| `SELL` | ticker, shares, price, fees, currency | +cash, −holding shares, realized PnL calc |
| `DCA` | multiple entries (from DCA Planner) | Same as BUY per entry |
| `REBALANCE` | multiple entries (BUY + SELL) | Same as BUY/SELL per entry |
| `TACTICAL_ROTATION` | "from" ticker (SELL) + "to" ticker (BUY) | Combined SELL + BUY |
| `DRAWDOWN_DEPLOY` | ticker, shares, price, tier (1 or 2) | −cash from ammo pool, +holding |
| `DIVIDEND_REINVEST` | ticker, shares, price, dividend amount | +cash (dividend), then −cash (reinvest) |
| `FX_EXCHANGE` | fromCurrency, toCurrency, amounts, rate, fees | Creates FxLot, updates both CashAccounts |
| `CASH_DEPOSIT` | currency, amount | +CashAccount balance |
| `CASH_WITHDRAWAL` | currency, amount | −CashAccount balance |

## Snapshot Capture Pattern

Every Operation must capture `snapshotBefore` and `snapshotAfter`:

```
1. Read current portfolio state → snapshotBefore
2. Execute the operation (update holdings, cash, FX lots)
3. Read updated portfolio state → snapshotAfter
4. Save Operation with both snapshots
```

A `PortfolioSnapshot` includes:
- `totalValueBase` (TWD)
- `currentFxRate` (latest USD/TWD)
- `cashBalances` per currency
- Per-holding: shares, price, marketValue, costBasis, allocationPct, driftFromTarget

### Snapshot frequency beyond operations:
- Weekly auto-snapshot if app is opened (via service worker / periodic check)
- These are standalone snapshots, not attached to an Operation

## Immutability Rules

**Operations are immutable after creation:**
- Core data (type, entries, amounts, prices, fees, timestamps) CANNOT be edited
- `rationale` CANNOT be edited after save
- Users CAN add post-hoc notes (append-only)
- Snapshots are frozen at creation time

If a user made a mistake, they should create a correcting operation (e.g., a SELL to reverse an erroneous BUY), not edit the original.

## Rationale Field

**Always required. Never make it optional.**

This is a deliberate YNAB-inspired design choice. The rationale field enforces journaling discipline. When the user reviews operations months later, the rationale explains *why* they made that decision.

UI hint text examples:
- BUY: "Why are you buying this? (e.g., 'Monthly DCA — VOO most underweight')"
- TACTICAL_ROTATION: "Why rotate? (e.g., 'Fed signaling 2+ cuts, switching POWR → VGLT')"
- DRAWDOWN_DEPLOY: "Why deploy now? (e.g., 'VOO -22% from ATH, Tier 1 trigger hit')"

## Operation History

### Filters
- By type (multi-select)
- By sleeve
- By tag (e.g., `monthly-dca`, `rebalance-q1`)
- By date range

### Search
- Text search across the `rationale` field
- This is the primary discovery mechanism for past decisions

### Expand view
- Tap to see full details: all entries, rationale, tag, and before/after snapshot diff
- Show drift change: "VOO drift went from -3.2% to -0.8% after this operation"

### CSV Export
Include: date, type, ticker, action, shares, price, fees, currency, rationale, tag

## Form UX Patterns

### Type selector determines form layout
- BUY/SELL: single ticker form
- TACTICAL_ROTATION: dual ticker form ("From" + "To")
- FX_EXCHANGE: currency pair form (no ticker)
- CASH_DEPOSIT/WITHDRAWAL: simple amount + currency
- DCA/REBALANCE: multi-entry table (usually created from DCA Planner, not manually)

### Quick-entry from DCA Planner
When "Log All" is triggered from DCA Planner, the Operation Logger receives pre-filled entries. The user only needs to add rationale and confirm. Do not force them through the full manual form.

### Auto-tag suggestion
If logging on a monthly cadence, suggest `monthly-dca-YYYY-MM` as tag. User can override.

## Atomicity

Operation creation must be atomic:
1. All Dexie writes (Operation, CashAccount updates, FxLot consumption, Holding share updates) happen in a single Dexie transaction
2. If any write fails, none persist
3. Zustand store updates only after Dexie transaction commits successfully

```typescript
await db.transaction('rw', [db.operations, db.cashAccounts, db.fxLots, db.holdings], async () => {
  // All writes here — Dexie guarantees atomicity
});
```
