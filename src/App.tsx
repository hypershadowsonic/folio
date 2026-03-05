import { useEffect } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { BottomNav } from '@/components/BottomNav'
import { SetupWizard } from '@/features/settings/SetupWizard'
import type { TabId } from '@/stores/uiStore'
import Dashboard from '@/features/dashboard'
import DcaPlanner from '@/features/dca-planner'
import Operations from '@/features/operations'
import Performance from '@/features/performance'
import Settings from '@/features/settings'

const TAB_CONTENT: Record<TabId, React.ReactNode> = {
  dashboard:     <Dashboard />,
  'dca-planner': <DcaPlanner />,
  operations:    <Operations />,
  performance:   <Performance />,
  settings:      <Settings />,
}

export default function App() {
  const activeTab     = useUIStore((s) => s.activeTab)
  const setActiveTab  = useUIStore((s) => s.setActiveTab)
  const portfolio     = usePortfolioStore((s) => s.portfolio)
  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio)

  // Load portfolio from Dexie once on mount
  useEffect(() => { void loadPortfolio() }, [loadPortfolio])

  // null  → still loading from IndexedDB; show nothing to avoid flash
  if (portfolio === null) return null

  // undefined → no portfolio exists yet; show the first-run wizard
  if (portfolio === undefined) return <SetupWizard />

  // Portfolio exists → normal app shell
  return (
    <div className="flex h-dvh flex-col bg-background">
      <main className="flex-1 overflow-y-auto pb-16">
        {TAB_CONTENT[activeTab]}
      </main>
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  )
}
