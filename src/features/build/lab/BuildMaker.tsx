import { useState, useRef, useEffect } from 'react'
import { Plus, X, Loader2, ChevronDown, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useTickerSearch, detectCurrency } from '@/services/yahooFinance'
import { db } from '@/db/database'
import { useBuilds } from '@/db/buildHooks'
import { useUIStore } from '@/stores/uiStore'
import type { Build, BuildForm, BuildHolding, RebalanceTrigger, TickerSearchResult } from '@/types'

interface BuildMakerProps {
  side: 'A' | 'B'
  config: BuildForm
  loadedBuildId?: string
  isStale: boolean
  isRunning: boolean
  error: string | null
  onConfigChange: (update: Partial<BuildForm>) => void
  onLoad: (build: Build) => void
  onRunBacktest: () => void
}

const SIDE_LABEL = { A: 'Build A', B: 'Build B' } as const

export function BuildMaker({
  side,
  config,
  loadedBuildId,
  isStale,
  isRunning,
  error,
  onConfigChange,
  onLoad,
  onRunBacktest,
}: BuildMakerProps) {
  const builds = useBuilds()
  const apiStatus = useUIStore((s) => s.apiStatus)

  // ─── Ticker search state ───────────────────────────────────────────────────
  const [tickerQuery, setTickerQuery] = useState('')
  const [selectedResult, setSelectedResult] = useState<TickerSearchResult | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const { results, isLoading: searchLoading } = useTickerSearch(tickerQuery)

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

  // ─── Load dropdown state ───────────────────────────────────────────────────
  const [loadOpen, setLoadOpen] = useState(false)
  const loadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (loadRef.current && !loadRef.current.contains(e.target as Node)) {
        setLoadOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ─── Save dropdown state ───────────────────────────────────────────────────
  const [saveOpen, setSaveOpen] = useState(false)
  const saveRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) {
        setSaveOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ─── Allocation validation ─────────────────────────────────────────────────
  const allocationSum = config.holdings.reduce((s, h) => s + h.targetAllocationPct, 0)
  const allocationRemaining = 100 - allocationSum
  const allocationValid = Math.abs(allocationRemaining) < 0.01

  // ─── Holdings management ───────────────────────────────────────────────────
  function addHolding() {
    if (!selectedResult) return
    const currency = detectCurrency(selectedResult)
    const next: BuildHolding = {
      ticker: selectedResult.ticker,
      name: selectedResult.name,
      currency,
      targetAllocationPct: 0,
    }
    onConfigChange({ holdings: [...config.holdings, next] })
    setTickerQuery('')
    setSelectedResult(null)
    setDropdownOpen(false)
  }

  function removeHolding(idx: number) {
    onConfigChange({ holdings: config.holdings.filter((_, i) => i !== idx) })
  }

  function updateAllocation(idx: number, value: string) {
    const parsed = parseFloat(value)
    const pct = isNaN(parsed) ? 0 : Math.max(0, parsed)
    onConfigChange({
      holdings: config.holdings.map((h, i) => (i === idx ? { ...h, targetAllocationPct: pct } : h)),
    })
  }

  function updateCurrency(idx: number, currency: 'USD' | 'TWD') {
    onConfigChange({
      holdings: config.holdings.map((h, i) => (i === idx ? { ...h, currency } : h)),
    })
  }

  function toggleTrigger(trigger: RebalanceTrigger) {
    const exists = config.rebalanceTriggers.includes(trigger)
    onConfigChange({
      rebalanceTriggers: exists
        ? config.rebalanceTriggers.filter((t) => t !== trigger)
        : [...config.rebalanceTriggers, trigger],
    })
  }

  // ─── Load from Build ───────────────────────────────────────────────────────
  function handleLoad(build: Build) {
    onLoad(build)
    setLoadOpen(false)
  }

  // ─── Save ──────────────────────────────────────────────────────────────────
  async function saveAsNew() {
    const now = new Date()
    const newBuild: Build = {
      id: crypto.randomUUID(),
      name: config.name || `Lab ${side} ${now.toLocaleDateString()}`,
      holdings: config.holdings,
      dcaAmount: parseFloat(config.dcaAmount) || 1000,
      dcaCurrency: config.dcaCurrency,
      dcaFrequency: config.dcaFrequency,
      startDate: new Date(config.startDate + 'T00:00:00Z'),
      endDate: new Date(config.endDate + 'T00:00:00Z'),
      rebalanceStrategy: config.rebalanceStrategy,
      rebalanceTriggers: config.rebalanceTriggers,
      thresholdPct: config.rebalanceTriggers.includes('threshold')
        ? parseFloat(config.thresholdPct) || 5
        : undefined,
      periodicFrequency: config.rebalanceTriggers.includes('periodic')
        ? config.periodicFrequency
        : undefined,
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    }
    await db.builds.add(newBuild)
    setSaveOpen(false)
  }

  async function updateExisting() {
    if (!loadedBuildId) return
    const existing = await db.builds.get(loadedBuildId)
    if (!existing) return
    const updated: Build = {
      ...existing,
      name: config.name || existing.name,
      holdings: config.holdings,
      rebalanceStrategy: config.rebalanceStrategy,
      rebalanceTriggers: config.rebalanceTriggers,
      thresholdPct: config.rebalanceTriggers.includes('threshold')
        ? parseFloat(config.thresholdPct) || 5
        : undefined,
      periodicFrequency: config.rebalanceTriggers.includes('periodic')
        ? config.periodicFrequency
        : undefined,
      updatedAt: new Date(),
    }
    await db.builds.put(updated)
    setSaveOpen(false)
  }

  const loadedBuild = builds.find((b) => b.id === loadedBuildId)
  const triggersValid = config.rebalanceStrategy === 'none' || config.rebalanceTriggers.length > 0
  const canRun = config.holdings.length > 0 && allocationValid && triggersValid && !isRunning

  const triggers: { value: RebalanceTrigger; label: string }[] = [
    { value: 'on-dca', label: 'On every DCA' },
    { value: 'periodic', label: 'On a schedule' },
    { value: 'threshold', label: 'On drift breach' },
  ]

  return (
    <div className="flex flex-col gap-3">
      {/* Header: Load + Save */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{SIDE_LABEL[side]}</span>
        {isStale && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-1.5 py-0.5">
            stale
          </span>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          {/* Load dropdown */}
          <div ref={loadRef} className="relative">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={() => setLoadOpen((o) => !o)}
            >
              Load
              <ChevronDown className="h-3 w-3" />
            </Button>
            {loadOpen && builds.length > 0 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setLoadOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 w-52 rounded-md border bg-background shadow-md py-1 max-h-56 overflow-y-auto">
                  {builds.map((b) => (
                    <button
                      key={b.id}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                        b.id === loadedBuildId && 'bg-primary/10 font-medium',
                      )}
                      onClick={() => handleLoad(b)}
                    >
                      {b.isFavorite && <span className="mr-1">★</span>}
                      {b.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            {loadOpen && builds.length === 0 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setLoadOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 w-40 rounded-md border bg-background shadow-md py-2 px-3 text-xs text-muted-foreground">
                  No builds yet
                </div>
              </>
            )}
          </div>

          {/* Save dropdown */}
          <div ref={saveRef} className="relative">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={() => setSaveOpen((o) => !o)}
              disabled={config.holdings.length === 0}
            >
              <Save className="h-3 w-3" />
              Save
              <ChevronDown className="h-3 w-3" />
            </Button>
            {saveOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSaveOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 w-44 rounded-md border bg-background shadow-md py-1">
                  <button
                    className="w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors"
                    onClick={() => void saveAsNew()}
                  >
                    Save as new Build
                  </button>
                  {loadedBuild && (
                    <button
                      className="w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors"
                      onClick={() => void updateExisting()}
                    >
                      Update "{loadedBuild.name.slice(0, 18)}{loadedBuild.name.length > 18 ? '…' : ''}"
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Name field */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Name (optional)</Label>
        <Input
          placeholder={`Build ${side}`}
          value={config.name}
          onChange={(e) => onConfigChange({ name: e.target.value })}
          className="h-8 text-sm"
        />
      </div>

      {/* ─── Holdings ───────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label className="text-xs font-medium">Holdings</Label>

        {/* Ticker search */}
        <div ref={searchRef} className="relative">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Input
                placeholder="Search ticker (e.g. VOO)"
                value={tickerQuery}
                onChange={(e) => { setTickerQuery(e.target.value); setSelectedResult(null) }}
                className="h-8 text-sm"
              />
              {searchLoading && (
                <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={addHolding}
              disabled={!selectedResult}
              className="h-8 w-8"
              aria-label="Add holding"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {!searchLoading && tickerQuery.length >= 2 && results.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {apiStatus === 'offline-no-cache' ? 'API unavailable' : 'No results found'}
            </p>
          )}

          {dropdownOpen && results.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-md border bg-popover shadow-md">
              {results.map((r) => (
                <button
                  key={r.ticker}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
                  onClick={() => { setSelectedResult(r); setTickerQuery(`${r.ticker} — ${r.name}`) }}
                >
                  <span className="font-mono font-semibold text-xs text-primary">{r.ticker}</span>
                  <span className="flex-1 text-xs truncate">{r.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{r.exchange}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Holdings list */}
        {config.holdings.length > 0 && (
          <div className="space-y-1.5">
            {config.holdings.map((h, i) => (
              <div key={`${h.ticker}-${i}`} className="flex items-center gap-2 px-2 py-1.5 rounded-md border bg-card">
                <div className="flex-1 min-w-0">
                  <p className="font-mono font-semibold text-xs">{h.ticker}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{h.name}</p>
                </div>
                {/* Currency toggle */}
                <div className="flex rounded border overflow-hidden shrink-0">
                  {(['USD', 'TWD'] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => updateCurrency(i, c)}
                      className={cn(
                        'px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                        h.currency === c
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                {/* Allocation % */}
                <div className="flex items-center gap-1 shrink-0">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={h.targetAllocationPct || ''}
                    onChange={(e) => updateAllocation(i, e.target.value)}
                    className="w-14 h-7 text-center text-xs p-1"
                    placeholder="0"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
                <button
                  onClick={() => removeHolding(i)}
                  className="shrink-0 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                  aria-label="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {/* Allocation summary */}
            <div
              className={cn(
                'flex items-center justify-between px-2 py-1 rounded text-xs font-medium',
                allocationValid
                  ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
                  : allocationRemaining < 0
                    ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400',
              )}
            >
              <span>{allocationSum.toFixed(1)}% total</span>
              <span>
                {allocationValid
                  ? '✓ Complete'
                  : allocationRemaining > 0
                    ? `${allocationRemaining.toFixed(1)}% remaining`
                    : `${Math.abs(allocationRemaining).toFixed(1)}% over`}
              </span>
            </div>
          </div>
        )}

        {config.holdings.length === 0 && (
          <Card>
            <CardContent className="py-4 text-center text-xs text-muted-foreground">
              Add holdings to build a portfolio
            </CardContent>
          </Card>
        )}
      </div>

      {/* ─── Rebalance Strategy ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Rebalance Strategy</Label>
        <RadioGroup
          value={config.rebalanceStrategy}
          onValueChange={(v) => onConfigChange({ rebalanceStrategy: v as BuildForm['rebalanceStrategy'] })}
          className="flex gap-3"
        >
          {(['soft', 'hard', 'none'] as const).map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <RadioGroupItem value={s} id={`${side}-strategy-${s}`} className="h-3.5 w-3.5" />
              <Label htmlFor={`${side}-strategy-${s}`} className="text-xs font-normal cursor-pointer capitalize">
                {s}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      {/* ─── Triggers ───────────────────────────────────────────────────────── */}
      {config.rebalanceStrategy !== 'none' && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Triggers</Label>
          <div className="space-y-1">
            {triggers.map((t) => (
              <div key={t.value}>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={config.rebalanceTriggers.includes(t.value)}
                    onCheckedChange={() => toggleTrigger(t.value)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-xs">{t.label}</span>
                </label>

                {t.value === 'periodic' && config.rebalanceTriggers.includes('periodic') && (
                  <div className="mt-1 ml-5 flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">Schedule:</span>
                    <Select
                      value={config.periodicFrequency}
                      onValueChange={(v) => onConfigChange({ periodicFrequency: v as BuildForm['periodicFrequency'] })}
                    >
                      <SelectTrigger className="h-6 text-xs w-28">
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

                {t.value === 'threshold' && config.rebalanceTriggers.includes('threshold') && (
                  <div className="mt-1 ml-5 flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">±</span>
                    <Input
                      type="number"
                      min="1"
                      max="50"
                      step="1"
                      value={config.thresholdPct}
                      onChange={(e) => onConfigChange({ thresholdPct: e.target.value })}
                      className="w-12 h-6 text-center text-xs p-1"
                    />
                    <span className="text-[10px] text-muted-foreground">%</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="p-2 rounded-md bg-destructive/10 border border-destructive/20">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {/* ─── Run button ─────────────────────────────────────────────────────── */}
      <Button
        onClick={onRunBacktest}
        disabled={!canRun}
        size="sm"
        className="w-full"
      >
        {isRunning ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Running…
          </>
        ) : (
          'Update Backtest'
        )}
      </Button>
    </div>
  )
}
