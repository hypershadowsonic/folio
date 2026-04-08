import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Mode = 'portfolio' | 'build'

interface ModeState {
  mode: Mode
  setMode: (m: Mode) => void
}

export function applyMode(mode: Mode) {
  document.documentElement.dataset.mode = mode
}

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: 'portfolio',
      setMode: (m) => {
        applyMode(m)
        set({ mode: m })
      },
    }),
    {
      name: 'folio-mode',
      onRehydrateStorage: () => (state) => {
        if (state) applyMode(state.mode)
      },
    },
  ),
)
