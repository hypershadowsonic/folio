/**
 * Folio Build — Compare Engine
 *
 * Aligns DCA params across multiple Builds and Benchmarks, runs each,
 * and returns a CompareResult.
 */

import type { Build, Benchmark, Compare, CompareResult, PricePoint } from '@/types'
import { runBacktest, runBenchmark } from './backtest'

/**
 * Run a comparison across all items in a Compare.
 *
 * Alignment rules (per PRD §3.3):
 * 1. Find the first Build in compare.items order; if none, use the first Benchmark.
 * 2. Use that item's dcaAmount, dcaCurrency, dcaFrequency, startDate, endDate as alignedParams.
 *    (If the anchor is a Benchmark, default to monthly / $1,000 / USD.)
 * 3. Each Build runs with its own holdings + rebalance settings but the aligned DCA params.
 * 4. Each Benchmark runs with the aligned DCA params.
 */
export function runCompare(
  compare: Compare,
  builds: Build[],
  benchmarks: Benchmark[],
  allPriceData: Record<string, PricePoint[]>,
  fxRates: PricePoint[],
): CompareResult {
  const buildMap = new Map(builds.map((b) => [b.id, b]))
  const benchmarkMap = new Map(benchmarks.map((b) => [b.id, b]))

  // ── Determine aligned params from first item ──────────────────────────────

  let alignedDcaAmount = 1000
  let alignedDcaCurrency: 'USD' | 'TWD' = 'USD'
  let alignedDcaFrequency: 'weekly' | 'biweekly' | 'monthly' = 'monthly'
  let alignedStartDate: Date | null = null
  let alignedEndDate: Date | null = null

  for (const item of compare.items) {
    if (item.type === 'build') {
      const b = buildMap.get(item.refId)
      if (b) {
        alignedDcaAmount = b.dcaAmount
        alignedDcaCurrency = b.dcaCurrency
        alignedDcaFrequency = b.dcaFrequency
        alignedStartDate = b.startDate
        alignedEndDate = b.endDate
        break
      }
    }
    if (item.type === 'benchmark') {
      const bm = benchmarkMap.get(item.refId)
      if (bm) {
        alignedStartDate = bm.startDate
        alignedEndDate = bm.endDate
        break
      }
    }
  }

  if (!alignedStartDate || !alignedEndDate) {
    throw new Error('Cannot determine aligned date range: no valid items found in Compare.')
  }

  const alignedParams = {
    dcaAmount: alignedDcaAmount,
    dcaCurrency: alignedDcaCurrency,
    dcaFrequency: alignedDcaFrequency,
    startDate: alignedStartDate,
    endDate: alignedEndDate,
  }

  // ── Run each item ─────────────────────────────────────────────────────────

  const resultItems: CompareResult['items'] = []

  for (const item of compare.items) {
    if (item.type === 'build') {
      const b = buildMap.get(item.refId)
      if (!b) continue

      // Synthesize a build with aligned DCA params but original holdings + rebalance
      const alignedBuild: Build = {
        ...b,
        dcaAmount: alignedDcaAmount,
        dcaCurrency: alignedDcaCurrency,
        dcaFrequency: alignedDcaFrequency,
        startDate: alignedStartDate,
        endDate: alignedEndDate,
      }
      const result = runBacktest(alignedBuild, allPriceData, fxRates)
      resultItems.push({ refId: item.refId, name: b.name, type: 'build', result })

    } else {
      const bm = benchmarkMap.get(item.refId)
      if (!bm) continue

      const result = runBenchmark(bm, allPriceData, fxRates, {
        dcaAmount: alignedDcaAmount,
        dcaCurrency: alignedDcaCurrency,
        dcaFrequency: alignedDcaFrequency,
        startDate: alignedStartDate,
        endDate: alignedEndDate,
      })
      resultItems.push({ refId: item.refId, name: bm.ticker, type: 'benchmark', result })
    }
  }

  return {
    compareId: compare.id,
    runAt: new Date(),
    alignedParams,
    items: resultItems,
  }
}
