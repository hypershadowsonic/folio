/**
 * BenchmarkSettings.tsx
 *
 * Configures the benchmark used on the Performance tab.
 * Saves benchmarkConfig to the Portfolio record via portfolioStore.updatePortfolio.
 *
 * "Update from Holdings" auto-fills currentPrice if the ticker matches
 * an existing holding's currentPricePerShare.
 */

import { useState, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { RefreshCw } from 'lucide-react'
import { db } from '@/db/database'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { BenchmarkConfig } from '@/types'

// ─── Form state ───────────────────────────────────────────────────────────────

interface BenchmarkForm {
  ticker: string
  startPrice: string
  currentPrice: string
  currency: 'USD' | 'TWD'
}

const DEFAULT_FORM: BenchmarkForm = {
  ticker: 'VOO',
  startPrice: '',
  currentPrice: '',
  currency: 'USD',
}

// ─── BenchmarkSettings ────────────────────────────────────────────────────────

export function BenchmarkSettings({ portfolioId }: { portfolioId: string }) {
  const portfolio        = usePortfolioStore(s => s.portfolio)
  const updatePortfolio  = usePortfolioStore(s => s.updatePortfolio)

  const [form,    setForm]    = useState<BenchmarkForm>(DEFAULT_FORM)
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)

  const holdings = useLiveQuery(
    () => db.holdings.where('portfolioId').equals(portfolioId).sortBy('ticker'),
    [portfolioId],
    [],
  )

  // Populate form when portfolio loads
  useEffect(() => {
    if (!portfolio?.benchmarkConfig) return
    const cfg = portfolio.benchmarkConfig
    setForm({
      ticker:       cfg.ticker,
      startPrice:   String(cfg.startPrice),
      currentPrice: String(cfg.currentPrice),
      currency:     cfg.currency,
    })
  }, [portfolio?.benchmarkConfig])

  // ── "Update from Holdings" ───────────────────────────────────────────────

  function handleUpdateFromHolding() {
    const ticker  = form.ticker.trim().toUpperCase()
    const match   = holdings.find(h => h.ticker.toUpperCase() === ticker)
    if (match?.currentPricePerShare != null) {
      setForm(f => ({ ...f, currentPrice: String(match.currentPricePerShare) }))
    }
  }

  const matchingHolding = holdings.find(
    h => h.ticker.toUpperCase() === form.ticker.trim().toUpperCase(),
  )

  // ── Save ────────────────────────────────────────────────────────────────

  async function handleSave() {
    const sp = parseFloat(form.startPrice)
    const cp = parseFloat(form.currentPrice)
    if (!form.ticker.trim() || sp <= 0 || cp <= 0) return

    setSaving(true)
    try {
      const cfg: BenchmarkConfig = {
        ticker:       form.ticker.trim().toUpperCase(),
        startPrice:   sp,
        currentPrice: cp,
        currency:     form.currency,
        updatedAt:    new Date(),
      }
      await updatePortfolio({ benchmarkConfig: cfg })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  // ── Clear ────────────────────────────────────────────────────────────────

  async function handleClear() {
    setSaving(true)
    try {
      await updatePortfolio({ benchmarkConfig: undefined })
      setForm(DEFAULT_FORM)
    } finally {
      setSaving(false)
    }
  }

  const canSave =
    form.ticker.trim().length > 0 &&
    parseFloat(form.startPrice) > 0 &&
    parseFloat(form.currentPrice) > 0

  const lastUpdated = portfolio?.benchmarkConfig?.updatedAt

  return (
    <div className="space-y-4 pt-2">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Configure a benchmark to compare your portfolio return against on the Performance tab.
        Prices are updated manually — no live data feed.
      </p>

      {/* Ticker + Currency row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Benchmark Ticker</Label>
          <Input
            type="text"
            placeholder="e.g. VOO"
            className="h-8 text-xs uppercase"
            value={form.ticker}
            onChange={e => setForm(f => ({ ...f, ticker: e.target.value.toUpperCase() }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Currency</Label>
          <Select
            value={form.currency}
            onValueChange={v => setForm(f => ({ ...f, currency: v as 'USD' | 'TWD' }))}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USD" className="text-xs">USD</SelectItem>
              <SelectItem value="TWD" className="text-xs">TWD</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Start price */}
      <div className="space-y-1.5">
        <Label className="text-xs">Start Price ({form.currency})</Label>
        <Input
          type="number"
          min="0"
          step="any"
          placeholder="0.00"
          className="h-8 text-xs"
          value={form.startPrice}
          onChange={e => setForm(f => ({ ...f, startPrice: e.target.value }))}
        />
        <p className="text-[10px] text-muted-foreground">
          Price at portfolio inception or the start of your tracking period.
        </p>
      </div>

      {/* Current price + auto-fill */}
      <div className="space-y-1.5">
        <Label className="text-xs">Current Price ({form.currency})</Label>
        <div className="flex gap-2">
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            className="h-8 text-xs flex-1"
            value={form.currentPrice}
            onChange={e => setForm(f => ({ ...f, currentPrice: e.target.value }))}
          />
          {matchingHolding && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2 shrink-0"
              onClick={handleUpdateFromHolding}
              title={`Fill from ${matchingHolding.ticker} holding (${matchingHolding.currentPricePerShare ?? 'no price'})`}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              From holding
            </Button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          Update this whenever you update holding prices.
          {matchingHolding && matchingHolding.currentPricePerShare != null && (
            <span className="ml-1">
              Holding {matchingHolding.ticker} is at {matchingHolding.currentPricePerShare} {matchingHolding.currency}.
            </span>
          )}
        </p>
      </div>

      {/* Last updated */}
      {lastUpdated && (
        <p className="text-[11px] text-muted-foreground">
          Last updated: {new Date(lastUpdated).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          disabled={!canSave || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Benchmark'}
        </Button>
        {portfolio?.benchmarkConfig && (
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={handleClear}
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}
