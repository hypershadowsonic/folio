---
name: fifo-fx-engine
description: FIFO foreign exchange lot queue and cost basis calculation. Use when working on FX transactions, FX lot consumption, cost basis calculations, BUY operations for USD-denominated holdings, cash balance updates, or any code in lib/fifo.ts.
allowed-tools: Read, Grep, Glob, Edit, Write
---

# FIFO FX Engine — Rules & Patterns

## When This Skill Applies

Any task involving:
- FX transaction creation or editing
- FX lot queue display or manipulation
- BUY operations for USD-denominated holdings (cost basis calculation)
- Cash balance arithmetic after FX conversions
- JSON export/import of FX lots
- Performance calculations that reference cost basis in TWD

## Core Mental Model

```
User converts TWD → USD (FX Transaction)
  → Creates an FxLot { rate, originalAmount, remainingAmount }
  → USD CashAccount.balance increases

User buys VOO for $500 (BUY Operation)
  → FIFO engine consumes oldest FxLot(s) with remainingAmount > 0
  → Produces fxCostBasis: blended TWD cost from consumed lots
  → USD CashAccount.balance decreases
```

## FIFO Consumption Algorithm

```typescript
// Pseudocode — the actual implementation is in lib/fifo.ts
function consumeFxLots(amountNeeded: number, currency: 'USD'): ConsumptionResult {
  const lots = await db.fxLots
    .where('currency').equals(currency)
    .filter(lot => lot.remainingAmount > 0)
    .sortBy('timestamp');  // OLDEST FIRST — this is the FIFO guarantee

  const consumed: { lotId: string; amount: number; rate: number }[] = [];
  let remaining = amountNeeded;

  for (const lot of lots) {
    if (remaining <= 0) break;

    const take = Math.min(lot.remainingAmount, remaining);
    consumed.push({ lotId: lot.id, amount: take, rate: lot.rate });

    lot.remainingAmount -= take;  // mutate and save
    remaining -= take;
  }

  if (remaining > 0) {
    throw new InsufficientFxLotsError(currency, amountNeeded, remaining);
  }

  const blendedRate = consumed.reduce((sum, c) => sum + c.amount * c.rate, 0)
                    / consumed.reduce((sum, c) => sum + c.amount, 0);

  return {
    lotsConsumed: consumed,
    blendedRate,
    baseCurrencyCost: amountNeeded * blendedRate,
  };
}
```

## Critical Rules

### 1. Sort order is SACRED
FX lots MUST be sorted by `timestamp` ascending (oldest first). Never sort by rate, amount, or any other field for consumption purposes.

### 2. Partial consumption is normal
A single lot can be partially consumed across multiple BUY operations. `remainingAmount` tracks what's left. A lot is "exhausted" when `remainingAmount === 0`.

### 3. Never create negative remainingAmount
If a BUY requires more USD than available in all lots combined, throw an error. Do NOT allow negative remainingAmount.

### 4. FX fees are separate from rate
`FxTransaction.fees` is tracked but NOT baked into the effective rate. The `rate` field is pure (toAmount / fromAmount). Fees are for reporting only.

### 5. Blended rate is weighted average
When multiple lots are consumed for one BUY, the blended rate = Σ(amount × rate) / Σ(amount). This goes into `OperationEntry.fxCostBasis.blendedRate`.

### 6. Lot-operation linkage
Each `OperationEntry.fxCostBasis.fxLotsConsumed` array records exactly which lots were consumed and how much from each. This is the audit trail. Never lose this linkage.

### 7. Current valuation uses latest transaction rate
For display purposes (Dashboard, Performance), foreign holdings are converted to TWD using the most recent `FxTransaction.rate`, NOT the FIFO blended rate. The FIFO rate is for cost basis only.

### 8. Share-level realized PnL uses weighted-average cost
FIFO is ONLY for FX lots. When calculating realized PnL on SELL operations, use `averageCostBasis` (weighted average method across all shares of that holding), not FIFO of share purchase lots.

## Cash Balance Updates

Every FX-related operation must update CashAccount balances atomically:

| Operation | TWD Balance | USD Balance |
|-----------|-------------|-------------|
| CASH_DEPOSIT (TWD) | +amount | — |
| CASH_DEPOSIT (USD) | — | +amount |
| FX_EXCHANGE (TWD→USD) | −fromAmount | +toAmount |
| BUY (USD holding) | — | −(shares × price + fees) |
| SELL (USD holding) | — | +(shares × price − fees) |
| DIVIDEND_REINVEST | depends on currency | depends on currency |

## Edge Cases to Handle

1. **First BUY before any FX transaction**: User may deposit USD directly (CASH_DEPOSIT in USD). In this case, there are no FX lots to consume. The BUY should still work — `fxCostBasis` is `undefined` for holdings bought with directly-deposited foreign currency.

2. **FX lot queue exhausted mid-consumption**: If lots run out before the BUY amount is fully covered, surface a clear error. Do not silently proceed with partial cost basis.

3. **Multiple currencies in one Operation**: A DCA operation may include both TWD holdings (0050) and USD holdings (VOO). Process each entry's currency independently.

4. **Export/import integrity**: When exporting FX lots to JSON, include both consumed and unconsumed lots. On import, validate that `remainingAmount <= originalAmount` for every lot.
