import { create } from 'zustand'

interface BacktestState {
  isRunning: boolean
  progress: number           // 0-100
  currentTicker: string | null  // ticker being fetched/processed
  error: string | null

  setRunning: (v: boolean) => void
  setProgress: (v: number) => void
  setCurrentTicker: (t: string | null) => void
  setError: (e: string | null) => void
  reset: () => void
}

export const useBacktestStore = create<BacktestState>()((set) => ({
  isRunning: false,
  progress: 0,
  currentTicker: null,
  error: null,

  setRunning: (v) => set({ isRunning: v }),
  setProgress: (v) => set({ progress: v }),
  setCurrentTicker: (t) => set({ currentTicker: t }),
  setError: (e) => set({ error: e }),
  reset: () => set({ isRunning: false, progress: 0, currentTicker: null, error: null }),
}))
