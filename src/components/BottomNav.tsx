import {
  LayoutDashboard,
  TrendingUp,
  ClipboardList,
  BarChart2,
  Settings,
  Layers,
  FlaskConical,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortfolioTabId, BuildTabId } from '@/stores/uiStore'
import type { Mode } from '@/stores/modeStore'

export type { PortfolioTabId, BuildTabId }

const PORTFOLIO_TABS: { id: PortfolioTabId; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: 'dashboard',    label: 'Dashboard',   Icon: LayoutDashboard },
  { id: 'dca-planner',  label: 'DCA',         Icon: TrendingUp },
  { id: 'operations',   label: 'Operations',  Icon: ClipboardList },
  { id: 'performance',  label: 'Performance', Icon: BarChart2 },
  { id: 'settings',     label: 'Settings',    Icon: Settings },
]

const BUILD_TABS: { id: BuildTabId; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: 'build-dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'builds',          label: 'Builds',    Icon: Layers },
  { id: 'lab',             label: 'Lab',        Icon: FlaskConical },
  { id: 'build-settings',  label: 'Settings',  Icon: Settings },
]

interface PortfolioNavProps {
  mode: 'portfolio'
  activeTab: PortfolioTabId
  onTabChange: (tab: PortfolioTabId) => void
  alerts?: Partial<Record<PortfolioTabId, boolean>>
}

interface BuildNavProps {
  mode: 'build'
  activeTab: BuildTabId
  onTabChange: (tab: BuildTabId) => void
  alerts?: Partial<Record<BuildTabId, boolean>>
}

type BottomNavProps = PortfolioNavProps | BuildNavProps

export function BottomNav(props: BottomNavProps) {
  const tabs = props.mode === 'portfolio' ? PORTFOLIO_TABS : BUILD_TABS

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background pb-safe">
      <div className="flex h-16 items-stretch">
        {tabs.map(({ id, label, Icon }) => {
          const active = props.activeTab === id
          return (
            <button
              key={id}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={() => (props.onTabChange as (tab: any) => void)(id)}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors',
                active
                  ? props.mode === 'build'
                    ? 'text-mode-accent'
                    : 'text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
                {props.alerts?.[id as keyof typeof props.alerts] && (
                  <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 ring-1 ring-background" />
                )}
              </div>
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

// Re-export Mode for consumers that imported TabId from here previously
export type { Mode }
