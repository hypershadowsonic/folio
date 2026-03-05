import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type TabId =
  | 'dashboard'
  | 'dca-planner'
  | 'operations'
  | 'performance'
  | 'settings'

export type DisplayCurrency = 'TWD' | 'USD'
export type Theme = 'light' | 'dark'

interface UIState {
  // ── Navigation ────────────────────────────────────────────────────────────
  activeTab: TabId

  // ── Dashboard ─────────────────────────────────────────────────────────────
  /** Controls the TWD / USD value toggle on the dashboard chart and stats bar. */
  dashboardCurrency: DisplayCurrency

  // ── Appearance ────────────────────────────────────────────────────────────
  theme: Theme

  // ── Actions ───────────────────────────────────────────────────────────────
  setActiveTab: (tab: TabId) => void
  setDashboardCurrency: (currency: DisplayCurrency) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      activeTab: 'dashboard',
      dashboardCurrency: 'TWD',   // PRD §14.1: default to base currency
      theme: 'light',

      setActiveTab: (tab) => set({ activeTab: tab }),

      setDashboardCurrency: (currency) => set({ dashboardCurrency: currency }),

      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },

      toggleTheme: () => {
        const next: Theme = get().theme === 'light' ? 'dark' : 'light'
        applyTheme(next)
        set({ theme: next })
      },
    }),
    {
      name: 'folio-ui',
      // Only persist preferences; activeTab resets to dashboard on reload
      partialize: (state) => ({
        dashboardCurrency: state.dashboardCurrency,
        theme: state.theme,
      }),
      onRehydrateStorage: () => (state) => {
        // Apply the persisted theme to <html> as soon as the store rehydrates
        if (state) applyTheme(state.theme)
      },
    },
  ),
)

// ─── Theme helper ─────────────────────────────────────────────────────────────

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
}
