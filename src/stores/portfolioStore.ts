import { create } from 'zustand'
import { db } from '@/db/database'
import type { Portfolio, RebalanceStrategy, AllocationMethod } from '@/types'

interface PortfolioState {
  // null = not yet loaded; undefined = no portfolio exists
  portfolio: Portfolio | null | undefined

  // ── Actions ──────────────────────────────────────────────────────────────

  /** Load (or reload) the portfolio from Dexie into the store. */
  loadPortfolio: () => Promise<void>

  /** Persist a partial update to Dexie and sync the store. */
  updatePortfolio: (patch: Partial<Omit<Portfolio, 'id' | 'createdAt'>>) => Promise<void>

  /** Shorthand: update the monthly DCA budget and its currency. */
  setDCABudget: (amount: number, currency: Portfolio['monthlyDCABudgetCurrency']) => Promise<void>

  /** Shorthand: update the default rebalance strategy. */
  setRebalanceStrategy: (strategy: RebalanceStrategy) => Promise<void>

  /** Shorthand: update the default allocation method. */
  setAllocationMethod: (method: AllocationMethod) => Promise<void>
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  portfolio: null,

  loadPortfolio: async () => {
    const portfolio = await db.portfolios.toCollection().first()
    // coerce undefined (no rows) to explicit undefined so callers can distinguish
    // "not loaded yet" (null) from "portfolio doesn't exist" (undefined)
    set({ portfolio: portfolio ?? undefined })
  },

  updatePortfolio: async (patch) => {
    const { portfolio } = get()
    if (!portfolio) return

    const updated: Portfolio = {
      ...portfolio,
      ...patch,
      updatedAt: new Date(),
    }

    await db.portfolios.put(updated)
    set({ portfolio: updated })
  },

  setDCABudget: async (amount, currency) => {
    await get().updatePortfolio({
      monthlyDCABudget: amount,
      monthlyDCABudgetCurrency: currency,
    })
  },

  setRebalanceStrategy: async (strategy) => {
    await get().updatePortfolio({ defaultRebalanceStrategy: strategy })
  },

  setAllocationMethod: async (method) => {
    await get().updatePortfolio({ defaultAllocationMethod: method })
  },
}))
