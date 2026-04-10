import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Trash2, Check, Loader2, AlertTriangle, MinusCircle, RotateCcw, Archive, Search } from 'lucide-react'
import { useTickerSearch, detectCurrency } from '@/services/yahooFinance'
import { IBKRImport } from './IBKRImport'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { captureAndStoreSnapshot } from '@/services/autoSnapshot'
import { moveHoldingToLegacy, archiveHolding } from '@/db/holdingService'
import { restoreHolding } from '@/services/holdingLifecycle'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useDebouncedCallback } from '@/hooks/useDebounce'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Holding, Sleeve, CashAccount } from '@/types'

// ─── Draft types ──────────────────────────────────────────────────────────────
// Numeric fields are strings for controlled inputs; parsed to number on save.

interface DraftSleeve {
  id: string
  name: string
  color: string
  targetPct: string
}

interface DraftHolding {
  id: string
  sleeveId: string
  ticker: string
  name: string
  targetPct: string
  currency: 'USD' | 'TWD'
  driftThresholdPct: string
}

interface DraftCashAccount {
  id: string
  currency: 'USD' | 'TWD'
  balance: string
  // note is UI-only (CashAccount has no note field in the data model).
  // Full reconciliation with audit trail comes in Phase 3 (Operation logger).
  note: string
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toDraftSleeve(s: Sleeve): DraftSleeve {
  return { id: s.id, name: s.name, color: s.color, targetPct: String(s.targetAllocationPct) }
}

function toDraftHolding(h: Holding): DraftHolding {
  return {
    id: h.id, sleeveId: h.sleeveId,
    ticker: h.ticker, name: h.name,
    targetPct: String(h.targetAllocationPct),
    currency: h.currency,
    driftThresholdPct: String(h.driftThresholdPct),
  }
}

function toDraftCash(a: CashAccount): DraftCashAccount {
  return { id: a.id, currency: a.currency, balance: String(a.balance), note: '' }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SLEEVE_COLORS = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#f97316', '#10b981',
  '#ef4444', '#06b6d4', '#6366f1', '#ec4899', '#84cc16',
]

// ─── Save indicator ───────────────────────────────────────────────────────────

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null
  return (
    <div className={cn(
      'flex items-center gap-1.5 text-xs font-medium transition-opacity',
      status === 'saving' && 'text-muted-foreground',
      status === 'saved'  && 'text-emerald-600 dark:text-emerald-400',
      status === 'error'  && 'text-destructive',
    )}>
      {status === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'saved'  && <Check className="h-3 w-3" />}
      {status === 'error'  && <AlertTriangle className="h-3 w-3" />}
      {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save failed'}
    </div>
  )
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

// ─── DebugSection ─────────────────────────────────────────────────────────────

type DebugAction = 'operations' | 'snapshots' | 'full-reset'

function DebugSection({ portfolioId }: { portfolioId: string }) {
  const [confirming, setConfirming] = useState<DebugAction | null>(null)
  const [running, setRunning]       = useState(false)
  const [done, setDone]             = useState<DebugAction | null>(null)
  const loadPortfolio = usePortfolioStore(s => s.loadPortfolio)

  async function run(action: DebugAction) {
    setRunning(true)
    try {
      if (action === 'operations') {
        await db.transaction('rw', [
          db.operations, db.fxTransactions, db.fxLots, db.holdings, db.cashAccounts,
        ], async () => {
          await db.operations.where('portfolioId').equals(portfolioId).delete()
          const txIds = await db.fxTransactions
            .where('portfolioId').equals(portfolioId).primaryKeys() as string[]
          if (txIds.length) await db.fxLots.where('fxTransactionId').anyOf(txIds).delete()
          await db.fxTransactions.where('portfolioId').equals(portfolioId).delete()
          await db.holdings.where('portfolioId').equals(portfolioId).modify({
            currentShares: 0, currentPricePerShare: 0,
            averageCostBasis: 0, averageCostBasisBase: 0,
          })
          await db.cashAccounts.where('portfolioId').equals(portfolioId).modify({ balance: 0 })
        })
        setDone(action)
        setTimeout(() => setDone(null), 3000)
      } else if (action === 'snapshots') {
        await db.snapshots.where('portfolioId').equals(portfolioId).delete()
        setDone(action)
        setTimeout(() => setDone(null), 3000)
      } else {
        // full-reset: wipe ALL portfolio-mode data so the setup wizard re-appears
        await db.transaction('rw', [
          db.operations, db.fxTransactions, db.fxLots,
          db.holdings, db.cashAccounts, db.sleeves,
          db.snapshots, db.ammunitionPools, db.portfolios,
        ], async () => {
          await db.operations.where('portfolioId').equals(portfolioId).delete()
          const txIds = await db.fxTransactions
            .where('portfolioId').equals(portfolioId).primaryKeys() as string[]
          if (txIds.length) await db.fxLots.where('fxTransactionId').anyOf(txIds).delete()
          await db.fxTransactions.where('portfolioId').equals(portfolioId).delete()
          await db.snapshots.where('portfolioId').equals(portfolioId).delete()
          await db.ammunitionPools.where('portfolioId').equals(portfolioId).delete()
          await db.holdings.where('portfolioId').equals(portfolioId).delete()
          await db.cashAccounts.where('portfolioId').equals(portfolioId).delete()
          await db.sleeves.where('portfolioId').equals(portfolioId).delete()
          await db.portfolios.where('id').equals(portfolioId).delete()
        })
        // portfolio is now gone → store becomes undefined → App shows <SetupWizard />
        await loadPortfolio()
      }
    } finally {
      setRunning(false)
      setConfirming(null)
    }
  }

  const ACTIONS: { id: DebugAction; label: string; detail: string }[] = [
    {
      id: 'operations',
      label: 'Clear all operations',
      detail: 'Deletes all operations, FX transactions, and FX lots. Resets all holding positions and cash balances to 0. Holdings and sleeves are kept.',
    },
    {
      id: 'snapshots',
      label: 'Clear all snapshots',
      detail: 'Deletes all portfolio snapshots. The chart will be empty until a new snapshot is captured.',
    },
    {
      id: 'full-reset',
      label: 'Full reset',
      detail: 'Wipes all data for this portfolio — operations, FX data, snapshots, holdings, sleeves, and the portfolio definition itself. The setup wizard will re-open so you can start fresh.',
    },
  ]

  return (
    <SettingsSection
      title="Debug"
      description="Destructive utilities for testing. Cannot be undone."
    >
      <div className="space-y-3">
        {ACTIONS.map(({ id, label, detail }) => (
          <div
            key={id}
            className={cn(
              'rounded-lg border p-3 space-y-2 transition-colors',
              confirming === id ? 'border-destructive/50 bg-destructive/5' : 'border-border',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{detail}</p>
              </div>
              {confirming !== id && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs shrink-0 text-destructive border-destructive/40 hover:bg-destructive/10"
                  onClick={() => setConfirming(id)}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  {done === id ? <><Check className="h-3 w-3 mr-1" />Done</> : 'Clear'}
                </Button>
              )}
            </div>
            {confirming === id && (
              <div className="flex items-center gap-2 pt-1">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
                <p className="text-xs text-destructive flex-1">This cannot be undone.</p>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  disabled={running}
                  onClick={() => run(id)}
                >
                  {running && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={running}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </SettingsSection>
  )
}

// ─── DataSection ──────────────────────────────────────────────────────────────

function DataSection({ portfolioId }: { portfolioId: string }) {
  const [capturing, setCapturing] = useState(false)
  const [justCaptured, setJustCaptured] = useState(false)

  const latestSnapshot = useLiveQuery(
    () => db.snapshots
      .where('portfolioId').equals(portfolioId)
      .sortBy('timestamp')
      .then(snaps => snaps[snaps.length - 1] ?? null),
    [portfolioId],
  )

  async function handleCapture() {
    setCapturing(true)
    try {
      await captureAndStoreSnapshot(portfolioId)
      setJustCaptured(true)
      setTimeout(() => setJustCaptured(false), 2500)
    } finally {
      setCapturing(false)
    }
  }

  const fmtTs = (ts: Date | string) =>
    new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })

  return (
    <SettingsSection
      title="Data"
      description="Manual and automatic portfolio snapshots. A snapshot is captured automatically every 7 days when the app is opened."
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Last snapshot</p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {latestSnapshot === undefined && 'Loading…'}
            {latestSnapshot === null      && 'No snapshots yet'}
            {latestSnapshot != null       && fmtTs(latestSnapshot.timestamp)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs shrink-0"
          onClick={handleCapture}
          disabled={capturing}
        >
          {capturing && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
          {justCaptured ? <><Check className="h-3 w-3 mr-1" />Captured</> : 'Capture Now'}
        </Button>
      </div>
    </SettingsSection>
  )
}

// ─── SettingsSection ──────────────────────────────────────────────────────────

function SettingsSection({
  title, description, children,
}: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Card>
        <CardContent className="pt-5 pb-5 space-y-4">{children}</CardContent>
      </Card>
    </section>
  )
}

// ─── Color picker swatch ──────────────────────────────────────────────────────

function ColorSwatch({
  value, onChange,
}: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="relative group shrink-0">
      <div
        className="h-7 w-7 cursor-pointer rounded-full border-2 border-white shadow-sm"
        style={{ backgroundColor: value }}
      />
      <div className="absolute left-0 top-9 z-20 hidden group-focus-within:grid group-hover:grid grid-cols-5 gap-1 rounded-lg border bg-background p-2 shadow-lg">
        {SLEEVE_COLORS.map((c) => (
          <button
            key={c} type="button"
            onClick={() => onChange(c)}
            className={cn(
              'h-5 w-5 rounded-full border-2 transition-transform hover:scale-110',
              value === c ? 'border-foreground' : 'border-transparent',
            )}
            style={{ backgroundColor: c }}
            aria-label={c}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Holding row ──────────────────────────────────────────────────────────────

function HoldingRow({
  holding, onChange, onRemove, onMoveToLegacy,
}: {
  holding: DraftHolding
  onChange: (patch: Partial<DraftHolding>) => void
  onRemove: () => void
  onMoveToLegacy?: () => void
}) {
  const [tickerQuery, setTickerQuery] = useState(holding.ticker)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { results, isLoading } = useTickerSearch(tickerQuery)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const showDropdown = dropdownOpen && results.length > 0

  return (
    <div className="grid grid-cols-[60px_1fr_70px_60px_52px_28px_28px] items-start gap-1.5">
      {/* Ticker — with search dropdown */}
      <div className="relative" ref={wrapperRef}>
        <div className="relative">
          <Input
            value={tickerQuery}
            onChange={(e) => {
              const v = e.target.value.toUpperCase()
              setTickerQuery(v)
              onChange({ ticker: v })
              setDropdownOpen(true)
            }}
            onFocus={() => setDropdownOpen(true)}
            placeholder="VOO"
            className="text-xs font-mono h-9 pr-6"
          />
          {isLoading && (
            <Search className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground animate-pulse" />
          )}
        </div>
        {showDropdown && (
          <div className="absolute top-full left-0 z-50 mt-0.5 w-64 rounded-md border border-border bg-popover shadow-md">
            {results.map((r) => (
              <button
                key={r.ticker}
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent transition-colors"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const currency = detectCurrency(r)
                  onChange({ ticker: r.ticker, name: r.name, currency })
                  setTickerQuery(r.ticker)
                  setDropdownOpen(false)
                }}
              >
                <span className="font-mono text-xs font-semibold text-primary w-16 shrink-0 truncate">{r.ticker}</span>
                <span className="flex-1 text-xs truncate">{r.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{r.exchange}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <Input
        value={holding.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="Fund name"
        className="text-xs h-9"
      />
      <div className="relative">
        <Input
          type="number" min={0} max={100} step={0.5}
          value={holding.targetPct}
          onChange={(e) => onChange({ targetPct: e.target.value })}
          className="pr-4 text-right text-xs h-9"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
      </div>
      <Select
        value={holding.currency}
        onValueChange={(v) => onChange({ currency: v as 'USD' | 'TWD' })}
      >
        <SelectTrigger className="h-9 text-xs px-2"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="USD">USD</SelectItem>
          <SelectItem value="TWD">TWD</SelectItem>
        </SelectContent>
      </Select>
      <div className="relative">
        <Input
          type="number" min={0.5} max={20} step={0.5}
          value={holding.driftThresholdPct}
          onChange={(e) => onChange({ driftThresholdPct: e.target.value })}
          className="pr-4 text-right text-xs h-9"
        />
        <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
      </div>
      <button
        type="button" onClick={onRemove}
        className="flex h-8 w-7 items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors"
        aria-label="Remove holding"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {onMoveToLegacy ? (
        <button
          type="button" onClick={onMoveToLegacy}
          className="flex h-8 w-7 items-center justify-center rounded text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
          aria-label="Move to legacy"
          title="Move to Legacy — excludes from DCA and drift"
        >
          <MinusCircle className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PortfolioSettings({ portfolioId }: { portfolioId: string }) {
  const portfolio     = usePortfolioStore((s) => s.portfolio)!
  const updatePortfolio = usePortfolioStore((s) => s.updatePortfolio)

  // ── Local draft state ────────────────────────────────────────────────────
  const [portfolioName,  setPortfolioName]  = useState(portfolio.name)
  const [localSleeves,   setLocalSleeves]   = useState<DraftSleeve[]>([])
  const [localHoldings,  setLocalHoldings]  = useState<DraftHolding[]>([])
  const [cashAccounts,   setCashAccounts]   = useState<DraftCashAccount[]>([])
  const [dcaBudget,      setDcaBudget]      = useState(String(portfolio.monthlyDCABudget))
  const [dcaCurrency,    setDcaCurrency]    = useState(portfolio.monthlyDCABudgetCurrency)
  const [strategy,       setStrategy]       = useState(portfolio.defaultRebalanceStrategy)
  const [method,         setMethod]         = useState(portfolio.defaultAllocationMethod)
  const [minBuyUSD,      setMinBuyUSD]      = useState(String(portfolio.minimumBuyAmountUSD ?? 0))
  const [minBuyTWD,      setMinBuyTWD]      = useState(String(portfolio.minimumBuyAmountTWD ?? 0))

  // Pending sleeve delete requires inline confirmation (when it has holdings)
  const [pendingDeleteSleeveId, setPendingDeleteSleeveId] = useState<string | null>(null)

  // ── Holdings tab state ───────────────────────────────────────────────────
  const [holdingsTab, setHoldingsTab] = useState<'active' | 'legacy' | 'archived'>('active')
  const [reactivateHoldingId, setReactivateHoldingId] = useState<string | null>(null)
  const [reactivateSleeve, setReactivateSleeve]       = useState('')
  const [reactivateTargetPct, setReactivateTargetPct] = useState('0')

  const legacyHoldings = useLiveQuery(
    () => db.holdings.where('portfolioId').equals(portfolioId)
      .filter(h => h.status === 'legacy').sortBy('ticker'),
    [portfolioId], [],
  ) as Holding[]

  const archivedHoldings = useLiveQuery(
    () => db.holdings.where('portfolioId').equals(portfolioId)
      .filter(h => h.status === 'archived').toArray()
      .then(arr => arr.sort((a, b) => {
        const ta = a.archivedAt ? new Date(a.archivedAt).getTime() : 0
        const tb = b.archivedAt ? new Date(b.archivedAt).getTime() : 0
        return tb - ta
      })),
    [portfolioId], [],
  ) as Holding[]

  // ── Save indicator ───────────────────────────────────────────────────────
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const indicateSave = useCallback(async (fn: () => Promise<void>) => {
    setSaveStatus('saving')
    try {
      await fn()
      setSaveStatus('saved')
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [])

  // ── One-time init from Dexie ─────────────────────────────────────────────
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    Promise.all([
      db.sleeves.where('portfolioId').equals(portfolioId).toArray(),
      db.holdings.where('portfolioId').equals(portfolioId)
        .filter(h => !h.status || h.status === 'active').sortBy('ticker'),
      db.cashAccounts.where('portfolioId').equals(portfolioId).toArray(),
    ]).then(([sleeves, holdings, cash]) => {
      setLocalSleeves(sleeves.map(toDraftSleeve))
      setLocalHoldings(holdings.map(toDraftHolding))
      setCashAccounts(cash.map(toDraftCash))
    })
  }, [portfolioId])

  // ── Save: sleeve + holdings structure ────────────────────────────────────
  // Uses delete-all-then-insert inside a transaction to handle adds, updates,
  // and removes in one shot without tracking individual dirty IDs.
  const persistSleeveStructure = useCallback(
    (sleeves: DraftSleeve[], holdings: DraftHolding[]) =>
      indicateSave(async () => {
        const dbSleeves: Sleeve[] = sleeves.map((s) => ({
          id: s.id, portfolioId,
          name: s.name, color: s.color,
          targetAllocationPct: parseFloat(s.targetPct) || 0,
        }))
        // Snapshot existing position-tracking fields before the delete so they
        // survive the structure save. These fields are written exclusively by
        // the operation logger and must never be reset by a settings edit.
        const existingHoldings = await db.holdings
          .where('portfolioId').equals(portfolioId)
          .toArray()
        const positionMap = new Map(existingHoldings.map(h => [h.id, {
          currentShares:        h.currentShares,
          currentPricePerShare: h.currentPricePerShare,
          averageCostBasis:     h.averageCostBasis,
          averageCostBasisBase: h.averageCostBasisBase,
        }]))

        const dbHoldings: Holding[] = holdings.map((h) => ({
          id: h.id, portfolioId, sleeveId: h.sleeveId,
          ticker: h.ticker.toUpperCase(), name: h.name,
          targetAllocationPct: parseFloat(h.targetPct) || 0,
          driftThresholdPct: parseFloat(h.driftThresholdPct) || 2,
          currency: h.currency,
          status: 'active' as const,
          // Restore position tracking fields (undefined = never traded, preserved as-is)
          ...positionMap.get(h.id),
        }))
        await db.transaction('rw', [db.sleeves, db.holdings], async () => {
          await db.sleeves.where('portfolioId').equals(portfolioId).delete()
          // Only delete+replace active holdings; legacy/archived are managed separately
          await db.holdings.where('portfolioId').equals(portfolioId)
            .filter(h => !h.status || h.status === 'active').delete()
          if (dbSleeves.length)  await db.sleeves.bulkAdd(dbSleeves)
          if (dbHoldings.length) await db.holdings.bulkAdd(dbHoldings)
        })
      }),
    [portfolioId, indicateSave],
  )

  const debouncedSaveStructure = useDebouncedCallback(persistSleeveStructure, 600)

  // ── Save: portfolio name ─────────────────────────────────────────────────
  const debouncedSaveName = useDebouncedCallback(
    (name: string) => indicateSave(() => updatePortfolio({ name })),
    500,
  )

  // ── Save: cash account balance ───────────────────────────────────────────
  const persistCash = useCallback(
    (id: string, balance: number) =>
      indicateSave(async () => { await db.cashAccounts.update(id, { balance }) }),
    [indicateSave],
  )
  const debouncedSaveCash = useDebouncedCallback(persistCash, 600)

  // ── Save: DCA settings ───────────────────────────────────────────────────
  const debouncedSaveDCA = useDebouncedCallback(
    (budget: string, currency: typeof dcaCurrency, strat: typeof strategy, meth: typeof method) =>
      indicateSave(() => updatePortfolio({
        monthlyDCABudget: parseFloat(budget) || 0,
        monthlyDCABudgetCurrency: currency,
        defaultRebalanceStrategy: strat,
        defaultAllocationMethod: meth,
      })),
    500,
  )

  // ── Save: minimum buy amounts ─────────────────────────────────────────────
  const debouncedSaveMinBuy = useDebouncedCallback(
    (usd: string, twd: string) =>
      indicateSave(() => updatePortfolio({
        minimumBuyAmountUSD: parseFloat(usd) || 0,
        minimumBuyAmountTWD: parseFloat(twd) || 0,
      })),
    500,
  )

  // ── Holding lifecycle helpers ─────────────────────────────────────────────

  async function moveToLegacy(holdingId: string) {
    await moveHoldingToLegacy(holdingId)
    const next = localHoldings.filter(h => h.id !== holdingId)
    setLocalHoldings(next)
    debouncedSaveStructure(localSleeves, next)
  }

  async function doArchive(holdingId: string) {
    await archiveHolding(holdingId)
  }

  async function doRestoreToLegacy(holdingId: string) {
    await restoreHolding(holdingId, 'legacy')
  }

  async function doRestoreToActive(holdingId: string) {
    if (!reactivateSleeve) return
    await restoreHolding(holdingId, 'active', {
      sleeveId: reactivateSleeve,
      targetAllocationPct: parseFloat(reactivateTargetPct) || 0,
    })
    setReactivateHoldingId(null)
    // Re-sync active holdings from Dexie into draft state
    const fresh = await db.holdings.where('portfolioId').equals(portfolioId)
      .filter(h => !h.status || h.status === 'active').sortBy('ticker')
    setLocalHoldings(fresh.map(toDraftHolding))
  }

  // ── Sleeve helpers ───────────────────────────────────────────────────────

  function updateSleeve(id: string, patch: Partial<DraftSleeve>) {
    const next = localSleeves.map((s) => s.id === id ? { ...s, ...patch } : s)
    setLocalSleeves(next)
    debouncedSaveStructure(next, localHoldings)
  }

  function addSleeve() {
    const usedColors = new Set(localSleeves.map((s) => s.color))
    const color = SLEEVE_COLORS.find((c) => !usedColors.has(c)) ?? SLEEVE_COLORS[0]!
    const newSleeve: DraftSleeve = { id: crypto.randomUUID(), name: '', color, targetPct: '0' }
    const next = [...localSleeves, newSleeve]
    setLocalSleeves(next)
    debouncedSaveStructure(next, localHoldings)
  }

  function requestDeleteSleeve(id: string) {
    const hasHoldings = localHoldings.some((h) => h.sleeveId === id)
    if (hasHoldings) {
      setPendingDeleteSleeveId(id)
    } else {
      confirmDeleteSleeve(id)
    }
  }

  function confirmDeleteSleeve(id: string) {
    const nextSleeves  = localSleeves.filter((s) => s.id !== id)
    const nextHoldings = localHoldings.filter((h) => h.sleeveId !== id)
    setLocalSleeves(nextSleeves)
    setLocalHoldings(nextHoldings)
    setPendingDeleteSleeveId(null)
    debouncedSaveStructure(nextSleeves, nextHoldings)
  }

  // ── Holding helpers ──────────────────────────────────────────────────────

  function addHolding(sleeveId: string) {
    const newHolding: DraftHolding = {
      id: crypto.randomUUID(), sleeveId,
      ticker: '', name: '', targetPct: '0', currency: 'USD', driftThresholdPct: '2',
    }
    const next = [...localHoldings, newHolding]
    setLocalHoldings(next)
    debouncedSaveStructure(localSleeves, next)
  }

  function updateHolding(id: string, patch: Partial<DraftHolding>) {
    const next = localHoldings.map((h) => h.id === id ? { ...h, ...patch } : h)
    setLocalHoldings(next)
    debouncedSaveStructure(localSleeves, next)
  }

  function removeHolding(id: string) {
    const next = localHoldings.filter((h) => h.id !== id)
    setLocalHoldings(next)
    debouncedSaveStructure(localSleeves, next)
  }

  // ── Validations ──────────────────────────────────────────────────────────

  const sleeveTotalPct = localSleeves.reduce((s, sl) => s + (parseFloat(sl.targetPct) || 0), 0)
  const sleeveTotalOk  = Math.abs(sleeveTotalPct - 100) < 0.01

  function sleeveHoldingStatus(sleeveId: string) {
    const sleeve   = localSleeves.find((s) => s.id === sleeveId)
    const holdings = localHoldings.filter((h) => h.sleeveId === sleeveId)
    if (!sleeve || holdings.length === 0) return null
    const used     = holdings.reduce((s, h) => s + (parseFloat(h.targetPct) || 0), 0)
    const target   = parseFloat(sleeve.targetPct) || 0
    const remaining = target - used
    return { remaining, ok: Math.abs(remaining) < 0.01 }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 px-4 py-6 pb-24">

      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <SaveIndicator status={saveStatus} />
      </div>

      {/* ── Portfolio name ─────────────────────────────────────────────── */}
      <SettingsSection
        title="Portfolio"
        description="Your portfolio's display name."
      >
        <div className="space-y-2">
          <Label htmlFor="portfolio-name">Name</Label>
          <Input
            id="portfolio-name"
            value={portfolioName}
            onChange={(e) => {
              setPortfolioName(e.target.value)
              debouncedSaveName(e.target.value)
            }}
          />
        </div>
        <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">Base currency</span>
          <span className="text-sm font-medium">TWD</span>
        </div>
      </SettingsSection>

      {/* ── Sleeves & Holdings ─────────────────────────────────────────── */}
      <SettingsSection
        title="Sleeves & Holdings"
        description="Grouped holdings with target allocations. Sleeve targets must sum to 100%."
      >
        {/* Tab switcher */}
        <div className="flex rounded-lg bg-muted p-1 gap-1">
          {(['active', 'legacy', 'archived'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setHoldingsTab(tab)}
              className={cn(
                'flex-1 py-1.5 text-xs rounded-md transition-colors capitalize flex items-center justify-center gap-1',
                holdingsTab === tab
                  ? 'bg-background text-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab}
              {tab === 'legacy' && legacyHoldings.length > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  {legacyHoldings.length}
                </span>
              )}
              {tab === 'archived' && archivedHoldings.length > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted-foreground/20 px-1 text-[10px] font-medium text-muted-foreground">
                  {archivedHoldings.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Active tab ─────────────────────────────────────────────────── */}
        {holdingsTab === 'active' && (<>

        {/* Sleeve total validation banner */}
        {!sleeveTotalOk && localSleeves.length > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Sleeve targets sum to {sleeveTotalPct.toFixed(1)}% — must equal 100%.
            </p>
            <Badge variant="warning" className="ml-auto shrink-0">
              {sleeveTotalPct.toFixed(1)}%
            </Badge>
          </div>
        )}

        {/* Sleeve list */}
        <div className="space-y-5">
          {localSleeves.map((sleeve) => {
            const sleeveHoldings = localHoldings.filter((h) => h.sleeveId === sleeve.id)
            const holdingStatus  = sleeveHoldingStatus(sleeve.id)
            const isPendingDelete = pendingDeleteSleeveId === sleeve.id

            return (
              <div key={sleeve.id} className="space-y-3">
                {/* Sleeve row */}
                <div className="flex items-center gap-2">
                  <ColorSwatch
                    value={sleeve.color}
                    onChange={(c) => updateSleeve(sleeve.id, { color: c })}
                  />
                  <Input
                    value={sleeve.name}
                    onChange={(e) => updateSleeve(sleeve.id, { name: e.target.value })}
                    placeholder="Sleeve name"
                    className="flex-1"
                  />
                  <div className="relative w-24 shrink-0">
                    <Input
                      type="number" min={0} max={100} step={1}
                      value={sleeve.targetPct}
                      onChange={(e) => updateSleeve(sleeve.id, { targetPct: e.target.value })}
                      className="pr-6 text-right"
                    />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => requestDeleteSleeve(sleeve.id)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-destructive transition-colors"
                    aria-label={`Remove ${sleeve.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Inline delete confirmation */}
                {isPendingDelete && (
                  <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <p className="text-xs text-destructive flex-1">
                      Delete "{sleeve.name}" and its {sleeveHoldings.length} holding{sleeveHoldings.length !== 1 ? 's' : ''}?
                    </p>
                    <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => confirmDeleteSleeve(sleeve.id)}>
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPendingDeleteSleeveId(null)}>
                      Cancel
                    </Button>
                  </div>
                )}

                {/* Holdings */}
                <div className="ml-9 space-y-2">
                  {/* Holdings column headers */}
                  {sleeveHoldings.length > 0 && (
                    <div className="grid grid-cols-[60px_1fr_70px_60px_52px_28px_28px] gap-1.5 px-0.5">
                      {['Ticker', 'Name', 'Target', 'CCY', 'Drift', '', ''].map((hdr, i) => (
                        <span key={i} className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{hdr}</span>
                      ))}
                    </div>
                  )}

                  {sleeveHoldings.map((h) => (
                    <HoldingRow
                      key={h.id}
                      holding={h}
                      onChange={(patch) => updateHolding(h.id, patch)}
                      onRemove={() => removeHolding(h.id)}
                      onMoveToLegacy={() => moveToLegacy(h.id)}
                    />
                  ))}

                  {/* Holdings total badge */}
                  {holdingStatus && (
                    <div className="flex items-center justify-end">
                      <Badge variant={holdingStatus.ok ? 'success' : holdingStatus.remaining < 0 ? 'destructive' : 'warning'} className="text-[10px]">
                        {holdingStatus.ok
                          ? 'Balanced'
                          : holdingStatus.remaining >= 0
                            ? `${holdingStatus.remaining.toFixed(1)}% remaining`
                            : `${Math.abs(holdingStatus.remaining).toFixed(1)}% over`}
                      </Badge>
                    </div>
                  )}

                  <Button
                    type="button" variant="ghost" size="sm"
                    onClick={() => addHolding(sleeve.id)}
                    className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add holding to {sleeve.name || 'this sleeve'}
                  </Button>
                </div>

                <Separator />
              </div>
            )
          })}
        </div>

        <Button type="button" variant="outline" size="sm" onClick={addSleeve} className="gap-2">
          <Plus className="h-4 w-4" /> Add sleeve
        </Button>

        </>)}

        {/* ── Legacy tab ──────────────────────────────────────────────────── */}
        {holdingsTab === 'legacy' && (
          <div className="space-y-3">
            {legacyHoldings.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No legacy holdings. Use "Move to Legacy" (
                <MinusCircle className="inline h-3 w-3" />
                ) on an active holding to exclude it from DCA and drift.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Legacy holdings remain in your portfolio but are excluded from DCA, drift alerts, and target allocation.
                </p>
                {legacyHoldings.map((h) => {
                  const shares     = h.currentShares ?? 0
                  const price      = h.currentPricePerShare ?? 0
                  const marketVal  = shares * price
                  const costBasis  = shares * (h.averageCostBasis ?? 0)
                  const pnl        = marketVal - costBasis
                  const pnlPct     = costBasis > 0 ? (pnl / costBasis) * 100 : 0
                  const isExpanded = reactivateHoldingId === h.id

                  return (
                    <div key={h.id} className="space-y-2">
                      <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-medium">{h.ticker}</span>
                            <span className="text-xs text-muted-foreground truncate">{h.name}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-xs text-muted-foreground">{shares.toFixed(4)} shares</span>
                            {marketVal > 0 && (
                              <span className="text-xs text-muted-foreground">
                                {h.currency === 'USD'
                                  ? `$${marketVal.toFixed(2)}`
                                  : `NT$${marketVal.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
                              </span>
                            )}
                            {costBasis > 0 && (
                              <span className={cn('text-xs', pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                                {pnl >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {shares === 0 && (
                            <Button size="sm" variant="ghost"
                              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => doArchive(h.id)}
                            >
                              <Archive className="h-3.5 w-3.5 mr-1" />Archive
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                            onClick={() => {
                              setReactivateHoldingId(isExpanded ? null : h.id)
                              setReactivateSleeve(''); setReactivateTargetPct('0')
                            }}
                          >
                            <RotateCcw className="h-3.5 w-3.5 mr-1" />Reactivate
                          </Button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="ml-4 flex items-end gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                          <div className="space-y-1 flex-1">
                            <Label className="text-xs">Sleeve</Label>
                            <Select value={reactivateSleeve} onValueChange={setReactivateSleeve}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select sleeve…" /></SelectTrigger>
                              <SelectContent>
                                {localSleeves.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1 w-24">
                            <Label className="text-xs">Target %</Label>
                            <div className="relative">
                              <Input type="number" min={0} max={100} step={0.5}
                                value={reactivateTargetPct}
                                onChange={e => setReactivateTargetPct(e.target.value)}
                                className="h-8 text-xs pr-5 text-right"
                              />
                              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
                            </div>
                          </div>
                          <Button size="sm" className="h-8 text-xs" disabled={!reactivateSleeve}
                            onClick={() => doRestoreToActive(h.id)}>Confirm</Button>
                          <Button size="sm" variant="ghost" className="h-8 text-xs"
                            onClick={() => setReactivateHoldingId(null)}>Cancel</Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Archived tab ─────────────────────────────────────────────────── */}
        {holdingsTab === 'archived' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border border-muted bg-muted/30 px-3 py-2">
              <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                Archived holdings have 0 shares. Historical operations are preserved.
              </p>
            </div>
            {archivedHoldings.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No archived holdings.</p>
            ) : (
              <div className="space-y-2">
                {archivedHoldings.map((h) => {
                  const isExpanded  = reactivateHoldingId === h.id
                  const archivedDate = h.archivedAt
                    ? new Date(h.archivedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                    : '—'

                  return (
                    <div key={h.id} className="space-y-2">
                      <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5 opacity-75">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-medium">{h.ticker}</span>
                            <span className="text-xs text-muted-foreground truncate">{h.name}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">Archived {archivedDate}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => doRestoreToLegacy(h.id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5 mr-1" />To Legacy
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                            onClick={() => {
                              setReactivateHoldingId(isExpanded ? null : h.id)
                              setReactivateSleeve(''); setReactivateTargetPct('0')
                            }}
                          >
                            To Active
                          </Button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="ml-4 flex items-end gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                          <div className="space-y-1 flex-1">
                            <Label className="text-xs">Sleeve</Label>
                            <Select value={reactivateSleeve} onValueChange={setReactivateSleeve}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select sleeve…" /></SelectTrigger>
                              <SelectContent>
                                {localSleeves.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1 w-24">
                            <Label className="text-xs">Target %</Label>
                            <div className="relative">
                              <Input type="number" min={0} max={100} step={0.5}
                                value={reactivateTargetPct}
                                onChange={e => setReactivateTargetPct(e.target.value)}
                                className="h-8 text-xs pr-5 text-right"
                              />
                              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
                            </div>
                          </div>
                          <Button size="sm" className="h-8 text-xs" disabled={!reactivateSleeve}
                            onClick={() => doRestoreToActive(h.id)}>Confirm</Button>
                          <Button size="sm" variant="ghost" className="h-8 text-xs"
                            onClick={() => setReactivateHoldingId(null)}>Cancel</Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

      </SettingsSection>

      {/* ── Cash Balances ──────────────────────────────────────────────── */}
      <SettingsSection
        title="Cash Balances"
        description="Adjust balances to match your brokerage account. Full reconciliation history via the Operations log."
      >
        {cashAccounts.length === 0 && (
          <p className="text-sm text-muted-foreground">No cash accounts found.</p>
        )}
        {cashAccounts.map((account, i) => (
          <div key={account.id} className="space-y-3">
            {i > 0 && <Separator />}
            <div className="space-y-2">
              <Label htmlFor={`cash-${account.currency}`}>
                {account.currency} balance
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                  {account.currency === 'TWD' ? 'NT$' : '$'}
                </span>
                <Input
                  id={`cash-${account.currency}`}
                  type="number" min={0}
                  step={account.currency === 'TWD' ? 1000 : 100}
                  value={account.balance}
                  onChange={(e) => {
                    const next = cashAccounts.map((a) =>
                      a.id === account.id ? { ...a, balance: e.target.value } : a,
                    )
                    setCashAccounts(next)
                    debouncedSaveCash(account.id, parseFloat(e.target.value) || 0)
                  }}
                  className={account.currency === 'TWD' ? 'pl-10' : 'pl-8'}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`note-${account.currency}`} className="text-muted-foreground font-normal">
                Reason for adjustment <span className="text-xs">(optional, not saved)</span>
              </Label>
              <Input
                id={`note-${account.currency}`}
                value={account.note}
                onChange={(e) => {
                  setCashAccounts(cashAccounts.map((a) =>
                    a.id === account.id ? { ...a, note: e.target.value } : a,
                  ))
                }}
                placeholder="e.g. reconciled with IBKR statement"
                className="text-sm"
              />
            </div>
          </div>
        ))}
      </SettingsSection>

      {/* ── DCA Defaults ───────────────────────────────────────────────── */}
      <SettingsSection
        title="DCA Defaults"
        description="Pre-filled values in the DCA Planner. Override per session."
      >
        {/* Budget */}
        <div className="space-y-2">
          <Label>Monthly DCA budget</Label>
          <div className="flex gap-2">
            <Select
              value={dcaCurrency}
              onValueChange={(v) => {
                const next = v as typeof dcaCurrency
                setDcaCurrency(next)
                debouncedSaveDCA(dcaBudget, next, strategy, method)
              }}
            >
              <SelectTrigger className="w-24 shrink-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="TWD">TWD</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number" min={0} step={100}
              value={dcaBudget}
              onChange={(e) => {
                setDcaBudget(e.target.value)
                debouncedSaveDCA(e.target.value, dcaCurrency, strategy, method)
              }}
              placeholder="e.g. 1000"
            />
          </div>
        </div>

        <Separator />

        {/* Strategy */}
        <div className="space-y-2">
          <Label>Default rebalance strategy</Label>
          <RadioGroup
            value={strategy}
            onValueChange={(v) => {
              const next = v as typeof strategy
              setStrategy(next)
              // Immediate save for radio (no debounce needed)
              void indicateSave(() => updatePortfolio({ defaultRebalanceStrategy: next }))
            }}
            className="gap-2"
          >
            {([
              ['soft', 'Soft rebalance (buy-only)', "Over-allocate DCA to underweight; don't sell anything."],
              ['hard', 'Hard rebalance (sell + buy)', 'Sell overweight, then buy underweight to restore targets.'],
              ['none', 'No rebalancing', 'Buy proportional to target allocation. Ignore current drift.'],
            ] as const).map(([value, label, description]) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors',
                  strategy === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                )}
              >
                <RadioGroupItem value={value} className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                </div>
              </label>
            ))}
          </RadioGroup>
        </div>

        <Separator />

        {/* Allocation method */}
        <div className="space-y-2">
          <Label>Default allocation method</Label>
          <RadioGroup
            value={method}
            onValueChange={(v) => {
              const next = v as typeof method
              setMethod(next)
              void indicateSave(() => updatePortfolio({ defaultAllocationMethod: next }))
            }}
            className="gap-2"
          >
            {([
              ['proportional-to-drift', 'Proportional to drift', 'More budget to the most underweight holdings.'],
              ['equal-weight',          'Equal weight',          'Split budget evenly across all underweight holdings.'],
            ] as const).map(([value, label, description]) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors',
                  method === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                )}
              >
                <RadioGroupItem value={value} className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                </div>
              </label>
            ))}
          </RadioGroup>
        </div>

        <Separator />

        {/* Minimum buy amount */}
        <div className="space-y-2">
          <Label>Minimum buy amount per trade</Label>
          <p className="text-xs text-muted-foreground">
            Trades below this amount are skipped and their budget redistributed to the remaining holdings. Set to 0 to disable.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="min-buy-usd" className="text-xs text-muted-foreground">USD holdings</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">$</span>
                <Input
                  id="min-buy-usd"
                  type="number"
                  min={0}
                  step={10}
                  value={minBuyUSD}
                  onChange={(e) => {
                    setMinBuyUSD(e.target.value)
                    debouncedSaveMinBuy(e.target.value, minBuyTWD)
                  }}
                  placeholder="e.g. 30"
                  className="pl-7"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="min-buy-twd" className="text-xs text-muted-foreground">TWD holdings</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">NT$</span>
                <Input
                  id="min-buy-twd"
                  type="number"
                  min={0}
                  step={100}
                  value={minBuyTWD}
                  onChange={(e) => {
                    setMinBuyTWD(e.target.value)
                    debouncedSaveMinBuy(minBuyUSD, e.target.value)
                  }}
                  placeholder="e.g. 1000"
                  className="pl-10"
                />
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>

      <DataSection portfolioId={portfolioId} />

      {/* ── Import ─────────────────────────────────────────────────── */}
      <SettingsSection
        title="Import from IBKR"
        description="Import trades from an IBKR Activity Statement CSV. Each trade row creates one Operation. Unrecognised symbols are auto-created as Legacy holdings."
      >
        <IBKRImport portfolioId={portfolioId} />
      </SettingsSection>

      <DebugSection portfolioId={portfolioId} />

    </div>
  )
}
