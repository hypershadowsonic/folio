import { useState, useRef, useEffect } from 'react'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useTickerSearch, fetchPrices } from '@/services/yahooFinance'
import { db } from '@/db/database'
import { useBacktestStore } from '@/stores/backtestStore'
import { useUIStore } from '@/stores/uiStore'
import { runBenchmark } from '@/engine/backtest'
import type { Benchmark, TickerSearchResult } from '@/types'

interface BenchmarkCreatorProps {
  onDone: (id: string) => void
  onCancel: () => void
  editBenchmark?: Benchmark
}

const today = new Date().toISOString().slice(0, 10)

function defaultStartDate(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 5)
  return d.toISOString().slice(0, 10)
}

function StepIndicator({ current }: { current: 1 | 2 }) {
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2].map((i) => (
        <div key={i} className={cn(
          'h-1.5 rounded-full transition-all',
          i === current ? 'w-6 bg-primary' : i < current ? 'w-3 bg-primary/50' : 'w-3 bg-muted',
        )} />
      ))}
    </div>
  )
}

export function BenchmarkCreator({ onDone, onCancel, editBenchmark }: BenchmarkCreatorProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const [ticker, setTicker] = useState(editBenchmark?.ticker ?? '')
  const [tickerName, setTickerName] = useState(editBenchmark?.name ?? '')
  const [currency, setCurrency] = useState<'USD' | 'TWD'>(editBenchmark?.currency ?? 'USD')
  const [tickerQuery, setTickerQuery] = useState(
    editBenchmark ? `${editBenchmark.ticker} — ${editBenchmark.name}` : '',
  )
  const [selectedResult, setSelectedResult] = useState<TickerSearchResult | null>(
    editBenchmark ? { ticker: editBenchmark.ticker, name: editBenchmark.name, exchange: '', type: '' } : null,
  )
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [startDate, setStartDate] = useState(
    editBenchmark
      ? (editBenchmark.startDate instanceof Date
        ? editBenchmark.startDate.toISOString().slice(0, 10)
        : String(editBenchmark.startDate).slice(0, 10))
      : defaultStartDate(),
  )
  const [endDate, setEndDate] = useState(
    editBenchmark
      ? (editBenchmark.endDate instanceof Date
        ? editBenchmark.endDate.toISOString().slice(0, 10)
        : String(editBenchmark.endDate).slice(0, 10))
      : today,
  )

  const searchRef = useRef<HTMLDivElement>(null)
  const { results, isLoading: searchLoading } = useTickerSearch(tickerQuery.includes('—') ? '' : tickerQuery)
  const apiStatus = useUIStore((s) => s.apiStatus)
  const { isRunning, progress, error, setRunning, setProgress, setError, reset } = useBacktestStore()

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
    if (results.length > 0 && !tickerQuery.includes('—')) setDropdownOpen(true)
    else setDropdownOpen(false)
  }, [results, tickerQuery])

  const step1Valid = !!selectedResult && ticker.length > 0
  const step2Valid = startDate.length === 10 && endDate.length === 10 && startDate <= endDate

  async function handleRun() {
    reset()
    setRunning(true)
    setError(null)
    setProgress(0)

    try {
      const priceData = await fetchPrices(ticker, startDate, endDate)
      setProgress(60)

      if (priceData.length === 0) {
        throw new Error(`No price data found for ${ticker}. Check the ticker symbol.`)
      }

      const benchmark: Benchmark = {
        id: editBenchmark?.id ?? crypto.randomUUID(),
        ticker,
        name: tickerName,
        currency,
        startDate: new Date(startDate + 'T00:00:00Z'),
        endDate: new Date(endDate + 'T00:00:00Z'),
        isFavorite: editBenchmark?.isFavorite ?? false,
        createdAt: editBenchmark?.createdAt ?? new Date(),
      }

      const needsFx = currency !== 'USD'
      const fxRates = needsFx ? await fetchPrices('USDTWD=X', startDate, endDate) : []
      setProgress(75)

      const result = runBenchmark(benchmark, { [ticker]: priceData }, fxRates)
      setProgress(90)

      const saved: Benchmark = { ...benchmark, lastBacktestResult: result }
      await db.benchmarks.put(saved)
      setProgress(100)

      onDone(benchmark.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Benchmark failed. Please try again.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b">
        <button onClick={onCancel} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold leading-tight">
            {editBenchmark ? 'Edit Benchmark' : 'New Benchmark'}
          </h1>
          <StepIndicator current={step} />
        </div>
        <span className="text-xs text-muted-foreground">Step {step} of 2</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">Choose a ticker</h2>
              <p className="text-sm text-muted-foreground">Search for the reference ticker and set its currency.</p>
            </div>

            {/* Ticker search */}
            <div ref={searchRef} className="relative space-y-1.5">
              <Label>Ticker</Label>
              <div className="relative">
                <Input
                  placeholder="Search ticker (e.g. VOO, SPY, 0050.TW)"
                  value={tickerQuery}
                  onChange={(e) => {
                    setTickerQuery(e.target.value)
                    setSelectedResult(null)
                    setTicker('')
                  }}
                />
                {searchLoading && (
                  <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                    <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
                  </div>
                )}
              </div>

              {!searchLoading && tickerQuery.length >= 2 && !tickerQuery.includes('—') && results.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {apiStatus === 'offline-no-cache'
                    ? 'API unavailable — run dev:api to enable ticker search'
                    : 'No results found'}
                </p>
              )}

              {dropdownOpen && results.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-md border bg-popover shadow-md">
                  {results.map((r) => (
                    <button
                      key={r.ticker}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
                      onClick={() => {
                        setSelectedResult(r)
                        setTicker(r.ticker)
                        setTickerName(r.name)
                        setCurrency(r.ticker.endsWith('.TW') ? 'TWD' : 'USD')
                        setTickerQuery(`${r.ticker} — ${r.name}`)
                        setDropdownOpen(false)
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

            {/* Currency toggle */}
            {selectedResult && (
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <div className="flex rounded-md border overflow-hidden w-fit">
                  {(['USD', 'TWD'] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => setCurrency(c)}
                      className={cn(
                        'px-4 py-2 text-sm font-medium transition-colors',
                        currency === c
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">Date range</h2>
              <p className="text-sm text-muted-foreground">
                Backtest <span className="font-mono font-semibold">{ticker}</span> with monthly $1,000 DCA over this period.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bm-start-date">Start date</Label>
                <input
                  id="bm-start-date"
                  type="date"
                  max={today}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bm-end-date">End date</Label>
                <input
                  id="bm-end-date"
                  type="date"
                  max={today}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </div>

            {startDate > endDate && (
              <p className="text-sm text-destructive">Start date must be before end date.</p>
            )}

            {/* Error */}
            {error && !isRunning && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-destructive font-medium">Benchmark failed</p>
                <p className="text-xs text-destructive/80 mt-0.5">{error}</p>
              </div>
            )}

            {/* Progress */}
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
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 p-4 border-t bg-background">
        {step > 1 ? (
          <Button variant="outline" onClick={() => setStep(1)} disabled={isRunning}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        ) : (
          <div />
        )}

        {step === 1 ? (
          <Button onClick={() => setStep(2)} disabled={!step1Valid}>
            Next
            <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        ) : (
          <Button onClick={handleRun} disabled={!step2Valid || isRunning} className="min-w-[140px]">
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running… {progress}%
              </>
            ) : (
              'Run Benchmark'
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
