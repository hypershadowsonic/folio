import { useState, useRef, useEffect } from 'react'
import { ArrowLeft, ArrowRight, Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useTickerSearch, fetchMultiplePrices, fetchFxRate } from '@/api/yahooFinance'
import { db } from '@/db/index'
import { useBacktestStore } from '@/stores/backtestStore'
import { useUIStore } from '@/stores/uiStore'
import { runBacktest } from '@/engine/backtest'
import type { Build, BuildHolding, RebalanceTrigger, TickerSearchResult } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BuildCreatorProps {
  onDone: (buildId: string) => void
  onCancel: () => void
  editBuild?: Build
}

interface BuildForm {
  name: string
  holdings: BuildHolding[]
  dcaAmount: string
  dcaCurrency: 'USD' | 'TWD'
  dcaFrequency: 'weekly' | 'biweekly' | 'monthly'
  startDate: string
  endDate: string
  rebalanceStrategy: 'soft' | 'hard'
  rebalanceTriggers: RebalanceTrigger[]
  thresholdPct: string
  periodicFrequency: 'monthly' | 'quarterly' | 'annually'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10)

function defaultStartDate(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 5)
  return d.toISOString().slice(0, 10)
}

function detectCurrency(result: TickerSearchResult): 'USD' | 'TWD' {
  if (result.ticker.endsWith('.TW') || result.exchange.toLowerCase().includes('taiwan')) {
    return 'TWD'
  }
  return 'USD'
}

function formFromBuild(build: Build): BuildForm {
  return {
    name: build.name,
    holdings: build.holdings,
    dcaAmount: String(build.dcaAmount),
    dcaCurrency: build.dcaCurrency,
    dcaFrequency: build.dcaFrequency,
    startDate: build.startDate instanceof Date
      ? build.startDate.toISOString().slice(0, 10)
      : String(build.startDate).slice(0, 10),
    endDate: build.endDate instanceof Date
      ? build.endDate.toISOString().slice(0, 10)
      : String(build.endDate).slice(0, 10),
    rebalanceStrategy: build.rebalanceStrategy,
    rebalanceTriggers: build.rebalanceTriggers,
    thresholdPct: String(build.thresholdPct ?? 5),
    periodicFrequency: build.periodicFrequency ?? 'monthly',
  }
}

// ─── Step indicators ──────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all',
            i + 1 === current ? 'w-6 bg-primary' : i + 1 < current ? 'w-3 bg-primary/50' : 'w-3 bg-muted',
          )}
        />
      ))}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BuildCreator({ onDone, onCancel, editBuild }: BuildCreatorProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [form, setForm] = useState<BuildForm>(() =>
    editBuild
      ? formFromBuild(editBuild)
      : {
          name: '',
          holdings: [],
          dcaAmount: '1000',
          dcaCurrency: 'USD',
          dcaFrequency: 'monthly',
          startDate: defaultStartDate(),
          endDate: today,
          rebalanceStrategy: 'soft',
          rebalanceTriggers: ['on-dca'],
          thresholdPct: '5',
          periodicFrequency: 'monthly',
        },
  )

  const { isRunning, progress, error, setRunning, setProgress, setError, reset } = useBacktestStore()

  // ─── Holdings search state ─────────────────────────────────────────────────

  const [tickerQuery, setTickerQuery] = useState('')
  const [selectedResult, setSelectedResult] = useState<TickerSearchResult | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  const { results, isLoading: searchLoading } = useTickerSearch(tickerQuery)
  const apiStatus = useUIStore((s) => s.apiStatus)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (results.length > 0 && tickerQuery.length >= 2) setDropdownOpen(true)
    else setDropdownOpen(false)
  }, [results, tickerQuery])

  // ─── Validation ────────────────────────────────────────────────────────────

  const allocationSum = form.holdings.reduce((sum, h) => sum + h.targetAllocationPct, 0)
  const allocationRemaining = 100 - allocationSum
  const allocationValid = Math.abs(allocationRemaining) < 0.01

  const step1Valid = form.name.trim().length > 0
  const step2Valid = form.holdings.length > 0 && allocationValid
  const step3Valid =
    parseFloat(form.dcaAmount) > 0 &&
    form.startDate.length === 10 &&
    form.endDate.length === 10 &&
    form.startDate <= form.endDate
  const step4Valid = form.rebalanceTriggers.length > 0

  // ─── Holdings management ───────────────────────────────────────────────────

  function addHolding() {
    if (!selectedResult) return
    const currency = detectCurrency(selectedResult)
    setForm((f) => ({
      ...f,
      holdings: [
        ...f.holdings,
        {
          ticker: selectedResult.ticker,
          name: selectedResult.name,
          currency,
          targetAllocationPct: 0,
        },
      ],
    }))
    setTickerQuery('')
    setSelectedResult(null)
    setDropdownOpen(false)
  }

  function removeHolding(idx: number) {
    setForm((f) => ({ ...f, holdings: f.holdings.filter((_, i) => i !== idx) }))
  }

  function updateHoldingAllocation(idx: number, value: string) {
    const parsed = parseFloat(value)
    const pct = isNaN(parsed) ? 0 : Math.max(0, parsed)
    setForm((f) => ({
      ...f,
      holdings: f.holdings.map((h, i) =>
        i === idx ? { ...h, targetAllocationPct: pct } : h,
      ),
    }))
  }

  function updateHoldingCurrency(idx: number, currency: 'USD' | 'TWD') {
    setForm((f) => ({
      ...f,
      holdings: f.holdings.map((h, i) => (i === idx ? { ...h, currency } : h)),
    }))
  }

  function toggleTrigger(trigger: RebalanceTrigger) {
    setForm((f) => {
      const exists = f.rebalanceTriggers.includes(trigger)
      return {
        ...f,
        rebalanceTriggers: exists
          ? f.rebalanceTriggers.filter((t) => t !== trigger)
          : [...f.rebalanceTriggers, trigger],
      }
    })
  }

  // ─── Run backtest ──────────────────────────────────────────────────────────

  async function handleRunBacktest() {
    reset()
    setRunning(true)
    setError(null)
    setProgress(0)

    try {
      const tickers = form.holdings.map((h) => h.ticker)
      const needsFx = form.holdings.some((h) => h.currency !== form.dcaCurrency)

      // Fetch prices for all tickers
      const priceData = await fetchMultiplePrices(tickers, form.startDate, form.endDate)
      setProgress(60)

      // Validate
      const missingTickers = tickers.filter((t) => priceData[t].length === 0)
      if (missingTickers.length > 0) {
        throw new Error(`No price data found for: ${missingTickers.join(', ')}. Check the ticker symbols.`)
      }

      // Fetch FX rates if needed
      const fxRates = needsFx ? await fetchFxRate(form.startDate, form.endDate) : []
      setProgress(75)

      // Build the Build object
      const buildId = editBuild?.id ?? crypto.randomUUID()
      const now = new Date()
      const build: Build = {
        id: buildId,
        name: form.name.trim(),
        holdings: form.holdings,
        dcaAmount: parseFloat(form.dcaAmount),
        dcaCurrency: form.dcaCurrency,
        dcaFrequency: form.dcaFrequency,
        startDate: new Date(form.startDate + 'T00:00:00Z'),
        endDate: new Date(form.endDate + 'T00:00:00Z'),
        rebalanceStrategy: form.rebalanceStrategy,
        rebalanceTriggers: form.rebalanceTriggers,
        thresholdPct: form.rebalanceTriggers.includes('threshold')
          ? parseFloat(form.thresholdPct) || 5
          : undefined,
        periodicFrequency: form.rebalanceTriggers.includes('periodic')
          ? form.periodicFrequency
          : undefined,
        isFavorite: editBuild?.isFavorite ?? false,
        createdAt: editBuild?.createdAt ?? now,
        updatedAt: now,
      }

      // Run simulation
      const result = runBacktest(build, priceData, fxRates)
      setProgress(90)

      // Persist
      const buildWithResult: Build = { ...build, lastBacktestResult: result }
      await db.builds.put(buildWithResult)
      setProgress(100)

      onDone(buildId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backtest failed. Please try again.')
    } finally {
      setRunning(false)
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b">
        <button onClick={onCancel} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold leading-tight">
            {editBuild ? 'Edit Build' : 'New Build'}
          </h1>
          <StepIndicator current={step} total={4} />
        </div>
        <span className="text-xs text-muted-foreground">Step {step} of 4</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {step === 1 && <Step1Name form={form} setForm={setForm} />}
        {step === 2 && (
          <Step2Holdings
            form={form}
            setForm={setForm}
            tickerQuery={tickerQuery}
            setTickerQuery={setTickerQuery}
            selectedResult={selectedResult}
            setSelectedResult={setSelectedResult}
            dropdownOpen={dropdownOpen}
            searchRef={searchRef}
            results={results}
            searchLoading={searchLoading}
            apiStatus={apiStatus}
            allocationSum={allocationSum}
            allocationRemaining={allocationRemaining}
            addHolding={addHolding}
            removeHolding={removeHolding}
            updateHoldingAllocation={updateHoldingAllocation}
            updateHoldingCurrency={updateHoldingCurrency}
          />
        )}
        {step === 3 && <Step3DCA form={form} setForm={setForm} />}
        {step === 4 && (
          <Step4Rebalance
            form={form}
            toggleTrigger={toggleTrigger}
            setForm={setForm}
            isRunning={isRunning}
            progress={progress}
            error={error}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 p-4 border-t bg-background">
        {step > 1 ? (
          <Button
            variant="outline"
            onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3 | 4)}
            disabled={isRunning}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        ) : (
          <div />
        )}

        {step < 4 ? (
          <Button
            onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3 | 4)}
            disabled={
              (step === 1 && !step1Valid) ||
              (step === 2 && !step2Valid) ||
              (step === 3 && !step3Valid)
            }
          >
            Next
            <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        ) : (
          <Button
            onClick={handleRunBacktest}
            disabled={!step4Valid || isRunning}
            className="min-w-[140px]"
          >
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running… {progress}%
              </>
            ) : (
              'Run Backtest'
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Step 1: Name ─────────────────────────────────────────────────────────────

function Step1Name({
  form,
  setForm,
}: {
  form: BuildForm
  setForm: React.Dispatch<React.SetStateAction<BuildForm>>
}) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Name your build</h2>
        <p className="text-sm text-muted-foreground">Give this portfolio configuration a descriptive name.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="build-name">Build name</Label>
        <Input
          id="build-name"
          placeholder="e.g. 10-ETF Core, Simple 3-Fund"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          autoFocus
        />
      </div>
    </div>
  )
}

// ─── Step 2: Holdings ─────────────────────────────────────────────────────────

function Step2Holdings({
  form,
  tickerQuery,
  setTickerQuery,
  selectedResult,
  setSelectedResult,
  dropdownOpen,
  searchRef,
  results,
  searchLoading,
  apiStatus,
  allocationSum,
  allocationRemaining,
  addHolding,
  removeHolding,
  updateHoldingAllocation,
  updateHoldingCurrency,
}: {
  form: BuildForm
  setForm: React.Dispatch<React.SetStateAction<BuildForm>>
  tickerQuery: string
  setTickerQuery: (v: string) => void
  selectedResult: TickerSearchResult | null
  setSelectedResult: (r: TickerSearchResult | null) => void
  dropdownOpen: boolean
  searchRef: React.RefObject<HTMLDivElement>
  results: TickerSearchResult[]
  searchLoading: boolean
  apiStatus: string
  allocationSum: number
  allocationRemaining: number
  addHolding: () => void
  removeHolding: (idx: number) => void
  updateHoldingAllocation: (idx: number, value: string) => void
  updateHoldingCurrency: (idx: number, currency: 'USD' | 'TWD') => void
}) {
  const allocationValid = Math.abs(allocationRemaining) < 0.01

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Add holdings</h2>
        <p className="text-sm text-muted-foreground">Search for tickers and set target allocation percentages (must sum to 100%).</p>
      </div>

      {/* Ticker search */}
      <div ref={searchRef} className="relative">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Input
              placeholder="Search ticker (e.g. VOO, QQQ)"
              value={tickerQuery}
              onChange={(e) => {
                setTickerQuery(e.target.value)
                setSelectedResult(null)
              }}
            />
            {searchLoading && (
              <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={addHolding}
            disabled={!selectedResult}
            aria-label="Add holding"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Search status feedback */}
        {!searchLoading && tickerQuery.length >= 2 && results.length === 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {apiStatus === 'offline-no-cache'
              ? 'API unavailable — run vercel dev to enable ticker search'
              : 'No results found'}
          </p>
        )}

        {/* Search dropdown */}
        {dropdownOpen && results.length > 0 && (
          <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-md border bg-popover shadow-md">
            {results.map((r) => (
              <button
                key={r.ticker}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
                onClick={() => {
                  setSelectedResult(r)
                  setTickerQuery(`${r.ticker} — ${r.name}`)
                }}
              >
                <span className="font-mono font-semibold text-sm text-primary">{r.ticker}</span>
                <span className="flex-1 text-sm truncate">{r.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">{r.exchange}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Holdings table */}
      {form.holdings.length > 0 && (
        <div className="space-y-2">
          {form.holdings.map((h, i) => (
            <div
              key={`${h.ticker}-${i}`}
              className="flex items-center gap-2 p-2 rounded-lg border bg-card"
            >
              <div className="flex-1 min-w-0">
                <p className="font-mono font-semibold text-sm">{h.ticker}</p>
                <p className="text-xs text-muted-foreground truncate">{h.name}</p>
              </div>

              {/* Currency toggle */}
              <div className="flex rounded-md border overflow-hidden shrink-0">
                {(['USD', 'TWD'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => updateHoldingCurrency(i, c)}
                    className={cn(
                      'px-2 py-1 text-xs font-medium transition-colors',
                      h.currency === c
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Allocation input */}
              <div className="flex items-center gap-1 shrink-0">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={h.targetAllocationPct || ''}
                  onChange={(e) => updateHoldingAllocation(i, e.target.value)}
                  className="w-16 h-8 text-center text-sm"
                  placeholder="0"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>

              <button
                onClick={() => removeHolding(i)}
                className="shrink-0 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                aria-label="Remove holding"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}

          {/* Allocation summary */}
          <div className={cn(
            'flex items-center justify-between px-2 py-1.5 rounded text-sm font-medium',
            allocationValid
              ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
              : allocationRemaining < 0
                ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
                : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400',
          )}>
            <span>Total: {allocationSum.toFixed(1)}%</span>
            <span>
              {allocationValid
                ? '✓ Allocation complete'
                : allocationRemaining > 0
                  ? `${allocationRemaining.toFixed(1)}% remaining`
                  : `${Math.abs(allocationRemaining).toFixed(1)}% over 100%`}
            </span>
          </div>
        </div>
      )}

      {form.holdings.length === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Search for tickers above to add holdings to your portfolio.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── Step 3: DCA settings ─────────────────────────────────────────────────────

function Step3DCA({
  form,
  setForm,
}: {
  form: BuildForm
  setForm: React.Dispatch<React.SetStateAction<BuildForm>>
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">DCA settings</h2>
        <p className="text-sm text-muted-foreground">Configure contribution amount, frequency, and date range.</p>
      </div>

      {/* Amount + currency */}
      <div className="space-y-1.5">
        <Label>Contribution amount</Label>
        <div className="flex gap-2">
          <Input
            type="number"
            min="1"
            step="100"
            value={form.dcaAmount}
            onChange={(e) => setForm((f) => ({ ...f, dcaAmount: e.target.value }))}
            className="flex-1"
            placeholder="1000"
          />
          <div className="flex rounded-md border overflow-hidden">
            {(['USD', 'TWD'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setForm((f) => ({ ...f, dcaCurrency: c }))}
                className={cn(
                  'px-3 py-2 text-sm font-medium transition-colors',
                  form.dcaCurrency === c
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-accent',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Frequency */}
      <div className="space-y-1.5">
        <Label>Frequency</Label>
        <RadioGroup
          value={form.dcaFrequency}
          onValueChange={(v) => setForm((f) => ({ ...f, dcaFrequency: v as BuildForm['dcaFrequency'] }))}
          className="flex gap-4"
        >
          {(['weekly', 'biweekly', 'monthly'] as const).map((freq) => (
            <div key={freq} className="flex items-center gap-1.5">
              <RadioGroupItem value={freq} id={`freq-${freq}`} />
              <Label htmlFor={`freq-${freq}`} className="capitalize font-normal cursor-pointer">
                {freq}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      {/* Date range */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="start-date">Start date</Label>
          <input
            id="start-date"
            type="date"
            max={today}
            value={form.startDate}
            onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end-date">End date</Label>
          <input
            id="end-date"
            type="date"
            max={today}
            value={form.endDate}
            onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

      {form.startDate > form.endDate && (
        <p className="text-sm text-destructive">Start date must be before end date.</p>
      )}
    </div>
  )
}

// ─── Step 4: Rebalance settings ───────────────────────────────────────────────

function Step4Rebalance({
  form,
  toggleTrigger,
  setForm,
  isRunning,
  progress,
  error,
}: {
  form: BuildForm
  toggleTrigger: (t: RebalanceTrigger) => void
  setForm: React.Dispatch<React.SetStateAction<BuildForm>>
  isRunning: boolean
  progress: number
  error: string | null
}) {
  const triggers: { value: RebalanceTrigger; label: string; description: string }[] = [
    { value: 'on-dca', label: 'On every DCA', description: 'Rebalance on every contribution' },
    { value: 'periodic', label: 'On a schedule', description: 'Rebalance at regular intervals' },
    { value: 'threshold', label: 'On drift breach', description: 'Rebalance when drift exceeds threshold' },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Rebalance settings</h2>
        <p className="text-sm text-muted-foreground">Choose your rebalancing strategy and when it triggers.</p>
      </div>

      {/* Strategy */}
      <div className="space-y-2">
        <Label>Strategy</Label>
        <RadioGroup
          value={form.rebalanceStrategy}
          onValueChange={(v) => setForm((f) => ({ ...f, rebalanceStrategy: v as 'soft' | 'hard' }))}
          className="space-y-2"
        >
          <div className="flex items-start gap-3 p-3 rounded-lg border has-[:checked]:border-primary has-[:checked]:bg-primary/5 transition-colors">
            <RadioGroupItem value="soft" id="strategy-soft" className="mt-0.5" />
            <Label htmlFor="strategy-soft" className="cursor-pointer">
              <span className="font-medium">Soft (buy-only)</span>
              <p className="text-xs text-muted-foreground font-normal mt-0.5">
                Only buy to rebalance — allocate DCA cash to underweight holdings
              </p>
            </Label>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg border has-[:checked]:border-primary has-[:checked]:bg-primary/5 transition-colors">
            <RadioGroupItem value="hard" id="strategy-hard" className="mt-0.5" />
            <Label htmlFor="strategy-hard" className="cursor-pointer">
              <span className="font-medium">Hard (sell + buy)</span>
              <p className="text-xs text-muted-foreground font-normal mt-0.5">
                Sell overweight holdings and buy underweight to reach target allocations
              </p>
            </Label>
          </div>
        </RadioGroup>
      </div>

      {/* Triggers */}
      <div className="space-y-2">
        <Label>Trigger conditions <span className="text-muted-foreground font-normal">(select at least one)</span></Label>
        <div className="space-y-1.5">
          {triggers.map((t) => (
            <div key={t.value}>
              <label className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-accent/40 transition-colors">
                <Checkbox
                  checked={form.rebalanceTriggers.includes(t.value)}
                  onCheckedChange={() => toggleTrigger(t.value)}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium">{t.label}</p>
                  <p className="text-xs text-muted-foreground">{t.description}</p>
                </div>
              </label>

              {/* Conditional: periodic frequency */}
              {t.value === 'periodic' && form.rebalanceTriggers.includes('periodic') && (
                <div className="mt-1.5 ml-9 flex items-center gap-2">
                  <Label htmlFor="periodic-freq" className="text-xs whitespace-nowrap">Schedule:</Label>
                  <Select
                    value={form.periodicFrequency}
                    onValueChange={(v) => setForm((f) => ({ ...f, periodicFrequency: v as BuildForm['periodicFrequency'] }))}
                  >
                    <SelectTrigger id="periodic-freq" className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="annually">Annually</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Conditional: threshold % */}
              {t.value === 'threshold' && form.rebalanceTriggers.includes('threshold') && (
                <div className="mt-1.5 ml-9 flex items-center gap-2">
                  <Label htmlFor="threshold-pct" className="text-xs whitespace-nowrap">Drift threshold:</Label>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">±</span>
                    <Input
                      id="threshold-pct"
                      type="number"
                      min="1"
                      max="50"
                      step="1"
                      value={form.thresholdPct}
                      onChange={(e) => setForm((f) => ({ ...f, thresholdPct: e.target.value }))}
                      className="w-16 h-8 text-center text-sm"
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {form.rebalanceTriggers.length === 0 && (
          <p className="text-xs text-destructive">Select at least one trigger condition.</p>
        )}
      </div>

      {/* Error display */}
      {error && !isRunning && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
          <p className="text-sm text-destructive font-medium">Backtest failed</p>
          <p className="text-xs text-destructive/80 mt-0.5">{error}</p>
        </div>
      )}

      {/* Progress bar during run */}
      {isRunning && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Fetching data and running simulation…</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
