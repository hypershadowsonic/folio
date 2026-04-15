import { useState } from 'react'
import { RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { LabSharedControls } from './useLabState'

interface SharedControlsProps {
  controls: LabSharedControls
  onChange: (update: Partial<LabSharedControls>) => void
  isAStale: boolean
  isBStale: boolean
  onUpdateAll: () => void
  isRunningAny: boolean
  onReset: () => Promise<void>
  benchmarkTicker: string | null
  onBenchmarkChange: (ticker: string | null) => void
  onRunBenchmark: (ticker: string) => void
}

const today = new Date().toISOString().slice(0, 10)

export function SharedControls({
  controls,
  onChange,
  isAStale,
  isBStale,
  onUpdateAll,
  isRunningAny,
  onReset,
  benchmarkTicker,
  onBenchmarkChange,
  onRunBenchmark,
}: SharedControlsProps) {
  const [resetOpen, setResetOpen] = useState(false)
  const [bmInput, setBmInput] = useState(benchmarkTicker ?? '')
  const isAnyStale = isAStale || isBStale

  async function handleReset() {
    await onReset()
    setResetOpen(false)
  }

  function handleBmSubmit() {
    const t = bmInput.trim().toUpperCase()
    if (!t) {
      onBenchmarkChange(null)
      return
    }
    onBenchmarkChange(t)
    onRunBenchmark(t)
  }

  function handleBmClear() {
    setBmInput('')
    onBenchmarkChange(null)
  }

  return (
    <>
      <div className="border-b bg-background px-3 py-2.5 space-y-2.5">
        {/* Row 1: date range + currency + frequency + amount */}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          {/* Date range */}
          <div className="flex items-center gap-1.5">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">From</Label>
              <input
                type="date"
                max={today}
                value={controls.startDate}
                onChange={(e) => onChange({ startDate: e.target.value })}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring w-[130px]"
              />
            </div>
            <span className="text-muted-foreground text-xs mt-4">–</span>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">To</Label>
              <input
                type="date"
                max={today}
                value={controls.endDate}
                onChange={(e) => onChange({ endDate: e.target.value })}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring w-[130px]"
              />
            </div>
          </div>

          {/* Currency toggle */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Currency</Label>
            <div className="flex rounded-md border overflow-hidden h-8">
              {(['USD', 'TWD'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => onChange({ dcaCurrency: c })}
                  className={cn(
                    'px-2.5 text-xs font-medium transition-colors',
                    controls.dcaCurrency === c
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Frequency */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Frequency</Label>
            <div className="flex rounded-md border overflow-hidden h-8">
              {(['weekly', 'biweekly', 'monthly'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => onChange({ dcaFrequency: f })}
                  className={cn(
                    'px-2.5 text-xs font-medium transition-colors capitalize',
                    controls.dcaFrequency === f
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent',
                  )}
                >
                  {f === 'biweekly' ? 'Bi-wk' : f.charAt(0).toUpperCase() + f.slice(1, 3)}
                </button>
              ))}
            </div>
          </div>

          {/* DCA amount */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              Amount ({controls.dcaCurrency})
            </Label>
            <Input
              type="number"
              min="1"
              step="100"
              value={controls.dcaAmount}
              onChange={(e) => onChange({ dcaAmount: parseFloat(e.target.value) || 1000 })}
              className="h-8 w-24 text-xs"
            />
          </div>

          {/* Action buttons */}
          <div className="flex items-end gap-1.5 ml-auto">
            {isAnyStale && (
              <Button
                size="sm"
                onClick={onUpdateAll}
                disabled={isRunningAny}
                className="h-8 gap-1.5 text-xs"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isRunningAny && 'animate-spin')} />
                Update All
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setResetOpen(true)}
              className="h-8 gap-1.5 text-xs text-muted-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset Lab
            </Button>
          </div>
        </div>

        {/* Row 2: benchmark ticker */}
        <div className="flex items-center gap-2">
          <Label className="text-[10px] text-muted-foreground shrink-0">Quick Benchmark</Label>
          <div className="flex items-center gap-1.5">
            <Input
              placeholder="e.g. SPY"
              value={bmInput}
              onChange={(e) => setBmInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') handleBmSubmit() }}
              className="h-7 w-24 text-xs font-mono"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleBmSubmit}
              className="h-7 w-7 p-0"
              aria-label="Add benchmark"
            >
              <Search className="h-3 w-3" />
            </Button>
            {benchmarkTicker && (
              <button
                onClick={handleBmClear}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Remove benchmark"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {benchmarkTicker && (
              <span className="text-xs text-muted-foreground">
                Showing: <span className="font-mono font-semibold">{benchmarkTicker}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Reset confirmation dialog */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Lab?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will clear both Build makers, the chart, and all saved Lab state. Your saved Builds
            in the Builds tab are not affected.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleReset}>
              Reset Lab
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
