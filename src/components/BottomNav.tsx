import { LayoutDashboard, TrendingUp, ClipboardList, BarChart2, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TabId } from '@/stores/uiStore'

export type { TabId }

const TABS: { id: TabId; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: 'dashboard',    label: 'Dashboard',  Icon: LayoutDashboard },
  { id: 'dca-planner',  label: 'DCA',        Icon: TrendingUp },
  { id: 'operations',   label: 'Operations', Icon: ClipboardList },
  { id: 'performance',  label: 'Performance',Icon: BarChart2 },
  { id: 'settings',     label: 'Settings',   Icon: Settings },
]

interface BottomNavProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
}

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background pb-safe">
      <div className="flex h-16 items-stretch">
        {TABS.map(({ id, label, Icon }) => {
          const active = activeTab === id
          return (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors',
                active
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className={cn('h-5 w-5', active && 'text-primary')} />
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
