import { useModeStore } from '@/stores/modeStore'
import { cn } from '@/lib/utils'

export function ModeToggle() {
  const mode    = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)

  return (
    <div
      role="tablist"
      aria-label="App mode"
      className="flex h-8 rounded-full border border-border bg-muted p-0.5 text-xs font-semibold"
    >
      <button
        role="tab"
        aria-selected={mode === 'portfolio'}
        onClick={() => setMode('portfolio')}
        className={cn(
          'flex items-center rounded-full px-3 transition-colors',
          mode === 'portfolio'
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        Portfolio
      </button>
      <button
        role="tab"
        aria-selected={mode === 'build'}
        onClick={() => setMode('build')}
        className={cn(
          'flex items-center rounded-full px-3 transition-colors',
          mode === 'build'
            ? 'bg-mode-accent text-white shadow-sm'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        Build
      </button>
    </div>
  )
}
