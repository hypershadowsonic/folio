---
name: rebalance-engine
description: DCA planner and rebalance calculation logic. Use when working on soft/hard rebalance, proportional-to-drift or equal-weight allocation, trade plan generation, DCA budget splitting, or any code in lib/rebalance.ts or dca-planner components.
allowed-tools: Read, Grep, Glob, Edit, Write
---

# Rebalance Engine — Rules & Patterns

## When This Skill Applies

Any task involving:
- DCA Planner tab UI or logic
- Trade plan generation (suggested buys/sells)
- Soft or hard rebalance calculations
- Allocation drift computation
- Cash sufficiency checks before trade execution
- "Log All" one-tap operation creation from trade plans

## Two Rebalance Strategies

### Soft Rebalance (buy-only / 僅買入再平衡)

No sells. DCA budget is allocated ONLY to underweight holdings. Overweight holdings get $0.

```
For each holding:
  drift = currentAllocationPct - targetAllocationPct
  if drift < 0:  → underweight → eligible for DCA allocation
  if drift >= 0: → overweight or on-target → gets $0 this month
```

Use this when: market is up and you don't want to trigger taxable sells.

### Hard Rebalance (sell + buy / 賣出再買入)

Sell overweight holdings to free cash, then buy underweight holdings.

```
Step 1: Calculate sell amounts for overweight holdings
  sellAmount = (currentAllocationPct - targetAllocationPct) × totalPortfolioValue
  
Step 2: Add sell proceeds to available cash

Step 3: Calculate buy amounts for underweight holdings
  buyAmount based on drift magnitude (same as soft rebalance allocation)
```

Use this when: doing periodic (quarterly/annual) full rebalance.

## Two Allocation Methods

### Proportional-to-Drift (default / 依偏離度比例分配)

More budget goes to the most underweight holdings, proportional to how far they've drifted.

```typescript
// Only underweight holdings participate
const underweightHoldings = holdings.filter(h => h.drift < 0);
const totalDrift = underweightHoldings.reduce((sum, h) => sum + Math.abs(h.drift), 0);

for (const holding of underweightHoldings) {
  holding.allocation = budget * (Math.abs(holding.drift) / totalDrift);
}
```

### Equal-Weight (等權分配)

Split budget evenly across ALL underweight holdings, regardless of drift magnitude.

```typescript
const underweightHoldings = holdings.filter(h => h.drift < 0);
const perHolding = budget / underweightHoldings.length;

for (const holding of underweightHoldings) {
  holding.allocation = perHolding;
}
```

## Trade Plan Generation

The output of the rebalance engine is a trade plan table:

| Field | Description |
|-------|-------------|
| ticker | Holding ticker symbol |
| action | BUY or SELL |
| suggestedShares | Fractional amounts allowed (e.g., 0.573) |
| estimatedCost | shares × last known price |
| currency | USD or TWD |
| actualPrice | Editable — user fills after executing in IBKR |
| actualFees | Editable — user fills after executing |

### Key rules for trade plan:

1. **Fractional shares are allowed.** IBKR supports fractional for most ETFs. Do not round to whole shares.

2. **Currency must match the holding's denomination.** VOO trades in USD, 0050 trades in TWD. Never mix.

3. **Cash sufficiency check per currency.** Check USD cash for USD buys, TWD cash for TWD buys. Show inline warning with shortfall amount if insufficient: "Need additional $1,200 USD — convert ~TWD 38,400"

4. **The shortfall suggestion uses the latest FX rate** (most recent FxTransaction rate) for the TWD equivalent estimate.

5. **Suggested price comes from the most recent snapshot** or last logged operation price for that holding. This is a best-effort estimate — actual price will differ.

## "Log All" Flow

When user taps "Log All":

1. Validate: at least one row has `actualPrice` filled
2. Create a single `Operation` of type `DCA` (for soft) or `REBALANCE` (for hard)
3. Each row becomes an `OperationEntry`
4. For USD BUY entries: trigger FIFO FX lot consumption → populate `fxCostBasis`
5. Update all `CashAccount` balances
6. Capture `snapshotBefore` (pre-operation state) and `snapshotAfter` (post-operation state)
7. Require `rationale` text before saving (mandatory — do not skip)
8. Save Operation + update Zustand store

This must be **atomic**: if any step fails (e.g., insufficient FX lots), roll back everything. Do not leave partial operations in the database.

## Drift Calculation

```typescript
// Per-holding drift
drift = (holdingMarketValueBase / totalPortfolioValueBase * 100) - targetAllocationPct

// Color coding thresholds
if (Math.abs(drift) <= threshold * 0.5) → green (healthy)
if (Math.abs(drift) <= threshold)       → yellow (approaching)
if (Math.abs(drift) > threshold)        → red (exceeded, trigger rebalance signal)
```

`totalPortfolioValueBase` includes cash balances and all holdings, all converted to TWD.

## Edge Cases

1. **All holdings are overweight**: In soft rebalance, no trades are suggested. Show a message: "All holdings are at or above target. Consider hard rebalance or increasing underweight targets."

2. **Budget is too small**: If the DCA budget can only buy meaningful amounts of 1-2 holdings, prioritize the most underweight. Don't spread $50 across 10 holdings.

3. **Ammunition pool holdings**: SGOV is earmarked for drawdown deployment. The DCA planner should treat it like any other holding for drift purposes, but the Dashboard should show its ammunition pool status separately.

4. **Tactical sleeve rotation**: When user rotates POWR ↔ VGLT, this is a `TACTICAL_ROTATION` operation (SELL one + BUY other), not a rebalance. The DCA planner does not handle this — it goes through the standard Operation Logger.
