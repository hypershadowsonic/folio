import { useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { recordFxExchange, InsufficientCashError } from '@/db/cashFxService'

interface LogFxDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  portfolioId: string
}

export function LogFxDialog({ open, onOpenChange, portfolioId }: LogFxDialogProps) {
  // Fixed direction: TWD → USD (the only flow in MVP — buying USD to purchase ETFs)
  const [fromAmount, setFromAmount] = useState('')
  const [toAmount, setToAmount] = useState('')
  const [rate, setRate] = useState('')
  const [fees, setFees] = useState('0')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Auto-fill rate when both sides are filled
  function handleFromAmount(value: string) {
    setFromAmount(value)
    const f = parseFloat(value)
    const t = parseFloat(toAmount)
    if (f > 0 && t > 0) setRate((f / t).toFixed(4))
  }

  function handleToAmount(value: string) {
    setToAmount(value)
    const f = parseFloat(fromAmount)
    const t = parseFloat(value)
    if (f > 0 && t > 0) setRate((f / t).toFixed(4))
  }

  function reset() {
    setFromAmount('')
    setToAmount('')
    setRate('')
    setFees('0')
    setNote('')
    setError(null)
  }

  async function handleSubmit() {
    const parsedFrom = parseFloat(fromAmount)
    const parsedTo   = parseFloat(toAmount)
    const parsedRate = parseFloat(rate)
    const parsedFees = parseFloat(fees) || 0

    if (!parsedFrom || parsedFrom <= 0) { setError('Enter the TWD amount.'); return }
    if (!parsedTo   || parsedTo   <= 0) { setError('Enter the USD amount.'); return }
    if (!parsedRate || parsedRate <= 0) { setError('Enter the exchange rate.'); return }

    setSaving(true)
    setError(null)
    try {
      await recordFxExchange(portfolioId, {
        fromCurrency: 'TWD',
        fromAmount: parsedFrom,
        toCurrency: 'USD',
        toAmount: parsedTo,
        rate: parsedRate,
        fees: parsedFees,
        feesCurrency: 'TWD',
        note: note || undefined,
      })
      reset()
      onOpenChange(false)
    } catch (err) {
      if (err instanceof InsufficientCashError) {
        setError(`Insufficient ${err.currency} — short by ${err.shortfall.toFixed(2)}.`)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log FX Exchange</DialogTitle>
          <DialogDescription>Record a TWD → USD currency conversion.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* From */}
          <div className="space-y-1.5">
            <Label htmlFor="fx-from">TWD amount (from)</Label>
            <Input
              id="fx-from"
              type="number"
              min="0"
              step="1"
              placeholder="0"
              value={fromAmount}
              onChange={e => handleFromAmount(e.target.value)}
            />
          </div>

          {/* To */}
          <div className="space-y-1.5">
            <Label htmlFor="fx-to">USD amount (to)</Label>
            <Input
              id="fx-to"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={toAmount}
              onChange={e => handleToAmount(e.target.value)}
            />
          </div>

          {/* Rate */}
          <div className="space-y-1.5">
            <Label htmlFor="fx-rate">Exchange rate (TWD per USD)</Label>
            <Input
              id="fx-rate"
              type="number"
              min="0"
              step="0.0001"
              placeholder="e.g. 31.50"
              value={rate}
              onChange={e => setRate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Auto-calculated from amounts above.</p>
          </div>

          {/* Fees */}
          <div className="space-y-1.5">
            <Label htmlFor="fx-fees">Fees (TWD)</Label>
            <Input
              id="fx-fees"
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={fees}
              onChange={e => setFees(e.target.value)}
            />
          </div>

          {/* Note */}
          <div className="space-y-1.5">
            <Label htmlFor="fx-note">Note (rationale)</Label>
            <Textarea
              id="fx-note"
              placeholder="e.g. Monthly DCA FX conversion at IBKR"
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false) }}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving…' : 'Log'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
