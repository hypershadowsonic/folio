import { useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { recordCashDeposit, recordCashWithdrawal, InsufficientCashError } from '@/db/cashFxService'

interface LogCashDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  portfolioId: string
  /** Pre-select a currency when opening from a specific balance card. */
  defaultCurrency?: 'TWD' | 'USD'
  /** Pre-select a direction when opening from Deposit/Withdraw buttons. */
  defaultDirection?: 'deposit' | 'withdraw'
}

export function LogCashDialog({
  open, onOpenChange, portfolioId,
  defaultCurrency = 'TWD',
  defaultDirection = 'deposit',
}: LogCashDialogProps) {
  const initialDirection = defaultDirection === 'withdraw' ? 'withdrawal' : 'deposit'
  const [direction, setDirection] = useState<'deposit' | 'withdrawal'>(initialDirection)
  const [currency, setCurrency] = useState<'TWD' | 'USD'>(defaultCurrency)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function reset() {
    setDirection(initialDirection)
    setCurrency(defaultCurrency)
    setAmount('')
    setNote('')
    setError(null)
  }

  async function handleSubmit() {
    const parsed = parseFloat(amount)
    if (!parsed || parsed <= 0) {
      setError('Enter a valid positive amount.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (direction === 'deposit') {
        await recordCashDeposit(portfolioId, currency, parsed, note || undefined)
      } else {
        await recordCashWithdrawal(portfolioId, currency, parsed, note || undefined)
      }
      reset()
      onOpenChange(false)
    } catch (err) {
      if (err instanceof InsufficientCashError) {
        setError(`Insufficient ${err.currency} balance — short by ${err.shortfall.toFixed(2)}.`)
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
          <DialogTitle>Log Cash Movement</DialogTitle>
          <DialogDescription>Record a deposit or withdrawal for your portfolio.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Direction */}
          <div className="space-y-1.5">
            <Label>Direction</Label>
            <RadioGroup
              value={direction}
              onValueChange={(v) => setDirection(v as 'deposit' | 'withdrawal')}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="deposit" id="cash-deposit" />
                <Label htmlFor="cash-deposit">Deposit</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="withdrawal" id="cash-withdrawal" />
                <Label htmlFor="cash-withdrawal">Withdrawal</Label>
              </div>
            </RadioGroup>
          </div>

          {/* Currency */}
          <div className="space-y-1.5">
            <Label>Currency</Label>
            <RadioGroup
              value={currency}
              onValueChange={(v) => setCurrency(v as 'TWD' | 'USD')}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="TWD" id="cash-twd" />
                <Label htmlFor="cash-twd">TWD</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="USD" id="cash-usd" />
                <Label htmlFor="cash-usd">USD</Label>
              </div>
            </RadioGroup>
          </div>

          {/* Amount */}
          <div className="space-y-1.5">
            <Label htmlFor="cash-amount">Amount</Label>
            <Input
              id="cash-amount"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
          </div>

          {/* Note / Rationale */}
          <div className="space-y-1.5">
            <Label htmlFor="cash-note">Note (rationale)</Label>
            <Textarea
              id="cash-note"
              placeholder="e.g. Monthly salary transfer to brokerage"
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
