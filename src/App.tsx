import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useModeStore } from '@/stores/modeStore'
import { BottomNav } from '@/components/BottomNav'
import { ModeToggle } from '@/components/ModeToggle'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SetupWizard } from '@/features/settings/SetupWizard'
import { OperationLogger } from '@/features/operations/OperationLogger'
import { checkAndCaptureWeeklySnapshot } from '@/services/autoSnapshot'
import { useDriftSummary } from '@/features/dashboard/DriftMonitor'
import type { PortfolioTabId } from '@/stores/uiStore'
import Dashboard from '@/features/dashboard'
import DcaPlanner from '@/features/dca-planner'
import Operations from '@/features/operations'
import Performance from '@/features/performance'
import Settings from '@/features/settings'
import BuildShell from '@/features/build'

const PORTFOLIO_TAB_CONTENT: Record<PortfolioTabId, React.ReactNode> = {
  dashboard:     <ErrorBoundary tabName="Dashboard"><Dashboard /></ErrorBoundary>,
  'dca-planner': <ErrorBoundary tabName="DCA Planner"><DcaPlanner /></ErrorBoundary>,
  operations:    <ErrorBoundary tabName="Operations"><Operations /></ErrorBoundary>,
  performance:   <ErrorBoundary tabName="Performance"><Performance /></ErrorBoundary>,
  settings:      <ErrorBoundary tabName="Settings"><Settings /></ErrorBoundary>,
}

export default function App() {
  const activeTab    = useUIStore((s) => s.activeTab)
  const setActiveTab = useUIStore((s) => s.setActiveTab)
  const buildTab     = useUIStore((s) => s.buildTab)
  const setBuildTab  = useUIStore((s) => s.setBuildTab)
  const portfolio    = usePortfolioStore((s) => s.portfolio)
  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio)
  const mode         = useModeStore((s) => s.mode)

  const [loggerOpen, setLoggerOpen] = useState(false)

  // Load portfolio from Dexie once on mount
  useEffect(() => { void loadPortfolio() }, [loadPortfolio])

  // Weekly auto-snapshot: runs silently each time the app is opened
  const portfolioId = (portfolio as { id?: string } | null | undefined)?.id
  useEffect(() => {
    if (!portfolioId) return
    void checkAndCaptureWeeklySnapshot(portfolioId)
  }, [portfolioId])

  const driftSummary = useDriftSummary(portfolioId)
  const driftAlerts = driftSummary?.summary.overallHealth === 'action-needed'

  // null  → still loading from IndexedDB; show nothing to avoid flash
  if (portfolio === null) return null

  // undefined → no portfolio exists yet; show the first-run wizard
  if (portfolio === undefined) return <SetupWizard />

  // Portfolio exists → normal app shell
  return (
    <div className="flex h-dvh flex-col bg-background">
      {/* ── App header: mode toggle ──────────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center justify-center border-b border-border bg-background px-4">
        <ModeToggle />
      </header>

      {/* ── Tab content ─────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto pb-16">
        {mode === 'portfolio'
          ? PORTFOLIO_TAB_CONTENT[activeTab]
          : <BuildShell />
        }
      </main>

      {/* ── Bottom navigation ───────────────────────────────────────────── */}
      {mode === 'portfolio' ? (
        <BottomNav
          mode="portfolio"
          activeTab={activeTab}
          onTabChange={setActiveTab}
          alerts={{ dashboard: driftAlerts }}
        />
      ) : (
        <BottomNav
          mode="build"
          activeTab={buildTab}
          onTabChange={setBuildTab}
        />
      )}

      {/* ── Global "+" FAB — Portfolio mode only ────────────────────────── */}
      {mode === 'portfolio' && !loggerOpen && (
        <div className="fixed bottom-20 right-4 z-40">
          <Button
            size="icon"
            className="h-14 w-14 rounded-full shadow-lg"
            onClick={() => setLoggerOpen(true)}
          >
            <Plus className="h-6 w-6" />
            <span className="sr-only">Log operation</span>
          </Button>
        </div>
      )}

      {/* ── Operation Logger sheet ──────────────────────────────────────── */}
      <OperationLogger
        open={loggerOpen}
        onOpenChange={setLoggerOpen}
        portfolioId={portfolio.id}
      />
    </div>
  )
}
