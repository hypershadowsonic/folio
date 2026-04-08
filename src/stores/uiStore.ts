import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ApiStatus } from '@/types'

export type PortfolioTabId =
  | 'dashboard'
  | 'dca-planner'
  | 'operations'
  | 'performance'
  | 'settings'

export type BuildTabId =
  | 'build-dashboard'
  | 'builds'
  | 'compare'
  | 'build-settings'

/** Union of all tab IDs across both modes */
export type TabId = PortfolioTabId | BuildTabId

export type DisplayCurrency = 'TWD' | 'USD'
export type Theme = 'light' | 'dark'

interface UIState {
  // ── Portfolio Navigation ──────────────────────────────────────────────────
  activeTab: PortfolioTabId

  // ── Build Navigation ──────────────────────────────────────────────────────
  buildTab: BuildTabId

  // ── Dashboard ─────────────────────────────────────────────────────────────
  /** Controls the TWD / USD value toggle on the dashboard chart and stats bar. */
  dashboardCurrency: DisplayCurrency

  // ── Build mode ────────────────────────────────────────────────────────────
  /** Controls the USD / TWD display toggle in Build mode charts. */
  buildDisplayCurrency: DisplayCurrency

  // ── Appearance ────────────────────────────────────────────────────────────
  theme: Theme

  // ── API status ────────────────────────────────────────────────────────────
  /** Not persisted — resets to 'online' on each page load. */
  apiStatus: ApiStatus

  // ── Actions ───────────────────────────────────────────────────────────────
  setActiveTab: (tab: PortfolioTabId) => void
  setBuildTab: (tab: BuildTabId) => void
  setDashboardCurrency: (currency: DisplayCurrency) => void
  setBuildDisplayCurrency: (currency: DisplayCurrency) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setApiStatus: (status: ApiStatus) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      activeTab: 'dashboard',
      buildTab: 'build-dashboard',
      dashboardCurrency: 'TWD',
      buildDisplayCurrency: 'USD',
      theme: 'light',
      apiStatus: 'online',

      setActiveTab: (tab) => set({ activeTab: tab }),
      setBuildTab: (tab) => set({ buildTab: tab }),

      setDashboardCurrency: (currency) => set({ dashboardCurrency: currency }),
      setBuildDisplayCurrency: (currency) => set({ buildDisplayCurrency: currency }),

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
      name: 'folio-ui',
      // Only persist preferences; activeTab/buildTab reset to defaults on reload
      partialize: (state) => ({
        dashboardCurrency: state.dashboardCurrency,
        buildDisplayCurrency: state.buildDisplayCurrency,
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
