import { ErrorBoundary } from '@/components/ErrorBoundary'
import { BottomNav } from '@/components/BottomNav'
import { Dashboard } from '@/features/dashboard'
import { Builds } from '@/features/builds'
import { BuildSettings } from '@/features/settings'
import { useUIStore } from '@/stores/uiStore'
import type { TabId } from '@/types'

const TAB_CONTENT: Record<TabId, React.ReactNode> = {
  dashboard: (
    <ErrorBoundary tabName="Dashboard">
      <Dashboard />
    </ErrorBoundary>
  ),
  builds: (
    <ErrorBoundary tabName="Builds">
      <Builds />
    </ErrorBoundary>
  ),
  settings: (
    <ErrorBoundary tabName="Settings">
      <BuildSettings />
    </ErrorBoundary>
  ),
}

export default function App() {
  const activeTab = useUIStore((s) => s.activeTab)
  const setActiveTab = useUIStore((s) => s.setActiveTab)

  return (
    <div className="flex h-dvh flex-col">
      <main className="flex-1 overflow-y-auto pb-16">
        {TAB_CONTENT[activeTab]}
      </main>
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  )
}
