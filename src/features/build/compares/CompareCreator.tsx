import { useState } from 'react'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { fetchMultiplePrices, fetchFxRate } from '@/services/yahooFinance'
import { db } from '@/db/database'
import { useBuilds, useBenchmarks } from '@/db/buildHooks'
import { useBacktestStore } from '@/stores/backtestStore'
import { runCompare } from '@/engine/compare'
import type { Compare, CompareItem } from '@/types'

interface CompareCreatorProps {
  onDone: (id: string) => void
  onCancel: () => void
  editCompare?: Compare
}

function fmtPct(value: number | null | undefined): string {
  if (value == null) return ''
  const sign = value >= 0 ? '+' : ''
  return ` · ${sign}${value.toFixed(1)}%`
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2, 3].map((i) => (
        <div key={i} className={cn(
          'h-1.5 rounded-full transition-all',
          i === current ? 'w-6 bg-primary' : i < current ? 'w-3 bg-primary/50' : 'w-3 bg-muted',
        )} />
      ))}
    </div>
  )
}

export function CompareCreator({ onDone, onCancel, editCompare }: CompareCreatorProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [name, setName] = useState(editCompare?.name ?? '')
  const [selectedItems, setSelectedItems] = useState<CompareItem[]>(editCompare?.items ?? [])

  const builds = useBuilds()
  const benchmarks = useBenchmarks()
  const { isRunning, progress, error, setRunning, setProgress, setError, reset } = useBacktestStore()

  function toggleItem(item: CompareItem) {
    setSelectedItems((prev) => {
      const exists = prev.some((i) => i.refId === item.refId && i.type === item.type)
      if (exists) return prev.filter((i) => !(i.refId === item.refId && i.type === item.type))
      if (prev.length >= 4) return prev  // max 4
      return [...prev, item]
    })
  }

  function isSelected(item: CompareItem): boolean {
    return selectedItems.some((i) => i.refId === item.refId && i.type === item.type)
  }

  // Determine aligned params for preview in step 3
  function getAlignedPreview(): string {
    const firstBuild = selectedItems
      .filter((i) => i.type === 'build')
      .map((i) => builds.find((b) => b.id === i.refId))
      .find(Boolean)
    if (firstBuild) {
      const start = firstBuild.startDate instanceof Date
        ? firstBuild.startDate.toISOString().slice(0, 10)
        : String(firstBuild.startDate).slice(0, 10)
      const end = firstBuild.endDate instanceof Date
        ? firstBuild.endDate.toISOString().slice(0, 10)
        : String(firstBuild.endDate).slice(0, 10)
      return `$${firstBuild.dcaAmount} ${firstBuild.dcaCurrency} · ${firstBuild.dcaFrequency} · ${start} → ${end}`
    }
    const firstBm = selectedItems
      .filter((i) => i.type === 'benchmark')
      .map((i) => benchmarks.find((b) => b.id === i.refId))
      .find(Boolean)
    if (firstBm) {
      const start = firstBm.startDate instanceof Date
        ? firstBm.startDate.toISOString().slice(0, 10)
        : String(firstBm.startDate).slice(0, 10)
      const end = firstBm.endDate instanceof Date
        ? firstBm.endDate.toISOString().slice(0, 10)
        : String(firstBm.endDate).slice(0, 10)
      return `$1,000 USD · monthly · ${start} → ${end}`
    }
    return '—'
  }

  async function handleRun() {
    reset()
    setRunning(true)
    setError(null)
    setProgress(0)

    try {
      const compare: Compare = {
        id: editCompare?.id ?? crypto.randomUUID(),
        name: name.trim(),
        items: selectedItems,
        isFavorite: editCompare?.isFavorite ?? false,
        createdAt: editCompare?.createdAt ?? new Date(),
      }

      // Collect all tickers needed
      const allTickers = new Set<string>()
      for (const item of selectedItems) {
        if (item.type === 'build') {
          const b = builds.find((b) => b.id === item.refId)
          b?.holdings.forEach((h) => allTickers.add(h.ticker))
        } else {
          const bm = benchmarks.find((b) => b.id === item.refId)
          if (bm) allTickers.add(bm.ticker)
        }
      }

      // Determine date range (from aligned params — first Build or first Benchmark)
      const firstBuild = selectedItems
        .filter((i) => i.type === 'build')
        .map((i) => builds.find((b) => b.id === i.refId))
        .find(Boolean)
      const firstBm = selectedItems
        .filter((i) => i.type === 'benchmark')
        .map((i) => benchmarks.find((b) => b.id === i.refId))
        .find(Boolean)

      const anchor = firstBuild ?? firstBm
      if (!anchor) throw new Error('No valid items selected.')

      const startDate = anchor.startDate instanceof Date
        ? anchor.startDate.toISOString().slice(0, 10)
        : String(anchor.startDate).slice(0, 10)
      const endDate = anchor.endDate instanceof Date
        ? anchor.endDate.toISOString().slice(0, 10)
        : String(anchor.endDate).slice(0, 10)

      const allPriceData = await fetchMultiplePrices([...allTickers], startDate, endDate)
      setProgress(60)

      const needsFx = [...selectedItems].some((item) => {
        if (item.type === 'build') {
          const b = builds.find((b) => b.id === item.refId)
          return b?.holdings.some((h) => h.currency !== b.dcaCurrency)
        }
        const bm = benchmarks.find((b) => b.id === item.refId)
        return bm?.currency === 'TWD'
      })

      const fxRates = needsFx ? await fetchFxRate(startDate, endDate) : []
      setProgress(75)

      const result = runCompare(compare, builds, benchmarks, allPriceData, fxRates)
      setProgress(90)

      await db.compares.put({ ...compare, lastCompareResult: result })
      setProgress(100)

      onDone(compare.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compare failed. Please try again.')
    } finally {
      setRunning(false)
    }
  }

  const step1Valid = name.trim().length > 0
  const step2Valid = selectedItems.length >= 2 && selectedItems.length <= 4
  const step3Valid = step2Valid

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b">
        <button onClick={onCancel} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold leading-tight">
            {editCompare ? 'Edit Compare' : 'New Compare'}
          </h1>
          <StepIndicator current={step} />
        </div>
        <span className="text-xs text-muted-foreground">Step {step} of 3</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Step 1: Name */}
        {step === 1 && (
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">Name your comparison</h2>
              <p className="text-sm text-muted-foreground">Give this comparison a descriptive name.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="compare-name">Name</Label>
              <Input
                id="compare-name"
                placeholder="e.g. Core vs VOO vs QQQ"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
          </div>
        )}

        {/* Step 2: Select items */}
        {step === 2 && (
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">Select items to compare</h2>
              <p className="text-sm text-muted-foreground">
                Choose 2–4 Builds or Benchmarks.{' '}
                <span className={cn(
                  'font-medium',
                  selectedItems.length >= 2 ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground',
                )}>
                  {selectedItems.length}/4 selected
                </span>
              </p>
            </div>

            {builds.length === 0 && benchmarks.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No builds or benchmarks yet. Create some first.
              </p>
            ) : (
              <div className="space-y-2">
                {builds.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Builds</p>
                    {builds.map((b) => {
                      const item: CompareItem = { type: 'build', refId: b.id }
                      const checked = isSelected(item)
                      const disabled = !checked && selectedItems.length >= 4
                      return (
                        <label
                          key={b.id}
                          className={cn(
                            'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                            checked ? 'border-primary bg-primary/5' : 'hover:bg-accent/40',
                            disabled && 'opacity-40 cursor-not-allowed',
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => !disabled && toggleItem(item)}
                            disabled={disabled}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{b.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {b.holdings.length} holdings · {b.dcaFrequency} ${b.dcaAmount}
                              {fmtPct(b.lastBacktestResult?.summary.totalReturnPct)}
                            </p>
                          </div>
                        </label>
                      )
                    })}
                  </>
                )}

                {benchmarks.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mt-2">Benchmarks</p>
                    {benchmarks.map((bm) => {
                      const item: CompareItem = { type: 'benchmark', refId: bm.id }
                      const checked = isSelected(item)
                      const disabled = !checked && selectedItems.length >= 4
                      return (
                        <label
                          key={bm.id}
                          className={cn(
                            'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                            checked ? 'border-primary bg-primary/5' : 'hover:bg-accent/40',
                            disabled && 'opacity-40 cursor-not-allowed',
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => !disabled && toggleItem(item)}
                            disabled={disabled}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium font-mono">{bm.ticker}
                              <span className="font-sans font-normal text-muted-foreground"> — {bm.name}</span>
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Benchmark{fmtPct(bm.lastBacktestResult?.summary.totalReturnPct)}
                            </p>
                          </div>
                        </label>
                      )
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 3: Review + run */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">Review & run</h2>
              <p className="text-sm text-muted-foreground">
                All items will be run with aligned DCA parameters.
              </p>
            </div>

            {/* Selected items */}
            <div className="space-y-2">
              {selectedItems.map((item, idx) => {
                const label = item.type === 'build'
                  ? builds.find((b) => b.id === item.refId)?.name ?? item.refId
                  : benchmarks.find((b) => b.id === item.refId)?.ticker ?? item.refId
                const badge = item.type === 'build' ? 'Build' : 'Benchmark'
                return (
                  <div key={`${item.type}-${item.refId}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-card text-sm">
                    <span className="text-xs text-muted-foreground w-4">{idx + 1}.</span>
                    <span className="font-medium flex-1 truncate">{label}</span>
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{badge}</span>
                  </div>
                )
              })}
            </div>

            {/* Aligned params */}
            <div className="p-3 rounded-lg bg-muted/50 border text-sm space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Aligned to (first item's params)</p>
              <p className="font-mono text-xs">{getAlignedPreview()}</p>
            </div>

            {/* Error */}
            {error && !isRunning && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-destructive font-medium">Compare failed</p>
                <p className="text-xs text-destructive/80 mt-0.5">{error}</p>
              </div>
            )}

            {/* Progress */}
            {isRunning && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Fetching data and running comparisons…</span>
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
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 p-4 border-t bg-background">
        {step > 1 ? (
          <Button variant="outline" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)} disabled={isRunning}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        ) : (
          <div />
        )}

        {step < 3 ? (
          <Button
            onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
            disabled={(step === 1 && !step1Valid) || (step === 2 && !step2Valid)}
          >
            Next
            <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        ) : (
          <Button onClick={handleRun} disabled={!step3Valid || isRunning} className="min-w-[140px]">
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running… {progress}%
              </>
            ) : (
              'Run Compare'
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
