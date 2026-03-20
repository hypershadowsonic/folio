/**
 * DCAPlanner — F7 DCA Planner tab (Phase 4).
 *
 * Sections:
 *   1. Header — "DCA Planner" + current month/year
 *   2. Strategy selector — Soft / Hard (radio cards, persisted to portfolioStore)
 *   3. Allocation method selector — Proportional / Equal (radio cards, persisted)
 *   4. Budget input — amount + currency + available cash + "Generate Plan" button
 *   5. Trade Plan Table — scrollable <table> with SELL→BUY→HOLD sort, execution inputs
 *   6. Cash Sufficiency Warning — with "Proceed anyway" toggle
 *   7. Plan Summary — buy cost, sell proceeds, net cash flow, trade counts
 *   8. Rationale Input — pre-filled placeholder with month/year
 *   9. "Log All Trades" Button — multi-condition disabled logic
 *  10. "Copy to Clipboard" — tab-delimited for IBKR paste
 *
 * Data flow:
 *   - strategy / allocationMethod changes persist via portfolioStore.updatePortfolio
 *   - budget is session-only (not persisted until Log All)
 *   - "Generate Plan" pre-fills executions from currentPricePerShare, then sets planGenerated=true
 *   - subsequent dep changes auto-regenerate because useMemo re-runs on dep change
 */

import { useState, useMemo, useCallback } from 'react'
import {
  AlertTriangle, CheckCircle2, RefreshCw, TrendingUp,
  Copy, Check, ArrowRight, Circle, XCircle,
} from 'lucide-react'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore } from '@/stores/uiStore'
import { useDriftSummary } from '@/features/dashboard/DriftMonitor'
import { useCashAccounts, useActiveHoldings, useSleeves } from '@/db/hooks'
import { useLiveQuery } from 'dexie-react-hooks'
import Dexie from 'dexie'
import { db } from '@/db/database'
import { createTradeOperation } from '@/db/operationService'
import { InsufficientCashError } from '@/engine/cash'
import { InsufficientSharesError } from '@/db/holdingService'
import {
  calculateCurrentAllocations,
  generateRebalancePlan,
} from '@/engine/rebalance'
import type { TradePlan, MinimumBuyAmounts } from '@/engine/rebalance'
import { Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { RebalanceStrategy, AllocationMethod, OperationType } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTION_ORDER: Record<'BUY' | 'SELL' | 'HOLD', number> = { SELL: 0, BUY: 1, HOLD: 2 }

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCur(amount: number, currency: 'USD' | 'TWD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'TWD' ? 0 : 2,
  }).format(amount)
}


function currentMonthYear(): string {
  return new Date().toLocaleString('default', { month: 'long', year: 'numeric' })
}

// ─── RadioCard ────────────────────────────────────────────────────────────────

interface RadioCardProps {
  selected: boolean
  onSelect: () => void
  label: string
  subtitle: string
}

function RadioCard({ selected, onSelect, label, subtitle }: RadioCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex-1 rounded-xl border p-3.5 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
          : 'border-border bg-card hover:bg-muted/30',
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn(
          'mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors',
          selected ? 'border-primary bg-primary' : 'border-muted-foreground/50',
        )} />
        <div className="space-y-0.5">
          <p className={cn('text-sm font-medium leading-snug', selected ? 'text-foreground' : 'text-muted-foreground')}>
            {label}
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">{subtitle}</p>
        </div>
      </div>
    </button>
  )
}

// ─── TradeTableRow ─────────────────────────────────────────────────────────────

export interface RowExecution {
  actualPrice: string
  actualShares: string
  actualCost: string   // total cost excluding fees; used as basis for logging
  fees: string
}

interface TradeTableRowProps {
  trade: TradePlan
  sleeveName: string
  execution: RowExecution
  onExecutionChange: (next: RowExecution) => void
}

function TradeTableRow({ trade, sleeveName, execution, onExecutionChange }: TradeTableRowProps) {
  const { action, ticker, currency, suggestedAmount,
          currentAllocationPct, targetAllocationPct, projectedAllocationPct } = trade
  const filled = parseFloat(execution.actualShares) > 0 && parseFloat(execution.actualCost) > 0

  const isHold = action === 'HOLD'

  return (
    <tr className={cn(
      'border-b border-border/60 last:border-b-0 transition-colors',
      isHold ? 'opacity-50' : 'hover:bg-muted/20',
    )}>
      {/* Ticker + currency */}
      <td className="py-2.5 pl-3 pr-2 align-middle">
        <span className="font-semibold text-sm">{ticker}</span>
        <span className="ml-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">{currency}</span>
      </td>

      {/* Sleeve */}
      <td className="py-2.5 px-2 align-middle text-xs text-muted-foreground truncate max-w-[80px]">
        {sleeveName || '—'}
      </td>

      {/* Action badge */}
      <td className="py-2.5 px-2 align-middle">
        {action === 'BUY'  && <Badge variant="success"     className="text-[10px] py-0">BUY</Badge>}
        {action === 'SELL' && <Badge variant="destructive" className="text-[10px] py-0">SELL</Badge>}
        {action === 'HOLD' && <Badge variant="secondary"   className="text-[10px] py-0">HOLD</Badge>}
      </td>

      {/* Est. cost */}
      <td className="py-2.5 px-2 align-middle text-right tabular-nums text-sm text-muted-foreground">
        {suggestedAmount > 0 ? fmtCur(suggestedAmount, currency) : '—'}
      </td>

      {/* Actual price input */}
      <td className="py-2 px-2 align-middle">
        {isHold ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            className="h-7 w-24 text-right tabular-nums text-xs"
            value={execution.actualPrice}
            onChange={e => onExecutionChange({ ...execution, actualPrice: e.target.value })}
          />
        )}
      </td>

      {/* Actual shares input */}
      <td className="py-2 px-2 align-middle">
        {isHold ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="0"
            className="h-7 w-20 text-right tabular-nums text-xs"
            value={execution.actualShares}
            onChange={e => onExecutionChange({ ...execution, actualShares: e.target.value })}
          />
        )}
      </td>

      {/* Actual cost input */}
      <td className="py-2 px-2 align-middle">
        {isHold ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            className="h-7 w-24 text-right tabular-nums text-xs"
            value={execution.actualCost}
            onChange={e => onExecutionChange({ ...execution, actualCost: e.target.value })}
          />
        )}
      </td>

      {/* Fees input */}
      <td className="py-2 px-2 align-middle">
        {isHold ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="0"
            className="h-7 w-20 text-right tabular-nums text-xs"
            value={execution.fees}
            onChange={e => onExecutionChange({ ...execution, fees: e.target.value })}
          />
        )}
      </td>

      {/* Ratio Change */}
      <td className="py-2.5 px-2 align-middle text-right tabular-nums">
        <div className="text-[10px] text-muted-foreground">
          {currentAllocationPct.toFixed(1)}%→{projectedAllocationPct.toFixed(1)}%
          <span className="opacity-60">/{targetAllocationPct.toFixed(1)}%</span>
        </div>
      </td>

      {/* Status */}
      <td className="py-2.5 px-2 pr-3 align-middle text-center">
        {isHold ? null : filled
          ? <CheckCircle2 className="h-4 w-4 text-emerald-500 dark:text-emerald-400 mx-auto" />
          : <Circle className="h-4 w-4 text-muted-foreground/40 mx-auto" />
        }
      </td>
    </tr>
  )
}

// ─── SectionCard ──────────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

// ─── DCAPlanner ───────────────────────────────────────────────────────────────

export default function DCAPlanner() {
  const portfolio          = usePortfolioStore(s => s.portfolio)
  const updatePortfolio    = usePortfolioStore(s => s.updatePortfolio)
  const setActiveTab       = useUIStore(s => s.setActiveTab)
  const portfolioId        = portfolio?.id
  const cashAccounts       = useCashAccounts(portfolioId)
  const holdings           = useActiveHoldings(portfolioId)
  const sleeves            = useSleeves(portfolioId)
  const driftSummary       = useDriftSummary(portfolioId)

  // sleeveId → sleeve name
  const sleeveMap = useMemo(
    () => new Map(sleeves.map(s => [s.id, s.name])),
    [sleeves],
  )

  // ── FX rate ─────────────────────────────────────────────────────────────────
  const latestOp = useLiveQuery(
    async () => {
      if (!portfolioId) return undefined
      return db.operations
        .where('[portfolioId+timestamp]')
        .between([portfolioId, Dexie.minKey], [portfolioId, Dexie.maxKey])
        .reverse()
        .first()
    },
    [portfolioId],
  )
  const fxRate =
    latestOp?.snapshotAfter?.currentFxRate ??
    portfolio?.fxRateOverride ??
    portfolio?.initialFxRate ??
    1

  // ── Planner settings (persisted) ────────────────────────────────────────────
  const [strategy, setStrategyLocal] = useState<RebalanceStrategy>(
    () => portfolio?.defaultRebalanceStrategy ?? 'soft',
  )
  const [method, setMethodLocal] = useState<AllocationMethod>(
    () => portfolio?.defaultAllocationMethod ?? 'proportional-to-drift',
  )

  async function handleStrategyChange(s: RebalanceStrategy) {
    setStrategyLocal(s)
    await updatePortfolio({ defaultRebalanceStrategy: s })
  }

  async function handleMethodChange(m: AllocationMethod) {
    setMethodLocal(m)
    await updatePortfolio({ defaultAllocationMethod: m })
  }

  // ── Budget (session-only) ────────────────────────────────────────────────────
  const [budgetStr, setBudgetStr] = useState(
    () => portfolio?.monthlyDCABudget ? String(portfolio.monthlyDCABudget) : '',
  )
  const [budgetCurrency, setBudgetCurrency] = useState<'USD' | 'TWD'>(
    () => portfolio?.monthlyDCABudgetCurrency ?? 'TWD',
  )

  // ── Plan generation ─────────────────────────────────────────────────────────
  const [planGenerated, setPlanGenerated] = useState(false)

  const cashBalances = useMemo(() => ({
    twd: cashAccounts.find(a => a.currency === 'TWD')?.balance ?? 0,
    usd: cashAccounts.find(a => a.currency === 'USD')?.balance ?? 0,
  }), [cashAccounts])

  const budget = parseFloat(budgetStr) || 0

  const holdingStates = useMemo(
    () => calculateCurrentAllocations(holdings, fxRate),
    [holdings, fxRate],
  )

  // holdingId → sleeve name (via holdingState.sleeveId)
  const holdingSleeveNameMap = useMemo(
    () => new Map(holdingStates.map(h => [h.holdingId, sleeveMap.get(h.sleeveId) ?? ''])),
    [holdingStates, sleeveMap],
  )

  const minimumBuyAmounts = useMemo((): MinimumBuyAmounts => ({
    usd: portfolio?.minimumBuyAmountUSD ?? 0,
    twd: portfolio?.minimumBuyAmountTWD ?? 0,
  }), [portfolio?.minimumBuyAmountUSD, portfolio?.minimumBuyAmountTWD])

  const plan = useMemo(() => {
    if (!planGenerated || holdingStates.length === 0) return null
    return generateRebalancePlan(
      holdingStates,
      budget,
      budgetCurrency,
      fxRate,
      strategy,
      method,
      cashBalances,
      minimumBuyAmounts,
    )
  }, [planGenerated, holdingStates, budget, budgetCurrency, fxRate, strategy, method, cashBalances, minimumBuyAmounts])

  // ── Pre-generation advisories ────────────────────────────────────────────────
  const noPriceCount = useMemo(
    () => holdingStates.filter(h => h.currentPricePerShare <= 0).length,
    [holdingStates],
  )

  // Sorted trades: SELL first, BUY second, HOLD last
  const sortedTrades = useMemo(
    () => [...(plan?.trades ?? [])].sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]),
    [plan],
  )
  const activeTrades = sortedTrades.filter(t => t.action !== 'HOLD')
  const holdTrades   = sortedTrades.filter(t => t.action === 'HOLD')

  // ── Post-generation advisories ───────────────────────────────────────────────
  const currencyMismatchNote = useMemo(() => {
    if (!plan) return null
    const usdBuys = activeTrades.filter(t => t.action === 'BUY' && t.currency === 'USD').length
    const twdBuys = activeTrades.filter(t => t.action === 'BUY' && t.currency === 'TWD').length
    if (budgetCurrency === 'TWD' && usdBuys > 0) {
      return `Budget is in TWD but ${usdBuys} trade${usdBuys > 1 ? 's' : ''} require${usdBuys === 1 ? 's' : ''} USD. These will draw from your USD cash balance — you may need to exchange currency first.`
    }
    if (budgetCurrency === 'USD' && twdBuys > 0) {
      return `Budget is in USD but ${twdBuys} trade${twdBuys > 1 ? 's' : ''} require${twdBuys === 1 ? 's' : ''} TWD. These will draw from your TWD cash balance — you may need to exchange currency first.`
    }
    return null
  }, [plan, activeTrades, budgetCurrency])

  // ── Execution inputs ─────────────────────────────────────────────────────────
  const [executions, setExecutions] = useState<Record<string, RowExecution>>({})

  const updateExecution = useCallback((id: string, next: RowExecution) => {
    setExecutions(prev => ({ ...prev, [id]: next }))
  }, [])

  const filledCount = activeTrades.filter(t => {
    const exec = executions[t.holdingId]
    return exec && parseFloat(exec.actualShares) > 0 && parseFloat(exec.actualCost) > 0
  }).length

  // Pre-fill execution inputs on explicit generate
  function handleGeneratePlan() {
    const prefilled: Record<string, RowExecution> = {}
    for (const state of holdingStates) {
      prefilled[state.holdingId] = {
        actualPrice: state.currentPricePerShare > 0 ? String(state.currentPricePerShare) : '',
        actualShares: '',
        actualCost: '',
        fees: '0',
      }
    }
    setExecutions(prefilled)
    setPlanGenerated(true)
    setSaved(false)
    setSaveError(null)
    setProceedDespiteInsufficient(false)
    setLoggedCount(null)
  }

  // ── Cash sufficiency gate ────────────────────────────────────────────────────
  const [proceedDespiteInsufficient, setProceedDespiteInsufficient] = useState(false)
  const cashOk = !plan || plan.cashSufficiency.sufficient || proceedDespiteInsufficient

  // ── Log All ──────────────────────────────────────────────────────────────────
  const [rationale, setRationale]   = useState('')
  const [tag, setTag]               = useState('')
  const [dcaDatetime, setDcaDatetime] = useState(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [saving, setSaving]         = useState(false)
  const [saveError, setSaveError]   = useState<string | null>(null)
  const [saved, setSaved]           = useState(false)
  const [loggedCount, setLoggedCount] = useState<number | null>(null)

  async function handleLogAll() {
    if (!portfolioId || !plan) return
    if (rationale.trim().length < 10) {
      setSaveError('Rationale must be at least 10 characters.')
      return
    }
    if (!cashOk) {
      setSaveError('Cash is insufficient. Check "Proceed anyway" to override.')
      return
    }
    const timestamp = dcaDatetime ? new Date(dcaDatetime) : new Date()
    if (isNaN(timestamp.getTime())) { setSaveError('Invalid date/time.'); return }
    if (timestamp > new Date()) { setSaveError('Date cannot be in the future.'); return }

    const entries = activeTrades
      .map(t => {
        const exec        = executions[t.holdingId]
        const shares      = parseFloat(exec?.actualShares ?? '') || 0
        const cost        = parseFloat(exec?.actualCost   ?? '') || 0
        const fees        = parseFloat(exec?.fees ?? '') || 0
        if (shares <= 0 || cost <= 0) return null
        const pricePerShare = cost / shares
        return { holdingId: t.holdingId, side: t.action as 'BUY' | 'SELL', shares, pricePerShare, fees }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)

    if (entries.length === 0) {
      setSaveError('Enter actual prices for at least one trade before logging.')
      return
    }

    const opType: OperationType = strategy === 'hard' ? 'REBALANCE' : 'DCA'

    setSaving(true); setSaveError(null)
    try {
      await createTradeOperation(portfolioId, {
        type: opType,
        entries,
        rationale: rationale.trim(),
        tag: tag.trim() || undefined,
        timestamp,
      })
      // auto-archive result is available but DCA planner doesn't show toasts — handled by OperationLogger
      setLoggedCount(entries.length)
      setSaved(true)
      setRationale(''); setTag(''); setExecutions({})
      setPlanGenerated(false)
    } catch (err) {
      if (err instanceof InsufficientCashError)        setSaveError(`Insufficient cash: ${err.message}`)
      else if (err instanceof InsufficientSharesError) setSaveError(`Insufficient shares: ${err.message}`)
      else if (err instanceof Error)                   setSaveError(err.message)
      else                                             setSaveError('Something went wrong.')
    } finally {
      setSaving(false)
    }
  }

  // ── Clipboard copy ───────────────────────────────────────────────────────────
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    const header = 'Action\tTicker\tCurrency\tEst. Cost\tActual Price\tActual Shares\tActual Cost\tFees'
    const rows = activeTrades.map(t => {
      const exec = executions[t.holdingId]
      return [
        t.action,
        t.ticker,
        t.currency,
        t.suggestedAmount > 0 ? t.suggestedAmount.toFixed(2) : '',
        exec?.actualPrice ?? '',
        exec?.actualShares ?? '',
        exec?.actualCost ?? '',
        exec?.fees ?? '0',
      ].join('\t')
    })
    void navigator.clipboard.writeText([header, ...rows].join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (!portfolio) return null

  return (
    <div className="flex flex-col pb-28">

      {/* ── 1. Header ──────────────────────────────────────────────────────── */}
      <div className="px-4 pt-5 pb-4 border-b border-border">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">DCA Planner</h1>
          <span className="text-sm text-muted-foreground">{currentMonthYear()}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Plan your monthly rebalance, then log execution with one tap.
        </p>
      </div>

      <div className="px-4 pt-4 space-y-4">

        {/* ── Drift Banner ─────────────────────────────────────────────────── */}
        {driftSummary && driftSummary.summary.overallHealth !== 'healthy' && (
          <button
            type="button"
            onClick={() => setActiveTab('dashboard')}
            className={cn(
              'w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs transition-colors',
              driftSummary.summary.overallHealth === 'action-needed'
                ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
                : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800',
            )}
          >
            {driftSummary.summary.overallHealth === 'action-needed'
              ? <XCircle className="h-4 w-4 shrink-0" />
              : <AlertTriangle className="h-4 w-4 shrink-0" />
            }
            <span className="flex-1 font-medium">
              {driftSummary.summary.overallHealth === 'action-needed'
                ? `${driftSummary.summary.criticalCount} holding${driftSummary.summary.criticalCount !== 1 ? 's' : ''} need rebalancing`
                : `${driftSummary.summary.warningCount} holding${driftSummary.summary.warningCount !== 1 ? 's' : ''} approaching drift threshold`
              }
            </span>
            <span className="shrink-0 opacity-70">View details →</span>
          </button>
        )}

        {/* ── 2 & 3. Strategy + Method (side by side on sm+) ──────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

          {/* Strategy */}
          <SectionCard title="Rebalance Strategy">
            <div className="space-y-2">
              <RadioCard
                selected={strategy === 'soft'}
                onSelect={() => handleStrategyChange('soft')}
                label="Soft Rebalance (buy-only)"
                subtitle="Add money to underweight holdings. No selling."
              />
              <RadioCard
                selected={strategy === 'hard'}
                onSelect={() => handleStrategyChange('hard')}
                label="Hard Rebalance (sell + buy)"
                subtitle="Sell overweight, buy underweight. Minimizes drift."
              />
            </div>
          </SectionCard>

          {/* Allocation Method */}
          <SectionCard title="Allocation Method">
            <div className="space-y-2">
              <RadioCard
                selected={method === 'proportional-to-drift'}
                onSelect={() => handleMethodChange('proportional-to-drift')}
                label="Proportional to Drift"
                subtitle="More money to the most underweight positions."
              />
              <RadioCard
                selected={method === 'equal-weight'}
                onSelect={() => handleMethodChange('equal-weight')}
                label="Equal Weight"
                subtitle="Split evenly across all underweight holdings."
              />
            </div>
          </SectionCard>

        </div>

        {/* ── 4. Budget + Generate Plan ───────────────────────────────────── */}
        <SectionCard title="This Month's DCA Budget">
          <div className="space-y-3">
            {/* Amount + currency */}
            <div className="flex gap-2">
              <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
                {(['TWD', 'USD'] as const).map(c => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => setBudgetCurrency(c)}
                    className={cn(
                      'px-3 py-2 text-sm font-medium transition-colors',
                      budgetCurrency === c
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <Input
                type="number"
                min="0"
                step="any"
                placeholder={budgetCurrency === 'TWD' ? '100,000' : '3,000'}
                className="flex-1 tabular-nums"
                value={budgetStr}
                onChange={e => setBudgetStr(e.target.value)}
              />
            </div>

            {/* Available cash */}
            <p className="text-xs text-muted-foreground">
              Available cash:&nbsp;
              <span className="font-medium text-foreground">{fmtCur(cashBalances.twd, 'TWD')}</span>
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              <span className="font-medium text-foreground">{fmtCur(cashBalances.usd, 'USD')}</span>
            </p>

            {/* Generate Plan button */}
            <Button
              className="w-full gap-2"
              disabled={holdings.length === 0}
              onClick={handleGeneratePlan}
            >
              <TrendingUp className="h-4 w-4" />
              {planGenerated ? 'Regenerate Plan' : 'Generate Plan'}
            </Button>

            {holdings.length === 0 && (
              <p className="text-xs text-center text-muted-foreground">
                Add holdings in Settings before generating a plan.
              </p>
            )}

            {/* No-price advisory (pre-generation) */}
            {noPriceCount > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                  {noPriceCount} holding{noPriceCount > 1 ? 's have' : ' has'} no price set — suggested amount will be shown.
                  Enter actual price and shares when logging.
                </p>
              </div>
            )}
          </div>
        </SectionCard>

        {/* ── Success banner ───────────────────────────────────────────────── */}
        {saved && loggedCount !== null && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                Logged {loggedCount} trade{loggedCount !== 1 ? 's' : ''} successfully.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('operations')}
              className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400 hover:underline shrink-0"
            >
              View in History
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* ── 5–10. Plan sections ─────────────────────────────────────────── */}
        {plan && (
          <>
            {/* ── 6. Cash sufficiency warning ─────────────────────────────── */}
            {!plan.cashSufficiency.sufficient && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                  <p className="text-sm font-medium text-destructive">Insufficient cash for this plan</p>
                </div>
                {plan.cashSufficiency.shortfalls.map(sf => (
                  <p key={sf.currency} className="text-xs text-destructive/80 pl-6 leading-relaxed">
                    {sf.shortfallConvertedHint}
                  </p>
                ))}
                <label className="flex items-center gap-2 pl-6 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-destructive"
                    checked={proceedDespiteInsufficient}
                    onChange={e => setProceedDespiteInsufficient(e.target.checked)}
                  />
                  <span className="text-xs text-destructive/80">Proceed anyway</span>
                </label>
              </div>
            )}

            {plan.cashSufficiency.sufficient && activeTrades.length > 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-2.5">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                  Cash sufficient for this plan.
                </p>
              </div>
            )}

            {/* Currency mismatch advisory (case 7) */}
            {currencyMismatchNote && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                <Info className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                  {currencyMismatchNote}
                </p>
              </div>
            )}

            {/* Engine warnings (skipped holdings, dust trades) */}
            {plan.warnings.length > 0 && (
              <div className="space-y-1">
                {plan.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">{w}</p>
                  </div>
                ))}
              </div>
            )}

            {/* ── 7. Plan Summary ─────────────────────────────────────────── */}
            {activeTrades.length > 0 && (
              <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                  Plan Summary
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {(plan.totalBuyCost.usd > 0 || plan.totalBuyCost.twd > 0) && (
                    <>
                      <span className="text-muted-foreground">Total buy cost</span>
                      <span className="tabular-nums font-medium text-right">
                        {[
                          plan.totalBuyCost.usd > 0 && fmtCur(plan.totalBuyCost.usd, 'USD'),
                          plan.totalBuyCost.twd > 0 && fmtCur(plan.totalBuyCost.twd, 'TWD'),
                        ].filter(Boolean).join(' + ')}
                      </span>
                    </>
                  )}
                  {(plan.totalSellProceeds.usd > 0 || plan.totalSellProceeds.twd > 0) && (
                    <>
                      <span className="text-muted-foreground">Total sell proceeds</span>
                      <span className="tabular-nums font-medium text-right">
                        {[
                          plan.totalSellProceeds.usd > 0 && fmtCur(plan.totalSellProceeds.usd, 'USD'),
                          plan.totalSellProceeds.twd > 0 && fmtCur(plan.totalSellProceeds.twd, 'TWD'),
                        ].filter(Boolean).join(' + ')}
                      </span>
                    </>
                  )}
                  <span className="text-muted-foreground">Net cash flow</span>
                  <span className="tabular-nums font-medium text-right">
                    {[
                      plan.netCashFlow.usd !== 0 && `${plan.netCashFlow.usd >= 0 ? '+' : ''}${fmtCur(plan.netCashFlow.usd, 'USD')}`,
                      plan.netCashFlow.twd !== 0 && `${plan.netCashFlow.twd >= 0 ? '+' : ''}${fmtCur(plan.netCashFlow.twd, 'TWD')}`,
                    ].filter(Boolean).join(' · ') || '—'}
                  </span>
                  <span className="text-muted-foreground">Trades</span>
                  <span className="font-medium text-right">
                    {activeTrades.filter(t => t.action === 'BUY').length} buy
                    {' · '}
                    {activeTrades.filter(t => t.action === 'SELL').length} sell
                    {holdTrades.length > 0 && ` · ${holdTrades.length} hold`}
                  </span>
                </div>
              </div>
            )}

            {/* ── 5. Trade Plan Table ─────────────────────────────────────── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-0.5">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Trade Plan
                </p>
                {activeTrades.length > 0 && (
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {copied
                      ? <><Check className="h-3 w-3 text-emerald-500 dark:text-emerald-400" /><span className="text-emerald-500 dark:text-emerald-400">Copied!</span></>
                      : <><Copy className="h-3 w-3" />Copy</>
                    }
                  </button>
                )}
              </div>

              {activeTrades.length === 0 ? (() => {
                // Distinguish between "all overweight" and "balanced/no budget"
                const someOverweight = plan.trades.some(t => t.reason.includes('Overweight'))
                return (
                  <div className="rounded-xl border border-border bg-card px-4 py-8 text-center space-y-2">
                    <RefreshCw className="h-5 w-5 text-muted-foreground mx-auto" />
                    {someOverweight ? (
                      <>
                        <p className="text-sm font-medium">All holdings at or above target</p>
                        <p className="text-xs text-muted-foreground">
                          {strategy === 'soft'
                            ? 'Soft rebalance never buys overweight holdings. Switch to Hard to trim them.'
                            : 'No underweight holdings to buy into.'}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium">Portfolio is balanced</p>
                        <p className="text-xs text-muted-foreground">No trades needed for the current settings.</p>
                      </>
                    )}
                  </div>
                )
              })() : (
                <div className="overflow-x-auto rounded-xl border border-border bg-card">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="py-2 pl-3 pr-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ticker</th>
                        <th className="py-2 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sleeve</th>
                        <th className="py-2 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Action</th>
                        <th className="py-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Est. Cost</th>
                        <th className="py-2 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Actual Price</th>
                        <th className="py-2 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Actual Shares</th>
                        <th className="py-2 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Actual Cost</th>
                        <th className="py-2 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fees</th>
                        <th className="py-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ratio Change</th>
                        <th className="py-2 px-2 pr-3 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeTrades.map(t => (
                        <TradeTableRow
                          key={t.holdingId}
                          trade={t}
                          sleeveName={holdingSleeveNameMap.get(t.holdingId) ?? ''}
                          execution={executions[t.holdingId] ?? { actualPrice: '', fees: '' }}
                          onExecutionChange={next => updateExecution(t.holdingId, next)}
                        />
                      ))}
                      {holdTrades.map(t => (
                        <TradeTableRow
                          key={t.holdingId}
                          trade={t}
                          sleeveName={holdingSleeveNameMap.get(t.holdingId) ?? ''}
                          execution={{ actualPrice: '', actualShares: '', actualCost: '', fees: '' }}
                          onExecutionChange={() => {}}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── 8 & 9. Rationale + Log All ──────────────────────────────── */}
            {activeTrades.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Log Execution
                </p>

                <div className="space-y-1">
                  <Label htmlFor="dca-datetime" className="text-xs text-muted-foreground">
                    Execution Date &amp; Time
                  </Label>
                  <input
                    id="dca-datetime"
                    type="datetime-local"
                    title="DCA execution date and time"
                    max={(() => {
                      const d = new Date()
                      const pad = (n: number) => String(n).padStart(2, '0')
                      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
                    })()}
                    value={dcaDatetime}
                    onChange={e => { setDcaDatetime(e.target.value); setSaveError(null) }}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    Rationale <span className="text-destructive">*</span>
                  </Label>
                  <textarea
                    rows={3}
                    placeholder={`Monthly DCA — ${currentMonthYear()}. Market conditions: `}
                    className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={rationale}
                    onChange={e => { setRationale(e.target.value); setSaveError(null); setSaved(false) }}
                  />
                  <p className="text-[10px] text-muted-foreground text-right">
                    {rationale.trim().length} / 10 min chars
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Tag (optional)</Label>
                  <Input
                    placeholder="e.g. monthly-dca, rebalance-q1"
                    value={tag}
                    onChange={e => setTag(e.target.value)}
                  />
                </div>

                {saveError && (
                  <p className="text-sm text-destructive">{saveError}</p>
                )}

                {/* ── 9. Log All button ─────────────────────────────────── */}
                <Button
                  className="w-full"
                  disabled={saving || filledCount === 0 || rationale.trim().length < 10 || !cashOk}
                  onClick={handleLogAll}
                >
                  {saving
                    ? 'Logging…'
                    : filledCount === 0
                      ? 'Fill in price and shares to log'
                      : !cashOk
                        ? 'Check "Proceed anyway" to log'
                        : rationale.trim().length < 10
                          ? 'Add rationale to log'
                          : `Log All Trades (${filledCount} / ${activeTrades.length} filled)`
                  }
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  Only rows with actual prices entered will be logged.
                </p>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  )
}
