import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TabId, DisplayCurrency, Theme, ApiStatus } from '@/types'

type PendingNav = { id: string; kind: 'build' | 'benchmark' | 'compare' }

interface UIState {
  // ── Navigation ──────────────────────────────────────────────────────────────
  activeTab: TabId
  pendingNav: PendingNav | null

  // ── Display ─────────────────────────────────────────────────────────────────
  displayCurrency: DisplayCurrency
  theme: Theme

  // ── Network ─────────────────────────────────────────────────────────────────
  apiStatus: ApiStatus

  // ── Actions ─────────────────────────────────────────────────────────────────
  setActiveTab: (tab: TabId) => void
  setPendingNav: (nav: PendingNav) => void
  clearPendingNav: () => void
  setDisplayCurrency: (currency: DisplayCurrency) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setApiStatus: (status: ApiStatus) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      activeTab: 'dashboard',
      pendingNav: null,
      displayCurrency: 'USD',
      theme: 'light',
      apiStatus: 'online',

      setActiveTab: (tab) => set({ activeTab: tab }),
      setPendingNav: (nav) => set({ pendingNav: nav }),
      clearPendingNav: () => set({ pendingNav: null }),
      setDisplayCurrency: (currency) => set({ displayCurrency: currency }),

      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },

      toggleTheme: () => {
        const next: Theme = get().theme === 'light' ? 'dark' : 'light'
        applyTheme(next)
        set({ theme: next })
      },

      setApiStatus: (status) => set({ apiStatus: status }),
    }),
    {
      name: 'folio-build-ui',
      // Only persist preferences; activeTab + apiStatus reset on reload
      partialize: (state) => ({
        displayCurrency: state.displayCurrency,
        theme: state.theme,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme)
      },
    },
  ),
)

// ─── Theme helper ─────────────────────────────────────────────────────────────

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}
