import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/uiStore'
import { useLabState } from './useLabState'
import { useLabBacktest } from './useLabBacktest'
import { SharedControls } from './SharedControls'
import { LabChart } from './LabChart'
import { MetricsCard } from './MetricsCard'
import { BuildMaker } from './BuildMaker'
import type { Build, BuildForm } from '@/types'

// ─── Sync button with confirm-on-second-press UX ──────────────────────────────

interface SyncButtonProps {
  label: string
  onConfirm: () => void
  disabled?: boolean
}

function SyncButton({ label, onConfirm, disabled }: SyncButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleClick = useCallback(() => {
    if (confirming) {
      if (timerRef.current) clearTimeout(timerRef.current)
      setConfirming(false)
      onConfirm()
    } else {
      setConfirming(true)
      timerRef.current = setTimeout(() => setConfirming(false), 3000)
    }
  }, [confirming, onConfirm])

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  return (
    <Button
      size="sm"
      variant={confirming ? 'destructive' : 'outline'}
      onClick={handleClick}
      disabled={disabled}
      className="h-8 text-xs gap-1.5 min-w-[100px] transition-all"
    >
      <ArrowLeftRight className="h-3.5 w-3.5" />
      {confirming ? `Confirm ${label}` : label}
    </Button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LabTab() {
  const displayCurrency = useUIStore((s) => s.buildDisplayCurrency)
  const [mobileTab, setMobileTab] = useState<'A' | 'B'>('A')

  const {
    state,
    setSharedControls,
    setMakerConfig,
    setMakerState,
    syncMaker,
    setBacktestResult,
    setBenchmark,
    setBenchmarkResult,
    resetLab,
  } = useLabState()

  const { runA, runB, runAll, runBenchmarkForTicker, isRunningA, isRunningB, errorA, errorB } =
    useLabBacktest({
      sharedControls: state.sharedControls,
      configA: state.buildA.config,
      configB: state.buildB.config,
      benchmarkTicker: state.benchmarkTicker,
      onResultA: (r) => setBacktestResult('A', r),
      onResultB: (r) => setBacktestResult('B', r),
      onBenchmarkResult: setBenchmarkResult,
    })

  function handleLoad(side: 'A' | 'B', build: Build) {
    // Convert Build → BuildForm-like config
    const toDateStr = (d: Date | unknown): string => {
      if (d instanceof Date) return d.toISOString().slice(0, 10)
      return String(d).slice(0, 10)
    }
    const config: BuildForm = {
      name: build.name,
      holdings: build.holdings,
      dcaAmount: String(build.dcaAmount),
      dcaCurrency: build.dcaCurrency,
      dcaFrequency: build.dcaFrequency,
      startDate: toDateStr(build.startDate),
      endDate: toDateStr(build.endDate),
      rebalanceStrategy: build.rebalanceStrategy,
      rebalanceTriggers: build.rebalanceTriggers,
      thresholdPct: String(build.thresholdPct ?? 5),
      periodicFrequency: build.periodicFrequency ?? 'monthly',
    }
    setMakerState(side, {
      loadedBuildId: build.id,
      config,
      backtest: build.lastBacktestResult,
      isStale: !build.lastBacktestResult,
    })
  }

  const isRunningAny = isRunningA || isRunningB

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Shared controls (sticky top) */}
      <SharedControls
        controls={state.sharedControls}
        onChange={setSharedControls}
        isAStale={state.buildA.isStale}
        isBStale={state.buildB.isStale}
        onUpdateAll={() => void runAll()}
        isRunningAny={isRunningAny}
        onReset={resetLab}
        benchmarkTicker={state.benchmarkTicker}
        onBenchmarkChange={setBenchmark}
        onRunBenchmark={(t) => void runBenchmarkForTicker(t)}
      />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Desktop layout (md+): full-width chart above, side-by-side makers */}
        <div className="hidden md:block p-4 space-y-4">
          {/* Chart */}
          <LabChart
            resultA={state.buildA.backtest}
            resultB={state.buildB.backtest}
            benchmarkResult={state.benchmarkResult}
            isAStale={state.buildA.isStale}
            isBStale={state.buildB.isStale}
            displayCurrency={displayCurrency}
          />

          {/* Metrics row */}
          <div className="grid grid-cols-2 gap-4">
            <MetricsCard
              side="A"
              result={state.buildA.backtest}
              isStale={state.buildA.isStale}
              isRunning={isRunningA}
              displayCurrency={displayCurrency}
            />
            <MetricsCard
              side="B"
              result={state.buildB.backtest}
              isStale={state.buildB.isStale}
              isRunning={isRunningB}
              displayCurrency={displayCurrency}
            />
          </div>

          {/* Makers + Sync */}
          <div className="grid grid-cols-2 gap-4">
            <BuildMaker
              side="A"
              config={state.buildA.config}
              loadedBuildId={state.buildA.loadedBuildId}
              isStale={state.buildA.isStale}
              isRunning={isRunningA}
              error={errorA}
              onConfigChange={(update) => setMakerConfig('A', update)}
              onLoad={(b) => handleLoad('A', b)}
              onRunBacktest={() => void runA()}
            />
            <BuildMaker
              side="B"
              config={state.buildB.config}
              loadedBuildId={state.buildB.loadedBuildId}
              isStale={state.buildB.isStale}
              isRunning={isRunningB}
              error={errorB}
              onConfigChange={(update) => setMakerConfig('B', update)}
              onLoad={(b) => handleLoad('B', b)}
              onRunBacktest={() => void runB()}
            />
          </div>

          {/* Sync buttons centered between makers */}
          <div className="flex items-center justify-center gap-3">
            <SyncButton
              label="Sync A → B"
              onConfirm={() => syncMaker('A')}
              disabled={state.buildA.config.holdings.length === 0}
            />
            <SyncButton
              label="Sync B → A"
              onConfirm={() => syncMaker('B')}
              disabled={state.buildB.config.holdings.length === 0}
            />
          </div>
        </div>

        {/* Mobile layout (< md): chart + tab switcher + active maker */}
        <div className="md:hidden flex flex-col">
          {/* Chart */}
          <div className="p-3">
            <LabChart
              resultA={state.buildA.backtest}
              resultB={state.buildB.backtest}
              benchmarkResult={state.benchmarkResult}
              isAStale={state.buildA.isStale}
              isBStale={state.buildB.isStale}
              displayCurrency={displayCurrency}
            />
          </div>

          {/* A / B tab switcher */}
          <div className="flex border-b">
            {(['A', 'B'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setMobileTab(tab)}
                className={cn(
                  'flex-1 py-2.5 text-sm font-medium transition-colors',
                  mobileTab === tab
                    ? 'border-b-2 border-mode-accent text-mode-accent'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Build {tab}
                {tab === 'A' && state.buildA.isStale && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                )}
                {tab === 'B' && state.buildB.isStale && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                )}
              </button>
            ))}
          </div>

          {/* Active tab content */}
          <div className="p-3 space-y-3">
            {mobileTab === 'A' ? (
              <>
                <MetricsCard
                  side="A"
                  result={state.buildA.backtest}
                  isStale={state.buildA.isStale}
                  isRunning={isRunningA}
                  displayCurrency={displayCurrency}
                />
                <BuildMaker
                  side="A"
                  config={state.buildA.config}
                  loadedBuildId={state.buildA.loadedBuildId}
                  isStale={state.buildA.isStale}
                  isRunning={isRunningA}
                  error={errorA}
                  onConfigChange={(update) => setMakerConfig('A', update)}
                  onLoad={(b) => handleLoad('A', b)}
                  onRunBacktest={() => void runA()}
                />
                {/* Mobile sync: B→A confirmation via button (no swipe needed) */}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full text-xs gap-1.5"
                  onClick={() => {
                    if (state.buildB.config.holdings.length > 0) syncMaker('B')
                  }}
                  disabled={state.buildB.config.holdings.length === 0}
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                  Copy Build B config here
                </Button>
              </>
            ) : (
              <>
                <MetricsCard
                  side="B"
                  result={state.buildB.backtest}
                  isStale={state.buildB.isStale}
                  isRunning={isRunningB}
                  displayCurrency={displayCurrency}
                />
                <BuildMaker
                  side="B"
                  config={state.buildB.config}
                  loadedBuildId={state.buildB.loadedBuildId}
                  isStale={state.buildB.isStale}
                  isRunning={isRunningB}
                  error={errorB}
                  onConfigChange={(update) => setMakerConfig('B', update)}
                  onLoad={(b) => handleLoad('B', b)}
                  onRunBacktest={() => void runB()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full text-xs gap-1.5"
                  onClick={() => {
                    if (state.buildA.config.holdings.length > 0) syncMaker('A')
                  }}
                  disabled={state.buildA.config.holdings.length === 0}
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                  Copy Build A config here
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
