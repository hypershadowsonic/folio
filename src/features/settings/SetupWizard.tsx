/**
 * SetupWizard — first-run portfolio configuration wizard.
 *
 * Two setup modes:
 *   'manual' — User defines sleeves, holdings, and allocations by hand.
 *   'ibkr'   — User uploads an IBKR Activity Statement CSV; tickers are extracted
 *              for the user to assign sleeves/allocations, then all trades are
 *              imported automatically on completion.
 *
 * Both modes share the same 6-step structure (steps 4-6 are identical).
 */
import { useState, useRef } from 'react'
import { Plus, Trash2, ChevronRight, ChevronLeft, Check, Upload, FileText, X } from 'lucide-react'
import { db } from '@/db/database'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore } from '@/stores/uiStore'
import { parseIBKRActivityCSV, decodeCSVBuffer } from '@/lib/ibkrParser'
import { createTradeOperation } from '@/db/operationService'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { IBKRTrade } from '@/lib/ibkrParser'
import type { Portfolio, Holding, Sleeve, CashAccount, FxTransaction } from '@/types'

// ─── Draft types (pre-save, using string inputs for forms) ────────────────────

interface DraftSleeve {
  id: string
  name: string
  color: string
  targetPct: string          // string for form binding, parsed on save
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

interface DraftIBKRTicker {
  ticker: string
  currency: 'USD' | 'TWD'
  sleeveName: string         // freeform; multiple tickers share a sleeve by name
  targetPct: string
  include: boolean           // user can exclude certain tickers
  status: 'active' | 'legacy'  // active = part of strategy; legacy = held but excluded from DCA
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SLEEVE_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#f97316', // orange
  '#10b981', // emerald
  '#ef4444', // red
  '#06b6d4', // cyan
  '#6366f1', // indigo
  '#ec4899', // pink
  '#84cc16', // lime
]

const DEFAULT_SLEEVES: DraftSleeve[] = [
  { id: crypto.randomUUID(), name: 'Core',         color: '#3b82f6', targetPct: '50' },
  { id: crypto.randomUUID(), name: 'Thematic',     color: '#8b5cf6', targetPct: '20' },
  { id: crypto.randomUUID(), name: 'Tactical',     color: '#f59e0b', targetPct: '10' },
  { id: crypto.randomUUID(), name: 'Alternatives', color: '#f97316', targetPct: '10' },
  { id: crypto.randomUUID(), name: 'Cash',         color: '#10b981', targetPct: '10' },
]

const TOTAL_STEPS = 6
const MANUAL_STEP_LABELS = ['Name', 'Sleeves', 'Holdings', 'Cash', 'DCA', 'Review']
const IBKR_STEP_LABELS   = ['Name', 'Upload',  'Configure', 'Cash', 'DCA', 'Review']

function inferCurrency(ticker: string): 'USD' | 'TWD' {
  return /^\d/.test(ticker) ? 'TWD' : 'USD'
}

// ─── Progress indicator ───────────────────────────────────────────────────────

function WizardProgress({ current, labels }: { current: number; labels: string[] }) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between">
        {labels.map((label, i) => {
          const stepNum = i + 1
          const done = stepNum < current
          const active = stepNum === current
          return (
            <div key={label} className="flex flex-col items-center gap-1.5" style={{ flex: 1 }}>
              {/* Connector line (before dot, skip for first) */}
              <div className="flex w-full items-center">
                {i > 0 && (
                  <div className={cn('h-px flex-1', done || active ? 'bg-primary' : 'bg-border')} />
                )}
                <div
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors',
                    done  && 'border-primary bg-primary text-primary-foreground',
                    active && 'border-primary bg-background text-primary',
                    !done && !active && 'border-border bg-background text-muted-foreground',
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : stepNum}
                </div>
                {i < labels.length - 1 && (
                  <div className={cn('h-px flex-1', done ? 'bg-primary' : 'bg-border')} />
                )}
              </div>
              <span className={cn('text-[10px] font-medium', active ? 'text-primary' : 'text-muted-foreground')}>
                {label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Step 1: Name + setup mode ────────────────────────────────────────────────

function Step1Name({
  name, setName, setupMode, setSetupMode,
}: {
  name: string; setName: (v: string) => void
  setupMode: 'manual' | 'ibkr'; setSetupMode: (v: 'manual' | 'ibkr') => void
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Name your portfolio</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Give it a name you'll recognise. You can change this later in Settings.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="portfolio-name">Portfolio name</Label>
        <Input
          id="portfolio-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Portfolio"
          className="text-base"
          autoFocus
        />
      </div>

      <div className="rounded-md border border-border bg-muted/40 px-4 py-3">
        <p className="text-sm font-medium">Base currency</p>
        <p className="text-sm text-muted-foreground mt-0.5">
          <span className="font-semibold text-foreground">TWD</span> — all values will be reported in New Taiwan Dollar.
          USD holdings are converted using your FX transaction history.
        </p>
      </div>

      <div className="space-y-2">
        <Label>How would you like to set up your holdings?</Label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setSetupMode('manual')}
            className={cn(
              'flex flex-col items-start gap-2 rounded-lg border-2 p-4 text-left transition-colors',
              setupMode === 'manual'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50',
            )}
          >
            <Plus className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-semibold">Start manually</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Define sleeves and holdings yourself
              </p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setSetupMode('ibkr')}
            className={cn(
              'flex flex-col items-start gap-2 rounded-lg border-2 p-4 text-left transition-colors',
              setupMode === 'ibkr'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50',
            )}
          >
            <Upload className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-semibold">Import from IBKR</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Build from your IBKR trade history
              </p>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 2 (IBKR): Upload CSV ────────────────────────────────────────────────

function StepIBKRUpload({
  trades, fileName, parseErrors, onFile,
}: {
  trades: IBKRTrade[]
  fileName: string
  parseErrors: string[]
  onFile: (trades: IBKRTrade[], fileName: string, errors: string[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const uniqueCount = new Set(trades.map(t => t.symbol)).size

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = decodeCSVBuffer(e.target!.result as ArrayBuffer)
      const result = parseIBKRActivityCSV(text)
      onFile(result.trades, file.name, result.errors)
    }
    reader.readAsArrayBuffer(file)
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Upload IBKR Activity Statement</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tickers will be extracted to build your portfolio structure. All trades will be imported when you finish.
        </p>
      </div>

      {/* Drop zone */}
      <label
        className={cn(
          'block cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          trades.length > 0
            ? 'border-primary/50 bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-muted/30',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="sr-only"
          onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]) }}
        />
        {trades.length === 0 ? (
          <div className="flex flex-col items-center gap-2">
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">Click to select a CSV file</p>
            <p className="text-xs text-muted-foreground">IBKR Activity Statement or Transaction History export</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <FileText className="h-8 w-8 text-primary" />
            <p className="text-sm font-semibold mt-1">{fileName}</p>
            <p className="text-sm text-muted-foreground">
              {trades.length} trades · {uniqueCount} unique tickers
            </p>
            <p className="text-xs text-muted-foreground mt-1">Click to replace</p>
          </div>
        )}
      </label>

      {/* Parse errors */}
      {parseErrors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 space-y-1">
          <p className="text-xs font-medium text-destructive">Parse warnings ({parseErrors.length})</p>
          {parseErrors.slice(0, 3).map((err, i) => (
            <p key={i} className="text-xs text-muted-foreground">{err}</p>
          ))}
          {parseErrors.length > 3 && (
            <p className="text-xs text-muted-foreground">+{parseErrors.length - 3} more</p>
          )}
        </div>
      )}

      {trades.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Next: assign each ticker to a sleeve and set its target allocation.
        </p>
      )}
    </div>
  )
}

// ─── Step 3 (IBKR): Configure tickers ────────────────────────────────────────

function StepIBKRConfigure({
  ibkrTickers, setIbkrTickers,
}: {
  ibkrTickers: DraftIBKRTicker[]
  setIbkrTickers: (v: DraftIBKRTicker[]) => void
}) {
  const [newTicker, setNewTicker] = useState('')

  function update(ticker: string, patch: Partial<DraftIBKRTicker>) {
    setIbkrTickers(ibkrTickers.map((t) => (t.ticker === ticker ? { ...t, ...patch } : t)))
  }

  function addTicker() {
    const sym = newTicker.trim().toUpperCase()
    if (!sym || ibkrTickers.some(t => t.ticker === sym)) return
    setIbkrTickers([...ibkrTickers, {
      ticker: sym,
      currency: inferCurrency(sym),
      sleeveName: '',
      targetPct: '0',
      include: true,
      status: 'active',
    }])
    setNewTicker('')
  }

  const included       = ibkrTickers.filter(t => t.include)
  const activeIncluded = included.filter(t => t.status === 'active')
  const total          = activeIncluded.reduce((s, t) => s + (parseFloat(t.targetPct) || 0), 0)
  const totalOk        = activeIncluded.length === 0 || Math.abs(total - 100) < 0.01

  // Sleeve name suggestions: unique names already typed
  const sleeveNames = [...new Set(included.map(t => t.sleeveName).filter(Boolean))]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Configure holdings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign each ticker to a sleeve and set its allocation. Mark positions you hold but no longer
          actively manage as Legacy — they'll be imported but excluded from DCA.
        </p>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_56px_68px_1fr_66px_28px] gap-2 px-1">
        {['Ticker', 'CCY', 'Status', 'Sleeve', 'Target %', ''].map((h) => (
          <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {h}
          </span>
        ))}
      </div>

      {/* Ticker rows */}
      <div className="space-y-2">
        {ibkrTickers.map((t) => (
          <div
            key={t.ticker}
            className={cn(
              'grid grid-cols-[1fr_56px_68px_1fr_66px_28px] items-center gap-2',
              !t.include && 'opacity-40',
            )}
          >
            {/* Ticker (read-only label) */}
            <span className="font-mono text-sm font-semibold">{t.ticker}</span>

            {/* Currency */}
            <Select
              value={t.currency}
              onValueChange={(v) => update(t.ticker, { currency: v as 'USD' | 'TWD' })}
              disabled={!t.include}
            >
              <SelectTrigger className="h-9 text-xs px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="TWD">TWD</SelectItem>
              </SelectContent>
            </Select>

            {/* Status toggle */}
            <button
              type="button"
              disabled={!t.include}
              onClick={() => update(t.ticker, {
                status: t.status === 'active' ? 'legacy' : 'active',
                ...(t.status === 'active' ? { targetPct: '0' } : {}),
              })}
              className={cn(
                'h-9 rounded-md border px-2 text-xs font-medium transition-colors',
                !t.include && 'pointer-events-none',
                t.status === 'active'
                  ? 'border-border text-muted-foreground hover:border-amber-400 hover:text-amber-600 dark:hover:text-amber-400'
                  : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-400',
              )}
            >
              {t.status === 'active' ? 'Active' : 'Legacy'}
            </button>

            {/* Sleeve name (free text with autocomplete) */}
            <div className="relative">
              <Input
                value={t.sleeveName}
                onChange={(e) => update(t.ticker, { sleeveName: e.target.value })}
                placeholder={t.status === 'legacy' ? 'Optional' : 'e.g. Core'}
                disabled={!t.include}
                className="text-xs"
                list={`sleeves-${t.ticker}`}
              />
              {sleeveNames.length > 0 && (
                <datalist id={`sleeves-${t.ticker}`}>
                  {sleeveNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              )}
            </div>

            {/* Target % — read-only 0 for legacy */}
            <div className="relative">
              <Input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={t.status === 'legacy' ? '0' : t.targetPct}
                onChange={(e) => update(t.ticker, { targetPct: e.target.value })}
                disabled={!t.include || t.status === 'legacy'}
                className="pr-5 text-right text-xs"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
            </div>

            {/* Include / exclude toggle */}
            <button
              type="button"
              onClick={() => update(t.ticker, { include: !t.include })}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                t.include
                  ? 'text-muted-foreground hover:text-destructive'
                  : 'text-muted-foreground/40 hover:text-foreground',
              )}
              title={t.include ? 'Exclude this ticker' : 'Re-include this ticker'}
            >
              {t.include ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
      </div>

      {/* Add ticker */}
      <div className="flex gap-2 pt-1">
        <Input
          value={newTicker}
          onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTicker() } }}
          placeholder="Add ticker (e.g. QQQ)"
          className="text-xs font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addTicker}
          disabled={!newTicker.trim() || ibkrTickers.some(t => t.ticker === newTicker.trim().toUpperCase())}
          className="shrink-0 gap-1"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {/* Total row — active tickers only */}
      <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
        <span className="text-sm font-medium">Active allocation total</span>
        <Badge variant={totalOk ? 'success' : 'destructive'}>
          {total.toFixed(1)}%
        </Badge>
      </div>
      {!totalOk && activeIncluded.length > 0 && (
        <p className="text-xs text-destructive">
          Active ticker allocations must equal exactly 100%. Currently {total > 100 ? 'over' : 'under'} by {Math.abs(100 - total).toFixed(1)}%.
        </p>
      )}
      {included.length === 0 && (
        <p className="text-xs text-destructive">At least one ticker must be included.</p>
      )}
    </div>
  )
}

// ─── Step 2 (manual): Sleeves ─────────────────────────────────────────────────

function Step2Sleeves({
  sleeves, setSleeves,
}: { sleeves: DraftSleeve[]; setSleeves: (v: DraftSleeve[]) => void }) {
  const total = sleeves.reduce((s, sl) => s + (parseFloat(sl.targetPct) || 0), 0)
  const totalOk = Math.abs(total - 100) < 0.01

  function update(id: string, patch: Partial<DraftSleeve>) {
    setSleeves(sleeves.map((sl) => (sl.id === id ? { ...sl, ...patch } : sl)))
  }

  function addSleeve() {
    const usedColors = new Set(sleeves.map((s) => s.color))
    const color = SLEEVE_COLORS.find((c) => !usedColors.has(c)) ?? SLEEVE_COLORS[0]
    setSleeves([...sleeves, { id: crypto.randomUUID(), name: '', color: color!, targetPct: '0' }])
  }

  function removeSleeve(id: string) {
    setSleeves(sleeves.filter((sl) => sl.id !== id))
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Define your sleeves</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sleeves are named groups of holdings. Target allocations must sum to exactly 100%.
        </p>
      </div>

      <div className="space-y-2">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_90px_32px] items-center gap-2 px-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sleeve name</span>
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide text-right">Target %</span>
          <span />
        </div>

        {sleeves.map((sl) => (
          <div key={sl.id} className="grid grid-cols-[auto_1fr_90px_32px] items-center gap-2">
            {/* Color swatch picker */}
            <div className="relative group">
              <div
                className="h-7 w-7 rounded-full border-2 border-white shadow-sm cursor-pointer"
                style={{ backgroundColor: sl.color }}
              />
              {/* Inline color palette on hover */}
              <div className="absolute left-0 top-9 z-10 hidden group-focus-within:grid group-hover:grid grid-cols-5 gap-1 rounded-lg border bg-background p-2 shadow-lg">
                {SLEEVE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => update(sl.id, { color: c })}
                    className={cn(
                      'h-5 w-5 rounded-full border-2 transition-transform hover:scale-110',
                      sl.color === c ? 'border-foreground' : 'border-transparent',
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>

            <Input
              value={sl.name}
              onChange={(e) => update(sl.id, { name: e.target.value })}
              placeholder="Sleeve name"
            />
            <div className="relative">
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                value={sl.targetPct}
                onChange={(e) => update(sl.id, { targetPct: e.target.value })}
                className="pr-6 text-right"
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
            </div>
            <button
              type="button"
              onClick={() => removeSleeve(sl.id)}
              disabled={sleeves.length <= 1}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-destructive disabled:opacity-30 transition-colors"
              aria-label="Remove sleeve"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}

        {/* Total row */}
        <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 mt-1">
          <span className="text-sm font-medium">Total</span>
          <Badge variant={totalOk ? 'success' : 'destructive'}>
            {total.toFixed(1)}%
          </Badge>
        </div>

        {!totalOk && (
          <p className="text-xs text-destructive">
            Sleeve totals must equal 100%. Currently {total > 100 ? 'over' : 'under'} by {Math.abs(100 - total).toFixed(1)}%.
          </p>
        )}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={addSleeve} className="gap-2">
        <Plus className="h-4 w-4" /> Add sleeve
      </Button>
    </div>
  )
}

// ─── Step 3 (manual): Holdings ────────────────────────────────────────────────

function Step3Holdings({
  sleeves, holdings, setHoldings,
}: {
  sleeves: DraftSleeve[]
  holdings: DraftHolding[]
  setHoldings: (v: DraftHolding[]) => void
}) {
  function addHolding(sleeveId: string) {
    setHoldings([...holdings, {
      id: crypto.randomUUID(),
      sleeveId,
      ticker: '',
      name: '',
      targetPct: '0',
      currency: 'USD',
      driftThresholdPct: '2',
    }])
  }

  function updateHolding(id: string, patch: Partial<DraftHolding>) {
    setHoldings(holdings.map((h) => (h.id === id ? { ...h, ...patch } : h)))
  }

  function removeHolding(id: string) {
    setHoldings(holdings.filter((h) => h.id !== id))
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Add your holdings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add holdings for each sleeve. Holdings within a sleeve must sum to the sleeve's target %.
        </p>
      </div>

      {sleeves.map((sl) => {
        const sleeveHoldings = holdings.filter((h) => h.sleeveId === sl.id)
        const used = sleeveHoldings.reduce((s, h) => s + (parseFloat(h.targetPct) || 0), 0)
        const target = parseFloat(sl.targetPct) || 0
        const remaining = target - used
        const allocationOk = Math.abs(remaining) < 0.01

        return (
          <div key={sl.id} className="space-y-2">
            {/* Sleeve header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full" style={{ backgroundColor: sl.color }} />
                <span className="text-sm font-semibold">{sl.name || 'Unnamed sleeve'}</span>
                <span className="text-xs text-muted-foreground">({sl.targetPct}% total)</span>
              </div>
              <Badge variant={allocationOk ? 'success' : remaining < 0 ? 'destructive' : 'warning'}>
                {remaining >= 0 ? `${remaining.toFixed(1)}% remaining` : `${Math.abs(remaining).toFixed(1)}% over`}
              </Badge>
            </div>

            {/* Holdings column headers */}
            {sleeveHoldings.length > 0 && (
              <div className="grid grid-cols-[60px_1fr_70px_60px_52px_28px] gap-1.5 px-1">
                {['Ticker', 'Name', 'Target %', 'CCY', 'Drift', ''].map((h) => (
                  <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {h}
                  </span>
                ))}
              </div>
            )}

            {/* Holdings rows */}
            {sleeveHoldings.map((h) => (
              <div key={h.id} className="grid grid-cols-[60px_1fr_70px_60px_52px_28px] items-center gap-1.5">
                <Input
                  value={h.ticker}
                  onChange={(e) => updateHolding(h.id, { ticker: e.target.value.toUpperCase() })}
                  placeholder="VOO"
                  className="text-xs font-mono"
                />
                <Input
                  value={h.name}
                  onChange={(e) => updateHolding(h.id, { name: e.target.value })}
                  placeholder="Fund name"
                  className="text-xs"
                />
                <div className="relative">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={h.targetPct}
                    onChange={(e) => updateHolding(h.id, { targetPct: e.target.value })}
                    className="pr-4 text-right text-xs"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
                </div>
                <Select
                  value={h.currency}
                  onValueChange={(v) => updateHolding(h.id, { currency: v as 'USD' | 'TWD' })}
                >
                  <SelectTrigger className="h-10 text-xs px-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="TWD">TWD</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Input
                    type="number"
                    min={0.5}
                    max={20}
                    step={0.5}
                    value={h.driftThresholdPct}
                    onChange={(e) => updateHolding(h.id, { driftThresholdPct: e.target.value })}
                    className="pr-4 text-right text-xs"
                  />
                  <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeHolding(h.id)}
                  className="flex h-8 w-7 items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors"
                  aria-label="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => addHolding(sl.id)}
              className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> Add holding to {sl.name || 'this sleeve'}
            </Button>

            <Separator />
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 4: Cash balances ────────────────────────────────────────────────────

function Step4Cash({
  twdBalance, setTwdBalance,
  usdBalance, setUsdBalance,
  fxRate, setFxRate,
}: {
  twdBalance: string; setTwdBalance: (v: string) => void
  usdBalance: string; setUsdBalance: (v: string) => void
  fxRate: string;     setFxRate: (v: string) => void
}) {
  const rate = parseFloat(fxRate)
  const usd = parseFloat(usdBalance) || 0
  const twd = parseFloat(twdBalance) || 0
  const totalTWD = twd + (rate > 0 ? usd * rate : 0)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Set starting cash balances</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your current cash balances. You'll update these when you log deposits and FX exchanges later.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="twd-balance">TWD cash balance</Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">NT$</span>
            <Input
              id="twd-balance"
              type="number"
              min={0}
              step={1000}
              value={twdBalance}
              onChange={(e) => setTwdBalance(e.target.value)}
              placeholder="0"
              className="pl-10"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="usd-balance">USD cash balance</Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">$</span>
            <Input
              id="usd-balance"
              type="number"
              min={0}
              step={100}
              value={usdBalance}
              onChange={(e) => setUsdBalance(e.target.value)}
              placeholder="0"
              className="pl-7"
            />
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <Label htmlFor="fx-rate">
            Initial FX rate <span className="font-normal text-muted-foreground">(TWD per USD)</span>
          </Label>
          <Input
            id="fx-rate"
            type="number"
            min={1}
            step={0.1}
            value={fxRate}
            onChange={(e) => setFxRate(e.target.value)}
            placeholder="e.g. 32.5"
          />
          <p className="text-xs text-muted-foreground">
            Used to convert USD holdings to TWD for portfolio valuation. Folio will update this
            automatically each time you log an FX exchange.
          </p>
        </div>

        {rate > 0 && (usd > 0 || twd > 0) && (
          <div className="rounded-md border bg-muted/40 px-4 py-3">
            <p className="text-xs text-muted-foreground">Total starting cash (TWD equivalent)</p>
            <p className="text-lg font-semibold mt-0.5">
              NT${totalTWD.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Step 5: DCA defaults ─────────────────────────────────────────────────────

function Step5DCA({
  budget, setBudget,
  budgetCurrency, setBudgetCurrency,
  strategy, setStrategy,
  method, setMethod,
}: {
  budget: string;           setBudget: (v: string) => void
  budgetCurrency: 'USD' | 'TWD'; setBudgetCurrency: (v: 'USD' | 'TWD') => void
  strategy: 'soft' | 'hard' | 'none';    setStrategy: (v: 'soft' | 'hard' | 'none') => void
  method: 'proportional-to-drift' | 'equal-weight'; setMethod: (v: 'proportional-to-drift' | 'equal-weight') => void
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">DCA defaults</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These defaults pre-fill the DCA Planner each month. You can override them per session.
        </p>
      </div>

      {/* Budget */}
      <div className="space-y-2">
        <Label>Monthly DCA budget</Label>
        <div className="flex gap-2">
          <Select value={budgetCurrency} onValueChange={(v) => setBudgetCurrency(v as 'USD' | 'TWD')}>
            <SelectTrigger className="w-24 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="TWD">TWD</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={0}
            step={100}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="e.g. 1000"
          />
        </div>
      </div>

      <Separator />

      {/* Rebalance strategy */}
      <div className="space-y-3">
        <Label>Default rebalance strategy</Label>
        <RadioGroup value={strategy} onValueChange={(v) => setStrategy(v as 'soft' | 'hard' | 'none')}>
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
            strategy === 'soft' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
          )}>
            <RadioGroupItem value="soft" className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">Soft rebalance (buy-only)</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Don't sell anything. Over-allocate DCA budget to underweight holdings,
                under-allocate to overweight holdings.
              </p>
            </div>
          </label>
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
            strategy === 'hard' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
          )}>
            <RadioGroupItem value="hard" className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">Hard rebalance (sell + buy)</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Sell overweight holdings to free up cash, then buy underweight holdings
                to restore targets.
              </p>
            </div>
          </label>
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
            strategy === 'none' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
          )}>
            <RadioGroupItem value="none" className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">No rebalancing</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Buy proportional to target allocation every DCA period. Ignore current drift.
              </p>
            </div>
          </label>
        </RadioGroup>
      </div>

      <Separator />

      {/* Allocation method */}
      <div className="space-y-3">
        <Label>Default allocation method</Label>
        <RadioGroup value={method} onValueChange={(v) => setMethod(v as 'proportional-to-drift' | 'equal-weight')}>
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
            method === 'proportional-to-drift' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
          )}>
            <RadioGroupItem value="proportional-to-drift" className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">Proportional to drift</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Allocate more budget to the most underweight holdings, proportional to how far
                they've drifted from target.
              </p>
            </div>
          </label>
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
            method === 'equal-weight' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
          )}>
            <RadioGroupItem value="equal-weight" className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">Equal weight</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Split the budget evenly across all underweight holdings regardless of drift
                magnitude.
              </p>
            </div>
          </label>
        </RadioGroup>
      </div>
    </div>
  )
}

// ─── Step 6: Review ───────────────────────────────────────────────────────────

function Step6Review({
  portfolioName, sleeves, holdings,
  twdBalance, usdBalance, fxRate,
  budget, budgetCurrency, strategy, method,
  setupMode, ibkrTickers, ibkrTradeCount, ibkrFileName,
}: {
  portfolioName: string
  sleeves: DraftSleeve[]
  holdings: DraftHolding[]
  twdBalance: string
  usdBalance: string
  fxRate: string
  budget: string
  budgetCurrency: 'USD' | 'TWD'
  strategy: 'soft' | 'hard' | 'none'
  method: 'proportional-to-drift' | 'equal-weight'
  setupMode: 'manual' | 'ibkr'
  ibkrTickers: DraftIBKRTicker[]
  ibkrTradeCount: number
  ibkrFileName: string
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Review & confirm</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Take one last look before creating your portfolio.
        </p>
      </div>

      {/* Portfolio name */}
      <ReviewSection title="Portfolio">
        <ReviewRow label="Name" value={portfolioName} />
        <ReviewRow label="Base currency" value="TWD" />
      </ReviewSection>

      {/* Holdings — different content per mode */}
      {setupMode === 'manual' ? (
        <ReviewSection title="Sleeves">
          {sleeves.map((sl) => {
            const slHoldings = holdings.filter((h) => h.sleeveId === sl.id)
            return (
              <div key={sl.id} className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: sl.color }} />
                    <span className="text-sm font-medium">{sl.name}</span>
                  </div>
                  <span className="text-sm font-medium">{sl.targetPct}%</span>
                </div>
                {slHoldings.length > 0 && (
                  <div className="ml-4 space-y-0.5">
                    {slHoldings.map((h) => (
                      <div key={h.id} className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="font-mono">{h.ticker}</span>
                        <span>{h.targetPct}% · {h.currency} · ±{h.driftThresholdPct}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </ReviewSection>
      ) : (
        <ReviewSection title="Holdings from IBKR">
          <ReviewRow label="Source file" value={ibkrFileName || '—'} />
          <ReviewRow label="Trades to import" value={`${ibkrTradeCount}`} />
          {/* Active tickers grouped by sleeve + legacy tickers separately */}
          {(() => {
            const activeIncluded = ibkrTickers.filter(t => t.include && t.status === 'active')
            const legacyIncluded = ibkrTickers.filter(t => t.include && t.status === 'legacy')
            const sleeveNames = [...new Set(activeIncluded.map(t => t.sleeveName || 'Unassigned'))]
            return (
              <>
                {sleeveNames.map((name) => {
                  const tickers = activeIncluded.filter(t => (t.sleeveName || 'Unassigned') === name)
                  const sleeveTotal = tickers.reduce((s, t) => s + (parseFloat(t.targetPct) || 0), 0)
                  return (
                    <div key={name} className="space-y-0.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{name}</span>
                        <span className="text-sm font-medium">{sleeveTotal.toFixed(1)}%</span>
                      </div>
                      <div className="ml-4 space-y-0.5">
                        {tickers.map((t) => (
                          <div key={t.ticker} className="flex items-center justify-between text-xs text-muted-foreground">
                            <span className="font-mono">{t.ticker}</span>
                            <span>{t.targetPct}% · {t.currency}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
                {legacyIncluded.length > 0 && (
                  <div className="space-y-0.5 pt-1">
                    <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Legacy (庫存)</span>
                    <div className="ml-4 space-y-0.5">
                      {legacyIncluded.map((t) => (
                        <div key={t.ticker} className="flex items-center justify-between text-xs text-muted-foreground">
                          <span className="font-mono">{t.ticker}</span>
                          <span>{t.currency} · {t.sleeveName || 'Unassigned'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )
          })()}
        </ReviewSection>
      )}

      {/* Cash */}
      <ReviewSection title="Starting balances">
        <ReviewRow label="TWD cash" value={`NT$${(parseFloat(twdBalance) || 0).toLocaleString()}`} />
        <ReviewRow label="USD cash" value={`$${(parseFloat(usdBalance) || 0).toLocaleString()}`} />
        <ReviewRow label="FX rate" value={fxRate ? `${fxRate} TWD/USD` : '—'} />
      </ReviewSection>

      {/* DCA */}
      <ReviewSection title="DCA defaults">
        <ReviewRow
          label="Monthly budget"
          value={budget ? `${budgetCurrency} ${parseFloat(budget).toLocaleString()}` : '—'}
        />
        <ReviewRow
          label="Rebalance strategy"
          value={strategy === 'soft' ? 'Soft (buy-only)' : strategy === 'hard' ? 'Hard (sell + buy)' : 'No rebalancing'}
        />
        <ReviewRow
          label="Allocation method"
          value={method === 'proportional-to-drift' ? 'Proportional to drift' : 'Equal weight'}
        />
      </ReviewSection>

      {setupMode === 'ibkr' && ibkrTradeCount > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3">
          <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
            TWD cost basis for historical USD trades will use your initial FX rate as fallback.
            Log actual FX exchanges later to improve accuracy.
          </p>
        </div>
      )}
    </div>
  )
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="rounded-lg border divide-y divide-border">
        <div className="px-4 py-3 space-y-2">{children}</div>
      </div>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  )
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export function SetupWizard() {
  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio)
  const setActiveTab  = useUIStore((s) => s.setActiveTab)

  // ── Step 1
  const [portfolioName, setPortfolioName] = useState('My Portfolio')
  const [setupMode, setSetupMode]         = useState<'manual' | 'ibkr'>('manual')

  // ── Step 2 (manual)
  const [sleeves, setSleeves] = useState<DraftSleeve[]>(DEFAULT_SLEEVES)

  // ── Step 3 (manual)
  const [holdings, setHoldings] = useState<DraftHolding[]>([])

  // ── Step 2 (IBKR): uploaded trades
  const [ibkrTrades,      setIbkrTrades]      = useState<IBKRTrade[]>([])
  const [ibkrFileName,    setIbkrFileName]    = useState('')
  const [ibkrParseErrors, setIbkrParseErrors] = useState<string[]>([])

  // ── Step 3 (IBKR): per-ticker configuration
  const [ibkrTickers, setIbkrTickers] = useState<DraftIBKRTicker[]>([])

  // ── Step 4
  const [twdBalance,  setTwdBalance]  = useState('')
  const [usdBalance,  setUsdBalance]  = useState('')
  const [fxRate,      setFxRate]      = useState('')

  // ── Step 5
  const [budget,          setBudget]          = useState('')
  const [budgetCurrency,  setBudgetCurrency]  = useState<'USD' | 'TWD'>('USD')
  const [strategy,        setStrategy]        = useState<'soft' | 'hard' | 'none'>('soft')
  const [method,          setMethod]          = useState<'proportional-to-drift' | 'equal-weight'>('proportional-to-drift')

  // ── Navigation + save state
  const [step,           setStep]           = useState(1)
  const [saving,         setSaving]         = useState(false)
  const [error,          setError]          = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState(0)
  const [importTotal,    setImportTotal]    = useState(0)

  const stepLabels = setupMode === 'ibkr' ? IBKR_STEP_LABELS : MANUAL_STEP_LABELS

  // ── IBKR file handler: parse CSV and seed ticker config
  function handleIBKRFile(trades: IBKRTrade[], fileName: string, errors: string[]) {
    setIbkrTrades(trades)
    setIbkrFileName(fileName)
    setIbkrParseErrors(errors)

    // Derive unique tickers in chronological order and pre-fill defaults
    const seen = new Set<string>()
    const tickers: DraftIBKRTicker[] = []
    for (const trade of trades) {
      if (!seen.has(trade.symbol)) {
        seen.add(trade.symbol)
        tickers.push({
          ticker: trade.symbol,
          currency: inferCurrency(trade.symbol),
          sleeveName: 'Core',
          targetPct: '0',
          include: true,
          status: 'active',
        })
      }
    }
    setIbkrTickers(tickers)
  }

  // ── Per-step validation ────────────────────────────────────────────────────

  function canAdvance(): boolean {
    switch (step) {
      case 1: return portfolioName.trim().length > 0

      case 2: {
        if (setupMode === 'ibkr') return ibkrTrades.length > 0
        const total = sleeves.reduce((s, sl) => s + (parseFloat(sl.targetPct) || 0), 0)
        const allNamed = sleeves.every((sl) => sl.name.trim().length > 0)
        return allNamed && Math.abs(total - 100) < 0.01
      }

      case 3: {
        if (setupMode === 'ibkr') {
          const included       = ibkrTickers.filter(t => t.include)
          if (included.length === 0) return false
          const activeIncluded = included.filter(t => t.status === 'active')
          // Active tickers need a sleeve and must sum to 100%
          const allActiveHaveSleeve = activeIncluded.every(t => t.sleeveName.trim().length > 0)
          const total   = activeIncluded.reduce((s, t) => s + (parseFloat(t.targetPct) || 0), 0)
          const totalOk = activeIncluded.length === 0 || Math.abs(total - 100) < 0.01
          return allActiveHaveSleeve && totalOk
        }
        return sleeves.every((sl) => {
          const slH = holdings.filter((h) => h.sleeveId === sl.id)
          if (slH.length === 0) return true
          const allNamed = slH.every((h) => h.ticker.trim() && h.name.trim())
          const used   = slH.reduce((s, h) => s + (parseFloat(h.targetPct) || 0), 0)
          const target = parseFloat(sl.targetPct) || 0
          return allNamed && Math.abs(used - target) < 0.01
        })
      }

      case 4: return parseFloat(fxRate) > 0
      case 5: return true   // DCA budget is optional
      case 6: return true
      default: return true
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleCreate() {
    setSaving(true)
    setError(null)

    try {
      const portfolioId = crypto.randomUUID()
      const now         = new Date()
      const parsedFxRate = parseFloat(fxRate) || 0

      const portfolio: Portfolio = {
        id: portfolioId,
        name: portfolioName.trim(),
        baseCurrency: 'TWD',
        supportedCurrencies: ['TWD', 'USD'],
        monthlyDCABudget: parseFloat(budget) || 0,
        monthlyDCABudgetCurrency: budgetCurrency,
        defaultRebalanceStrategy: strategy,
        defaultAllocationMethod: method,
        initialFxRate: parsedFxRate > 0 ? parsedFxRate : undefined,
        createdAt: now,
        updatedAt: now,
      }

      const cashAccounts: CashAccount[] = [
        { id: crypto.randomUUID(), portfolioId, currency: 'TWD', balance: parseFloat(twdBalance) || 0 },
        { id: crypto.randomUUID(), portfolioId, currency: 'USD', balance: parseFloat(usdBalance) || 0 },
      ]

      // Rate anchor FX transaction (zero-amount, just records the initial rate)
      const fxTransactions: FxTransaction[] = []
      if (parsedFxRate > 0) {
        fxTransactions.push({
          id: crypto.randomUUID(),
          portfolioId,
          timestamp: now,
          fromCurrency: 'TWD',
          toCurrency:   'USD',
          fromAmount:   0,
          toAmount:     0,
          rate:         parsedFxRate,
          fees:         0,
          feesCurrency: 'TWD',
          note:         'Initial setup rate',
        })
      }

      if (setupMode === 'manual') {
        // ── Manual path: persist portfolio, sleeves, holdings atomically ─────

        const dbSleeves: Sleeve[] = sleeves.map((sl) => ({
          id: sl.id,
          portfolioId,
          name: sl.name,
          targetAllocationPct: parseFloat(sl.targetPct) || 0,
          color: sl.color,
        }))

        const dbHoldings: Holding[] = holdings.map((h) => ({
          id: h.id,
          portfolioId,
          ticker: h.ticker.toUpperCase(),
          name: h.name,
          sleeveId: h.sleeveId,
          targetAllocationPct: parseFloat(h.targetPct) || 0,
          driftThresholdPct: parseFloat(h.driftThresholdPct) || 2,
          currency: h.currency,
          status: 'active' as const,
        }))

        await db.transaction(
          'rw',
          [db.portfolios, db.sleeves, db.holdings, db.cashAccounts, db.fxTransactions],
          async () => {
            await db.portfolios.add(portfolio)
            if (dbSleeves.length)      await db.sleeves.bulkAdd(dbSleeves)
            if (dbHoldings.length)     await db.holdings.bulkAdd(dbHoldings)
            await db.cashAccounts.bulkAdd(cashAccounts)
            if (fxTransactions.length) await db.fxTransactions.bulkAdd(fxTransactions)
          },
        )
      } else {
        // ── IBKR path: derive sleeves + holdings from ticker config, then
        //    import all trades ────────────────────────────────────────────────

        const included       = ibkrTickers.filter(t => t.include)
        const activeIncluded = included.filter(t => t.status === 'active')
        const legacyIncluded = included.filter(t => t.status === 'legacy')

        // Build sleeves from all included tickers (active + legacy)
        // normalize empty sleeve names → 'Unassigned'
        const sleeveOrder: string[] = []
        for (const t of included) {
          const name = t.sleeveName.trim() || 'Unassigned'
          if (!sleeveOrder.includes(name)) sleeveOrder.push(name)
        }
        // Ensure 'Unassigned' exists if any legacy ticker has no sleeve
        if (legacyIncluded.some(t => !t.sleeveName.trim()) && !sleeveOrder.includes('Unassigned')) {
          sleeveOrder.push('Unassigned')
        }

        const sleeveIdMap = new Map<string, string>()  // sleeveName → id
        const dbSleeves: Sleeve[] = sleeveOrder.map((name, ci) => {
          const id = crypto.randomUUID()
          sleeveIdMap.set(name, id)
          // Sleeve target = sum of active tickers in this sleeve only
          const sleeveTotal = activeIncluded
            .filter(t => (t.sleeveName.trim() || 'Unassigned') === name)
            .reduce((s, t) => s + (parseFloat(t.targetPct) || 0), 0)
          return {
            id,
            portfolioId,
            name,
            targetAllocationPct: sleeveTotal,
            color: SLEEVE_COLORS[ci % SLEEVE_COLORS.length],
          }
        })

        // Build holdings and a ticker→holdingId map for trade import
        const holdingIdMap = new Map<string, string>()  // ticker → holdingId
        const dbHoldings: Holding[] = included.map((t) => {
          const id = crypto.randomUUID()
          holdingIdMap.set(t.ticker, id)
          const isLegacy   = t.status === 'legacy'
          const sleeveName = t.sleeveName.trim() || 'Unassigned'
          return {
            id,
            portfolioId,
            ticker: t.ticker,
            name: t.ticker,   // user can rename in Settings later
            sleeveId: sleeveIdMap.get(sleeveName)!,
            targetAllocationPct: isLegacy ? 0 : (parseFloat(t.targetPct) || 0),
            driftThresholdPct:   isLegacy ? 0 : 2,
            currency: t.currency,
            status: isLegacy ? 'legacy' as const : 'active' as const,
          }
        })

        // Atomic write of portfolio structure
        await db.transaction(
          'rw',
          [db.portfolios, db.sleeves, db.holdings, db.cashAccounts, db.fxTransactions],
          async () => {
            await db.portfolios.add(portfolio)
            if (dbSleeves.length)      await db.sleeves.bulkAdd(dbSleeves)
            if (dbHoldings.length)     await db.holdings.bulkAdd(dbHoldings)
            await db.cashAccounts.bulkAdd(cashAccounts)
            if (fxTransactions.length) await db.fxTransactions.bulkAdd(fxTransactions)
          },
        )

        // Import trades — one createTradeOperation call per trade, in chronological order
        const tradesToImport = ibkrTrades.filter(t => holdingIdMap.has(t.symbol))
        setImportTotal(tradesToImport.length)
        setImportProgress(0)

        for (const trade of tradesToImport) {
          const holdingId = holdingIdMap.get(trade.symbol)!
          await createTradeOperation(portfolioId, {
            type: trade.quantity > 0 ? 'BUY' : 'SELL',
            entries: [{
              holdingId,
              side:          trade.quantity > 0 ? 'BUY' : 'SELL',
              shares:        Math.abs(trade.quantity),
              pricePerShare: trade.tradePrice,
              fees:          trade.commFee,
            }],
            rationale:  `Imported from IBKR (${ibkrFileName})`,
            timestamp:  trade.dateTime,
          })
          setImportProgress((p) => p + 1)
        }
      }

      await loadPortfolio()
      setActiveTab('dashboard')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-start overflow-y-auto bg-background px-4 py-8">
      <div className="w-full max-w-lg">
        {/* App name */}
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Folio</h1>
          <p className="text-sm text-muted-foreground mt-1">Let's set up your portfolio</p>
        </div>

        <WizardProgress current={step} labels={stepLabels} />

        <Card>
          <CardContent className="pt-6 pb-6">
            {step === 1 && (
              <Step1Name
                name={portfolioName} setName={setPortfolioName}
                setupMode={setupMode} setSetupMode={setSetupMode}
              />
            )}
            {step === 2 && setupMode === 'manual' && (
              <Step2Sleeves sleeves={sleeves} setSleeves={setSleeves} />
            )}
            {step === 2 && setupMode === 'ibkr' && (
              <StepIBKRUpload
                trades={ibkrTrades}
                fileName={ibkrFileName}
                parseErrors={ibkrParseErrors}
                onFile={handleIBKRFile}
              />
            )}
            {step === 3 && setupMode === 'manual' && (
              <Step3Holdings sleeves={sleeves} holdings={holdings} setHoldings={setHoldings} />
            )}
            {step === 3 && setupMode === 'ibkr' && (
              <StepIBKRConfigure ibkrTickers={ibkrTickers} setIbkrTickers={setIbkrTickers} />
            )}
            {step === 4 && (
              <Step4Cash
                twdBalance={twdBalance} setTwdBalance={setTwdBalance}
                usdBalance={usdBalance} setUsdBalance={setUsdBalance}
                fxRate={fxRate}         setFxRate={setFxRate}
              />
            )}
            {step === 5 && (
              <Step5DCA
                budget={budget}                 setBudget={setBudget}
                budgetCurrency={budgetCurrency} setBudgetCurrency={setBudgetCurrency}
                strategy={strategy}             setStrategy={setStrategy}
                method={method}                 setMethod={setMethod}
              />
            )}
            {step === 6 && (
              <Step6Review
                portfolioName={portfolioName}
                sleeves={sleeves}
                holdings={holdings}
                twdBalance={twdBalance}
                usdBalance={usdBalance}
                fxRate={fxRate}
                budget={budget}
                budgetCurrency={budgetCurrency}
                strategy={strategy}
                method={method}
                setupMode={setupMode}
                ibkrTickers={ibkrTickers}
                ibkrTradeCount={ibkrTrades.filter(t => ibkrTickers.filter(k => k.include).some(k => k.ticker === t.symbol)).length}
                ibkrFileName={ibkrFileName}
              />
            )}
          </CardContent>
        </Card>

        {/* Error */}
        {error && (
          <p className="mt-3 text-sm text-destructive text-center">{error}</p>
        )}

        {/* Save progress (IBKR trade import) */}
        {saving && setupMode === 'ibkr' && importTotal > 0 && (
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Importing trades…</span>
              <span>{importProgress} / {importTotal}</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${importTotal > 0 ? (importProgress / importTotal) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="mt-4 flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 1 || saving}
            className="gap-2"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>

          {step < TOTAL_STEPS ? (
            <Button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              disabled={!canAdvance() || saving}
              className="gap-2"
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleCreate}
              disabled={saving}
              className="gap-2 min-w-36"
            >
              {saving ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {setupMode === 'ibkr' && importTotal === 0 ? 'Creating…' : 'Importing…'}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  {setupMode === 'ibkr' ? 'Create & import' : 'Create portfolio'}
                </>
              )}
            </Button>
          )}
        </div>

        {/* Step hint */}
        {!canAdvance() && step < TOTAL_STEPS && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {step === 2 && setupMode === 'manual' && 'Sleeve targets must sum to 100% before you can continue.'}
            {step === 2 && setupMode === 'ibkr'   && 'Upload a CSV file to continue.'}
            {step === 3 && setupMode === 'manual' && "Holdings in each sleeve must sum to the sleeve's target % before you can continue."}
            {step === 3 && setupMode === 'ibkr'   && 'Allocations of included tickers must sum to 100%.'}
            {step === 4 && 'Enter a valid FX rate to continue.'}
          </p>
        )}
      </div>
    </div>
  )
}
