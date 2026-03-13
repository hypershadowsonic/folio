/**
 * AmmunitionPoolSettings.tsx
 *
 * Settings form for configuring the two-tier ammunition pool.
 * Saves to the `ammunitionPools` Dexie table (one record per portfolio).
 *
 * Validation:
 *   - Tier 2 deploy trigger must be a deeper drawdown than Tier 1
 *     (tier2.deployTriggerPct < tier1.deployTriggerPct, both negative)
 */

import { useState, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
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
import { cn } from '@/lib/utils'
import type { Holding } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TierForm {
  holdingId: string   // '' = not configured (cash only)
  value: string       // intended reserve in TWD (base currency)
  deployTriggerPct: string   // negative number as string, e.g., '-10'
}

const DEFAULT_TIER1: TierForm = { holdingId: '', value: '0', deployTriggerPct: '-10' }
const DEFAULT_TIER2: TierForm = { holdingId: '', value: '0', deployTriggerPct: '-20' }

// ─── TierSection ─────────────────────────────────────────────────────────────

function TierSection({
  label,
  description,
  form,
  onChange,
  holdings,
  error,
}: {
  label: string
  description: string
  form: TierForm
  onChange: (next: TierForm) => void
  holdings: Holding[]
  error?: string
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>
      </div>

      {/* Linked holding */}
      <div className="space-y-1.5">
        <Label className="text-xs">Linked Holding</Label>
        <Select
          value={form.holdingId}
          onValueChange={v => onChange({ ...form, holdingId: v === '__none__' ? '' : v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="None (cash only)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__" className="text-xs">
              None (cash only / not configured)
            </SelectItem>
            {holdings.map(h => (
              <SelectItem key={h.id} value={h.id} className="text-xs">
                {h.ticker} — {h.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">
          Link to a holding (e.g., SGOV) whose market value represents this reserve.
        </p>
      </div>

      {/* Intended reserve value */}
      <div className="space-y-1.5">
        <Label className="text-xs">Intended Reserve (TWD)</Label>
        <Input
          type="number"
          min="0"
          step="1000"
          placeholder="0"
          className="h-8 text-xs"
          value={form.value}
          onChange={e => onChange({ ...form, value: e.target.value })}
        />
        <p className="text-[10px] text-muted-foreground">
          Target market value in TWD. If the linked holding falls below this, the tier shows as 'Deploying'.
        </p>
      </div>

      {/* Deploy trigger */}
      <div className="space-y-1.5">
        <Label className="text-xs">Deploy Trigger (% drawdown from ATH)</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            max="0"
            step="1"
            placeholder="-10"
            className={cn('h-8 text-xs w-24', error && 'border-red-500')}
            value={form.deployTriggerPct}
            onChange={e => onChange({ ...form, deployTriggerPct: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">% from ATH</span>
        </div>
        {error && (
          <p className="text-[11px] text-red-500">{error}</p>
        )}
        <p className="text-[10px] text-muted-foreground">
          Enter a negative number (e.g., -10 = deploy when portfolio is 10% below all-time high).
        </p>
      </div>
    </div>
  )
}

// ─── AmmunitionPoolSettings ───────────────────────────────────────────────────

export function AmmunitionPoolSettings({ portfolioId }: { portfolioId: string }) {
  const [tier1, setTier1] = useState<TierForm>(DEFAULT_TIER1)
  const [tier2, setTier2] = useState<TierForm>(DEFAULT_TIER2)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  // Load existing config
  const existingPool = useLiveQuery(
    () => db.ammunitionPools.get(portfolioId),
    [portfolioId],
  )

  const holdings = useLiveQuery(
    () => db.holdings.where('portfolioId').equals(portfolioId).sortBy('ticker'),
    [portfolioId],
    [] as Holding[],
  )

  // Populate form when existing config loads
  useEffect(() => {
    if (existingPool === undefined) return   // still loading
    if (existingPool === null || existingPool === undefined) return   // nothing saved yet

    setTier1({
      holdingId: existingPool.tier1.holdingId ?? '',
      value: String(existingPool.tier1.value),
      deployTriggerPct: String(existingPool.tier1.deployTriggerPct),
    })
    setTier2({
      holdingId: existingPool.tier2.holdingId ?? '',
      value: String(existingPool.tier2.value),
      deployTriggerPct: String(existingPool.tier2.deployTriggerPct),
    })
  }, [existingPool])

  // ── Validation ──────────────────────────────────────────────────────────────

  const t1Trigger = parseFloat(tier1.deployTriggerPct) || 0
  const t2Trigger = parseFloat(tier2.deployTriggerPct) || 0

  const tier2TriggerError: string | undefined = (
    t1Trigger !== 0 && t2Trigger !== 0 && t2Trigger >= t1Trigger
  )
    ? `Tier 2 must be a deeper drawdown than Tier 1 (must be < ${t1Trigger}%)`
    : undefined

  const hasValidationError = !!tier2TriggerError

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (hasValidationError) return
    setSaving(true)

    try {
      await db.ammunitionPools.put({
        portfolioId,
        tier1: {
          holdingId: tier1.holdingId || null,
          value:     parseFloat(tier1.value) || 0,
          deployTriggerPct: t1Trigger,
        },
        tier2: {
          holdingId: tier2.holdingId || null,
          value:     parseFloat(tier2.value) || 0,
          deployTriggerPct: t2Trigger,
        },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 pt-2">
      <div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Configure two tiers of strategic reserve that deploy during market drawdowns.
          Tier 1 is your first response; Tier 2 activates at a deeper drawdown.
        </p>
      </div>

      <TierSection
        label="Tier 1 — Ready Reserve"
        description="First tranche. Typically a short-duration bond ETF (e.g., SGOV) or cash earmarked for the first buying opportunity."
        form={tier1}
        onChange={setTier1}
        holdings={holdings}
      />

      <div className="border-t border-border" />

      <TierSection
        label="Tier 2 — Deep Reserve"
        description="Second tranche. Deployed only during a severe drawdown. Must have a deeper trigger than Tier 1."
        form={tier2}
        onChange={setTier2}
        holdings={holdings}
        error={tier2TriggerError}
      />

      <Button
        size="sm"
        onClick={handleSave}
        disabled={hasValidationError || saving}
        className="w-full"
      >
        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Ammunition Pool'}
      </Button>
    </div>
  )
}
