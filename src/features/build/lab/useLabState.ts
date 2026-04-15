import { useState, useEffect, useRef, useCallback } from 'react'
import { db } from '@/db/database'
import type { BacktestResult, Build, BuildForm, LabDraft, LabMakerState } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LabSharedControls {
  startDate: string    // YYYY-MM-DD
  endDate: string      // YYYY-MM-DD
  dcaCurrency: 'USD' | 'TWD'
  dcaFrequency: 'weekly' | 'biweekly' | 'monthly'
  dcaAmount: number
}

export interface LabStateShape {
  buildA: LabMakerState
  buildB: LabMakerState
  sharedControls: LabSharedControls
  benchmarkTicker: string | null
  benchmarkResult: BacktestResult | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function defaultStartDateStr(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 5)
  return d.toISOString().slice(0, 10)
}

function buildToConfig(build: Build): BuildForm {
  const toDateStr = (d: Date | unknown): string => {
    if (d instanceof Date) return d.toISOString().slice(0, 10)
    return String(d).slice(0, 10)
  }
  return {
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
}

function emptyConfig(): BuildForm {
  return {
    name: '',
    holdings: [],
    dcaAmount: '1000',
    dcaCurrency: 'USD',
    dcaFrequency: 'monthly',
    startDate: defaultStartDateStr(),
    endDate: getTodayStr(),
    rebalanceStrategy: 'soft',
    rebalanceTriggers: ['on-dca'],
    thresholdPct: '5',
    periodicFrequency: 'monthly',
  }
}

function emptyMaker(): LabMakerState {
  return { config: emptyConfig(), isStale: false }
}

function defaultSharedControls(build?: Build): LabSharedControls {
  const toDateStr = (d: Date | unknown): string => {
    if (d instanceof Date) return d.toISOString().slice(0, 10)
    return String(d).slice(0, 10)
  }
  return {
    startDate: build ? toDateStr(build.startDate) : defaultStartDateStr(),
    endDate: getTodayStr(),
    dcaCurrency: build?.dcaCurrency ?? 'USD',
    dcaFrequency: build?.dcaFrequency ?? 'monthly',
    dcaAmount: build?.dcaAmount ?? 1000,
  }
}

function draftToState(draft: LabDraft): LabStateShape {
  return {
    buildA: draft.buildA,
    buildB: draft.buildB,
    sharedControls: draft.sharedControls,
    benchmarkTicker: draft.benchmarkTicker ?? null,
    benchmarkResult: draft.benchmarkResult ?? null,
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLabState() {
  const [state, setStateRaw] = useState<LabStateShape>(() => ({
    buildA: emptyMaker(),
    buildB: emptyMaker(),
    sharedControls: defaultSharedControls(),
    benchmarkTicker: null,
    benchmarkResult: null,
  }))

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced auto-save to IndexedDB
  const scheduleSave = useCallback((next: LabStateShape) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const draft: LabDraft = {
        id: 'singleton',
        buildA: next.buildA,
        buildB: next.buildB,
        sharedControls: next.sharedControls,
        benchmarkTicker: next.benchmarkTicker ?? undefined,
        benchmarkResult: next.benchmarkResult ?? undefined,
        updatedAt: new Date().toISOString(),
      }
      void db.labDraft.put(draft)
    }, 500)
  }, [])

  // Wrapper that schedules a save after every state update
  const setState = useCallback(
    (updater: (prev: LabStateShape) => LabStateShape) => {
      setStateRaw((prev) => {
        const next = updater(prev)
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  // Initialize from draft or Favorite Build on mount
  useEffect(() => {
    async function init() {
      const draft = await db.labDraft.get('singleton')
      if (draft) {
        setStateRaw(draftToState(draft))
        return
      }
      // No draft — try to load Favorite / most recent Build
      const allBuilds = await db.builds.toArray()
      if (allBuilds.length === 0) return  // keep empty state
      const favorite =
        allBuilds.find((b) => b.isFavorite) ??
        allBuilds.sort((a, b) => {
          const aTime = a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0
          const bTime = b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0
          return bTime - aTime
        })[0]
      const config = buildToConfig(favorite)
      setStateRaw({
        buildA: {
          loadedBuildId: favorite.id,
          config,
          backtest: favorite.lastBacktestResult,
          isStale: !favorite.lastBacktestResult,
        },
        buildB: emptyMaker(),
        sharedControls: defaultSharedControls(favorite),
        benchmarkTicker: null,
        benchmarkResult: null,
      })
    }
    void init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  // ─── Setters ─────────────────────────────────────────────────────────────────

  const setSharedControls = useCallback(
    (controls: Partial<LabSharedControls>) => {
      setState((prev) => ({
        ...prev,
        sharedControls: { ...prev.sharedControls, ...controls },
        // Changing shared controls makes both builds stale
        buildA: prev.buildA.backtest ? { ...prev.buildA, isStale: true } : prev.buildA,
        buildB: prev.buildB.backtest ? { ...prev.buildB, isStale: true } : prev.buildB,
        // Benchmark result is also stale when shared controls change
        benchmarkResult: null,
      }))
    },
    [setState],
  )

  const setMakerConfig = useCallback(
    (side: 'A' | 'B', config: Partial<BuildForm>) => {
      setState((prev) => {
        const key = side === 'A' ? 'buildA' : 'buildB'
        return {
          ...prev,
          [key]: {
            ...prev[key],
            config: { ...prev[key].config, ...config },
            isStale: true,
          },
        }
      })
    },
    [setState],
  )

  const setMakerState = useCallback(
    (side: 'A' | 'B', update: Partial<LabMakerState>) => {
      setState((prev) => {
        const key = side === 'A' ? 'buildA' : 'buildB'
        return { ...prev, [key]: { ...prev[key], ...update } }
      })
    },
    [setState],
  )

  const syncMaker = useCallback(
    (from: 'A' | 'B') => {
      setState((prev) => {
        const src = from === 'A' ? prev.buildA : prev.buildB
        const dstKey = from === 'A' ? 'buildB' : 'buildA'
        return {
          ...prev,
          [dstKey]: {
            ...prev[dstKey],
            config: {
              ...prev[dstKey].config,
              // Copy holdings + rebalance settings; keep dst's own name
              holdings: [...src.config.holdings],
              rebalanceStrategy: src.config.rebalanceStrategy,
              rebalanceTriggers: [...src.config.rebalanceTriggers],
              thresholdPct: src.config.thresholdPct,
              periodicFrequency: src.config.periodicFrequency,
            },
            isStale: true,
          },
        }
      })
    },
    [setState],
  )

  const setBacktestResult = useCallback(
    (side: 'A' | 'B', result: BacktestResult) => {
      setState((prev) => {
        const key = side === 'A' ? 'buildA' : 'buildB'
        return {
          ...prev,
          [key]: { ...prev[key], backtest: result, isStale: false },
        }
      })
    },
    [setState],
  )

  const setBenchmark = useCallback(
    (ticker: string | null) => {
      setState((prev) => ({
        ...prev,
        benchmarkTicker: ticker,
        benchmarkResult: null,  // clear result when ticker changes
      }))
    },
    [setState],
  )

  const setBenchmarkResult = useCallback(
    (result: BacktestResult | null) => {
      setState((prev) => ({ ...prev, benchmarkResult: result }))
    },
    [setState],
  )

  const resetLab = useCallback(async () => {
    await db.labDraft.delete('singleton')
    // Reload from Favorite Build
    const allBuilds = await db.builds.toArray()
    if (allBuilds.length === 0) {
      setStateRaw({
        buildA: emptyMaker(),
        buildB: emptyMaker(),
        sharedControls: defaultSharedControls(),
        benchmarkTicker: null,
        benchmarkResult: null,
      })
      return
    }
    const favorite =
      allBuilds.find((b) => b.isFavorite) ??
      allBuilds.sort((a, b) => {
        const aTime = a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0
        const bTime = b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0
        return bTime - aTime
      })[0]
    const config = buildToConfig(favorite)
    setStateRaw({
      buildA: {
        loadedBuildId: favorite.id,
        config,
        backtest: favorite.lastBacktestResult,
        isStale: !favorite.lastBacktestResult,
      },
      buildB: emptyMaker(),
      sharedControls: defaultSharedControls(favorite),
      benchmarkTicker: null,
      benchmarkResult: null,
    })
  }, [])

  return {
    state,
    setSharedControls,
    setMakerConfig,
    setMakerState,
    syncMaker,
    setBacktestResult,
    setBenchmark,
    setBenchmarkResult,
    resetLab,
  }
}
