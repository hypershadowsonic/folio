import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/uiStore'
import type { ApiStatus } from '@/types'

const STATUS_CONFIG: Record<ApiStatus, { label: string; dotClass: string }> = {
  'online':           { label: 'Online',              dotClass: 'bg-emerald-500' },
  'offline-cached':   { label: 'Offline (cached)',    dotClass: 'bg-amber-400' },
  'offline-no-cache': { label: 'Offline (no cache)',  dotClass: 'bg-red-500' },
}

interface ApiStatusIndicatorProps {
  className?: string
  showLabel?: boolean
}

export function ApiStatusIndicator({ className, showLabel = true }: ApiStatusIndicatorProps) {
  const apiStatus = useUIStore((s) => s.apiStatus)
  const { label, dotClass } = STATUS_CONFIG[apiStatus]

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span
        className={cn('h-2 w-2 rounded-full flex-shrink-0', dotClass)}
        aria-hidden="true"
      />
      {showLabel && (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
      <span className="sr-only">API status: {label}</span>
    </div>
  )
}
