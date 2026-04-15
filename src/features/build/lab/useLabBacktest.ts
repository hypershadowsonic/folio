import { useState, useCallback } from 'react'
import { runBacktest, runBenchmark } from '@/engine/backtest'
import { fetchMultiplePrices, fetchFxRate } from '@/services/yahooFinance'
import type { BacktestResult, Build, Benchmark, BuildForm } from '@/types'
import type { LabSharedControls } from './useLabState'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFromForm(form: BuildForm, shared: LabSharedControls, id: string): Build {
  return {
    id,
    name: form.name || `Lab ${id}`,
    holdings: form.holdings,
    dcaAmount: shared.dcaAmount,
    dcaCurrency: shared.dcaCurrency,
    dcaFrequency: shared.dcaFrequency,
    startDate: new Date(shared.startDate + 'T00:00:00Z'),
    endDate: new Date(shared.endDate + 'T00:00:00Z'),
    rebalanceStrategy: form.rebalanceStrategy,
    rebalanceTriggers: form.rebalanceTriggers,
    thresholdPct: form.rebalanceTriggers.includes('threshold')
      ? parseFloat(form.thresholdPct) || 5
      : undefined,
    periodicFrequency: form.rebalanceTriggers.includes('periodic')
      ? form.periodicFrequency
      : undefined,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

async function runLabBacktest(
  form: BuildForm,
  shared: LabSharedControls,
  id: string,
): Promise<BacktestResult> {
  const build = buildFromForm(form, shared, id)
  const tickers = form.holdings.map((h) => h.ticker)
  if (tickers.length === 0) throw new Error('Add at least one holding before running backtest.')

  const priceData = await fetchMultiplePrices(tickers, shared.startDate, shared.endDate)
  const missingTickers = tickers.filter((t) => priceData[t].length === 0)
  if (missingTickers.length > 0) {
    throw new Error(`No price data found for: ${missingTickers.join(', ')}. Check the ticker symbols.`)
  }

  const needsFx = form.holdings.some((h) => h.currency !== shared.dcaCurrency)
  const fxRates = needsFx ? await fetchFxRate(shared.startDate, shared.endDate) : []

  return runBacktest(build, priceData, fxRates)
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseLabBacktestParams {
  sharedControls: LabSharedControls
  configA: BuildForm
  configB: BuildForm
  benchmarkTicker: string | null
  onResultA: (result: BacktestResult) => void
  onResultB: (result: BacktestResult) => void
  onBenchmarkResult: (result: BacktestResult | null) => void
}

export function useLabBacktest({
  sharedControls,
  configA,
  configB,
  benchmarkTicker,
  onResultA,
  onResultB,
  onBenchmarkResult,
}: UseLabBacktestParams) {
  const [isRunningA, setIsRunningA] = useState(false)
  const [isRunningB, setIsRunningB] = useState(false)
  const [errorA, setErrorA] = useState<string | null>(null)
  const [errorB, setErrorB] = useState<string | null>(null)

  const runA = useCallback(async () => {
    setIsRunningA(true)
    setErrorA(null)
    try {
      const result = await runLabBacktest(configA, sharedControls, 'lab-a')
      onResultA(result)
    } catch (err) {
      setErrorA(err instanceof Error ? err.message : 'Backtest failed.')
    } finally {
      setIsRunningA(false)
    }
  }, [configA, sharedControls, onResultA])

  const runB = useCallback(async () => {
    setIsRunningB(true)
    setErrorB(null)
    try {
      const result = await runLabBacktest(configB, sharedControls, 'lab-b')
      onResultB(result)
    } catch (err) {
      setErrorB(err instanceof Error ? err.message : 'Backtest failed.')
    } finally {
      setIsRunningB(false)
    }
  }, [configB, sharedControls, onResultB])

  const runAll = useCallback(async () => {
    // Run A and B in parallel; also run benchmark if ticker set
    const tasks: Promise<void>[] = []

    if (configA.holdings.length > 0) {
      tasks.push(
        (async () => {
          setIsRunningA(true)
          setErrorA(null)
          try {
            const result = await runLabBacktest(configA, sharedControls, 'lab-a')
            onResultA(result)
          } catch (err) {
            setErrorA(err instanceof Error ? err.message : 'Backtest failed.')
          } finally {
            setIsRunningA(false)
          }
        })(),
      )
    }

    if (configB.holdings.length > 0) {
      tasks.push(
        (async () => {
          setIsRunningB(true)
          setErrorB(null)
          try {
            const result = await runLabBacktest(configB, sharedControls, 'lab-b')
            onResultB(result)
          } catch (err) {
            setErrorB(err instanceof Error ? err.message : 'Backtest failed.')
          } finally {
            setIsRunningB(false)
          }
        })(),
      )
    }

    await Promise.all(tasks)
  }, [configA, configB, sharedControls, onResultA, onResultB])

  const runBenchmarkForTicker = useCallback(
    async (ticker: string) => {
      try {
        // Create a minimal Benchmark object
        const benchmark: Benchmark = {
          id: 'lab-benchmark',
          ticker,
          name: ticker,
          currency: ticker.endsWith('.TW') ? 'TWD' : 'USD',
          startDate: new Date(sharedControls.startDate + 'T00:00:00Z'),
          endDate: new Date(sharedControls.endDate + 'T00:00:00Z'),
          isFavorite: false,
          createdAt: new Date(),
        }
        const priceData = await fetchMultiplePrices([ticker], sharedControls.startDate, sharedControls.endDate)
        const fxRates = benchmark.currency !== sharedControls.dcaCurrency
          ? await fetchFxRate(sharedControls.startDate, sharedControls.endDate)
          : []
        const result = runBenchmark(benchmark, priceData, fxRates, {
          dcaAmount: sharedControls.dcaAmount,
          dcaCurrency: sharedControls.dcaCurrency,
          dcaFrequency: sharedControls.dcaFrequency,
          startDate: new Date(sharedControls.startDate + 'T00:00:00Z'),
          endDate: new Date(sharedControls.endDate + 'T00:00:00Z'),
        })
        onBenchmarkResult(result)
      } catch {
        onBenchmarkResult(null)
      }
    },
    [sharedControls, onBenchmarkResult],
  )

  // Auto-run benchmark when ticker changes
  const runBenchmarkIfSet = useCallback(async () => {
    if (!benchmarkTicker) { onBenchmarkResult(null); return }
    await runBenchmarkForTicker(benchmarkTicker)
  }, [benchmarkTicker, runBenchmarkForTicker, onBenchmarkResult])

  return {
    runA,
    runB,
    runAll,
    runBenchmarkForTicker,
    runBenchmarkIfSet,
    isRunningA,
    isRunningB,
    errorA,
    errorB,
  }
}
