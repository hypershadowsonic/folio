/**
 * PriceUpdateDialog — bulk "mark to market" form.
 *
 * Shows all holdings with current price + last-updated date.
 * On save: updates currentPricePerShare for changed holdings, captures ONE snapshot,
 * optionally syncs benchmarkConfig.currentPrice when a matching holding is updated.
 */

import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import { db } from '@/db/database'
import { captureSnapshot } from '@/db/snapshotService'
import type { Holding, BenchmarkConfig } from '@/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRelativeDate(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30)  return `${days}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface PriceUpdateDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  holdings: Holding[]
  portfolioId: string
  benchmarkConfig?: BenchmarkConfig
  onBenchmarkUpdated?: (ticker: string) => void
  /** holdingId → timestamp of most recent trade operation for that holding */
  lastUpdatedByHolding?: Map<string, Date>
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PriceUpdateDialog({
  open,
  onOpenChange,
  holdings,
  portfolioId,
  benchmarkConfig,
  onBenchmarkUpdated,
  lastUpdatedByHolding,
}: PriceUpdateDialogProps) {
  const [prices, setPrices]       = useState<Record<string, string>>({})
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [savedCount, setSavedCount] = useState<number | null>(null)

  // Re-initialise whenever dialog opens or holdings change
  useEffect(() => {
    if (!open) return
    const init: Record<string, string> = {}
    for (const h of holdings) {
      init[h.id] = h.currentPricePerShare != null ? String(h.currentPricePerShare) : ''
    }
    setPrices(init)
    setError(null)
    setSavedCount(null)
  }, [open, holdings])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      let updatedCount = 0

      // Update each holding where the price changed
      for (const h of holdings) {
        const raw    = prices[h.id] ?? ''
        const parsed = parseFloat(raw)
        if (!isNaN(parsed) && parsed > 0 && parsed !== h.currentPricePerShare) {
          await db.holdings.update(h.id, { currentPricePerShare: parsed })
          updatedCount++
        }
      }

      // Sync benchmarkConfig.currentPrice when a matching holding was updated
      if (benchmarkConfig) {
        const bmTicker = benchmarkConfig.ticker.toUpperCase()
        const matchH   = holdings.find(h => h.ticker.toUpperCase() === bmTicker)
        if (matchH) {
          const newPrice = parseFloat(prices[matchH.id] ?? '')
          if (!isNaN(newPrice) && newPrice > 0 && newPrice !== benchmarkConfig.currentPrice) {
            const portfolio = await db.portfolios.get(portfolioId)
            if (portfolio) {
              await db.portfolios.put({
                ...portfolio,
                benchmarkConfig: { ...benchmarkConfig, currentPrice: newPrice, updatedAt: new Date() },
                updatedAt: new Date(),
              })
              onBenchmarkUpdated?.(matchH.ticker)
            }
          }
        }
      }

      // ONE snapshot after all price updates
      const snap = await captureSnapshot(portfolioId)
      await db.snapshots.add({ id: crypto.randomUUID(), portfolioId, ...snap })

      setSavedCount(updatedCount)
      // Auto-close after brief success display
      setTimeout(() => onOpenChange(false), 1400)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save prices')
    } finally {
      setSaving(false)
    }
  }, [holdings, prices, portfolioId, benchmarkConfig, onBenchmarkUpdated, onOpenChange])

  const showLastUpdated = lastUpdatedByHolding && lastUpdatedByHolding.size > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Update Prices</DialogTitle>
        </DialogHeader>

        {savedCount !== null ? (
          /* ── Success state ──────────────────────────────────────────────── */
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
            </div>
            <p className="font-medium text-green-700 dark:text-green-400">
              {savedCount > 0
                ? `Prices updated for ${savedCount} holding${savedCount !== 1 ? 's' : ''}. Snapshot captured.`
                : 'No prices changed. Snapshot captured.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground -mt-2 mb-3">
              Enter the latest price for each holding. One snapshot is captured after saving.
            </p>

            {/* ── Holdings table ─────────────────────────────────────────── */}
            <div className="space-y-2.5">
              {holdings.length === 0 && (
                <p className="text-sm text-muted-foreground">No holdings to update.</p>
              )}

              {/* Header row (only when lastUpdated column is shown) */}
              {showLastUpdated && holdings.length > 0 && (
                <div className="flex items-center gap-3 px-0.5">
                  <div className="flex-1 min-w-0" />
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground w-20 text-right shrink-0">
                    Last Trade
                  </span>
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground w-8 text-right shrink-0">
                    Cur.
                  </span>
                  <div className="w-28 shrink-0" />
                </div>
              )}

              {holdings.map(h => {
                const lastUpdated = lastUpdatedByHolding?.get(h.id)
                return (
                  <div key={h.id} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{h.ticker}</p>
                      <p className="text-xs text-muted-foreground truncate">{h.name}</p>
                    </div>
                    {showLastUpdated && (
                      <span className="text-xs text-muted-foreground w-20 text-right shrink-0 tabular-nums">
                        {lastUpdated ? fmtRelativeDate(lastUpdated) : '—'}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground w-8 text-right shrink-0">
                      {h.currency}
                    </span>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      className="h-8 w-28 text-right tabular-nums shrink-0"
                      placeholder="0.00"
                      value={prices[h.id] ?? ''}
                      onChange={e => setPrices(prev => ({ ...prev, [h.id]: e.target.value }))}
                    />
                  </div>
                )
              })}
            </div>

            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" size="sm" disabled={saving}>Cancel</Button>
              </DialogClose>
              <Button size="sm" onClick={handleSave} disabled={saving || holdings.length === 0}>
                {saving ? 'Saving…' : 'Save Prices'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
