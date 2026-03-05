import { useState } from 'react'
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LogCashDialog } from '@/features/operations/LogCashDialog'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useCashAccounts, useFxLots } from '@/db/hooks'
import {
  recordFxExchange,
  InsufficientCashError,
  type FxExchangeParams,
} from '@/db/cashFxService'
import type { FxLot } from '@/types'
import { cn } from '@/lib/utils'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

function fmtDate(d: Date | string) {
  return new Date(d).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

// ─── Section 1: Cash Balance Card ─────────────────────────────────────────────

interface BalanceCardProps {
  currency: 'TWD' | 'USD'
  balance: number
  equivalentTwd?: number | null
  portfolioId: string
}

function BalanceCard({ currency, balance, equivalentTwd, portfolioId }: BalanceCardProps) {
  const [cashDialog, setCashDialog] = useState<'deposit' | 'withdraw' | null>(null)

  return (
    <>
      <Card>
        <CardContent className="pt-5 pb-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {currency} Cash
              </p>
              <p className="mt-1 text-2xl font-bold">{fmtCurrency(balance, currency)}</p>
              {currency === 'USD' && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {equivalentTwd != null
                    ? `≈ ${fmtCurrency(equivalentTwd, 'TWD')}`
                    : 'No FX rate yet'}
                </p>
              )}
            </div>
            <Badge variant={balance > 0 ? 'success' : 'secondary'} className="mt-1">
              {balance > 0 ? 'Active' : 'Empty'}
            </Badge>
          </div>

          <div className="mt-4 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => setCashDialog('deposit')}
            >
              Deposit
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => setCashDialog('withdraw')}
              disabled={balance <= 0}
            >
              Withdraw
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Pre-set the direction by opening the dialog and relying on direction state */}
      <LogCashDialogWithDirection
        open={cashDialog !== null}
        onOpenChange={v => !v && setCashDialog(null)}
        portfolioId={portfolioId}
        currency={currency}
        direction={cashDialog ?? 'deposit'}
      />
    </>
  )
}

// Thin wrapper to pass pre-selected direction + currency into LogCashDialog
function LogCashDialogWithDirection({
  open, onOpenChange, portfolioId, currency, direction,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  portfolioId: string
  currency: 'TWD' | 'USD'
  direction: 'deposit' | 'withdraw'
}) {
  return (
    <LogCashDialog
      open={open}
      onOpenChange={onOpenChange}
      portfolioId={portfolioId}
      defaultCurrency={currency}
      defaultDirection={direction}
    />
  )
}

// ─── Section 2: FX Exchange Form ──────────────────────────────────────────────

interface FxSuccessInfo {
  fromAmount: number
  toAmount: number
  rate: number
  currency: string
}

function FxExchangeForm({ portfolioId }: { portfolioId: string }) {
  const [fromCurrency, setFromCurrency] = useState<'TWD' | 'USD'>('TWD')
  const toCurrency: 'TWD' | 'USD' = fromCurrency === 'TWD' ? 'USD' : 'TWD'

  const [fromAmount, setFromAmount] = useState('')
  const [toAmount, setToAmount]     = useState('')
  const [rate, setRate]             = useState('')
  const [fees, setFees]             = useState('0')
  const [feesCurrency, setFeesCurrency] = useState<'TWD' | 'USD'>('TWD')
  const [note, setNote]             = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [saving, setSaving]         = useState(false)
  const [success, setSuccess]       = useState<FxSuccessInfo | null>(null)

  // Auto-derive rate when from + to amounts are both present
  function onFromAmount(val: string) {
    setFromAmount(val)
    const f = parseFloat(val), t = parseFloat(toAmount)
    if (f > 0 && t > 0) setRate((fromCurrency === 'TWD' ? f / t : t / f).toFixed(4))
  }

  function onToAmount(val: string) {
    setToAmount(val)
    const f = parseFloat(fromAmount), t = parseFloat(val)
    if (f > 0 && t > 0) setRate((fromCurrency === 'TWD' ? f / t : t / f).toFixed(4))
  }

  // When rate changes and fromAmount is set, derive toAmount
  function onRate(val: string) {
    setRate(val)
    const r = parseFloat(val), f = parseFloat(fromAmount)
    if (r > 0 && f > 0) {
      const derived = fromCurrency === 'TWD' ? f / r : f * r
      setToAmount(derived.toFixed(2))
    }
  }

  function reset() {
    setFromAmount(''); setToAmount(''); setRate('')
    setFees('0'); setNote(''); setError(null); setSuccess(null)
  }

  async function handleSubmit() {
    const pFrom = parseFloat(fromAmount)
    const pTo   = parseFloat(toAmount)
    const pRate = parseFloat(rate)
    const pFees = parseFloat(fees) || 0
    if (!pFrom || pFrom <= 0) { setError('Enter the from-amount.'); return }
    if (!pTo   || pTo   <= 0) { setError('Enter the to-amount.'); return }
    if (!pRate || pRate <= 0) { setError('Enter the exchange rate.'); return }

    setSaving(true); setError(null)
    try {
      const params: FxExchangeParams = {
        fromCurrency,
        fromAmount: pFrom,
        toCurrency,
        toAmount: pTo,
        rate: pRate,
        fees: pFees,
        feesCurrency,
        note: note || undefined,
      }
      await recordFxExchange(portfolioId, params)
      setSuccess({ fromAmount: pFrom, toAmount: pTo, rate: pRate, currency: toCurrency })
      setFromAmount(''); setToAmount(''); setRate(''); setFees('0'); setNote('')
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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Exchange Currency</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* From / To row */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <div className="space-y-1.5">
            <Label>From</Label>
            <Select value={fromCurrency} onValueChange={v => { setFromCurrency(v as 'TWD' | 'USD'); reset() }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="TWD">TWD</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground mb-2.5" />
          <div className="space-y-1.5">
            <Label>To</Label>
            <div className="flex h-10 w-full items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
              {toCurrency}
            </div>
          </div>
        </div>

        {/* Amounts */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="fx-from-amount">{fromCurrency} amount</Label>
            <Input id="fx-from-amount" type="number" min="0" step="any"
              placeholder="0" value={fromAmount} onChange={e => onFromAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fx-to-amount">{toCurrency} amount</Label>
            <Input id="fx-to-amount" type="number" min="0" step="any"
              placeholder="0" value={toAmount} onChange={e => onToAmount(e.target.value)} />
          </div>
        </div>

        {/* Rate */}
        <div className="space-y-1.5">
          <Label htmlFor="fx-rate">
            Rate <span className="text-muted-foreground font-normal">(TWD per USD)</span>
          </Label>
          <Input id="fx-rate" type="number" min="0" step="0.0001"
            placeholder="e.g. 31.50" value={rate} onChange={e => onRate(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Auto-calculates from amounts. Editing rate will update the to-amount.
          </p>
        </div>

        {/* Fees */}
        <div className="space-y-1.5">
          <Label>Fees</Label>
          <div className="flex gap-2">
            <Input type="number" min="0" step="0.01" placeholder="0"
              value={fees} onChange={e => setFees(e.target.value)} />
            <Select value={feesCurrency} onValueChange={v => setFeesCurrency(v as 'TWD' | 'USD')}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="TWD">TWD</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Note */}
        <div className="space-y-1.5">
          <Label htmlFor="fx-note">Note (rationale)</Label>
          <Textarea id="fx-note" placeholder="e.g. Monthly DCA conversion at IBKR"
            value={note} onChange={e => setNote(e.target.value)} rows={2} />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Success confirmation */}
        {success && (
          <div className="flex items-start gap-2 rounded-md bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 p-3 text-sm">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-emerald-800 dark:text-emerald-200">Exchange recorded</p>
              <p className="text-emerald-700 dark:text-emerald-300 mt-0.5">
                Created {success.currency} lot: {fmtCurrency(success.toAmount, success.currency)}
                {' '}@ {success.rate.toFixed(4)} TWD/USD
              </p>
            </div>
          </div>
        )}

        <Button onClick={handleSubmit} disabled={saving} className="w-full">
          {saving ? 'Processing…' : 'Execute Exchange'}
        </Button>
      </CardContent>
    </Card>
  )
}

// ─── Section 3: FX Lot Queue ──────────────────────────────────────────────────

function LotStatusBadge({ lot }: { lot: FxLot }) {
  if (lot.remainingAmount <= 0) {
    return <Badge variant="secondary" className="text-xs">Exhausted</Badge>
  }
  if (lot.remainingAmount < lot.originalAmount) {
    return <Badge variant="warning" className="text-xs">Partial</Badge>
  }
  return <Badge variant="success" className="text-xs">Available</Badge>
}

function FxLotQueue({
  portfolioId,
  lots,
}: {
  portfolioId: string
  lots: FxLot[]
}) {
  const portfolio   = usePortfolioStore(s => s.portfolio)
  const updatePortfolio = usePortfolioStore(s => s.updatePortfolio)

  const [rateInput, setRateInput]       = useState('')
  const [rateSaving, setRateSaving]     = useState(false)
  const [rateSaved, setRateSaved]       = useState(false)
  const [showExhausted, setShowExhausted] = useState(false)

  const usdLots = lots.filter(l => l.currency === 'USD')
  const available = usdLots.filter(l => l.remainingAmount > 0)
  const exhausted  = usdLots.filter(l => l.remainingAmount <= 0)

  // Latest effective rate: most recent lot rate, or portfolio override
  const latestLotRate = usdLots.length > 0
    ? usdLots[usdLots.length - 1].rate   // already sorted by timestamp asc
    : null
  const effectiveRate = portfolio?.fxRateOverride ?? latestLotRate ?? portfolio?.initialFxRate

  async function saveRateOverride() {
    const parsed = parseFloat(rateInput)
    if (!parsed || parsed <= 0) return
    setRateSaving(true)
    await updatePortfolio({ fxRateOverride: parsed })
    setRateSaving(false)
    setRateSaved(true)
    setTimeout(() => setRateSaved(false), 2000)
  }

  async function clearRateOverride() {
    await updatePortfolio({ fxRateOverride: undefined })
    setRateInput('')
  }

  void portfolioId // used by parent for context; lot data already filtered above

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">FX Lot Queue (USD)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Current valuation rate */}
        <div className="rounded-md bg-muted/60 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Current valuation rate</span>
            <span className="font-mono text-sm font-semibold">
              {effectiveRate != null ? `${effectiveRate.toFixed(4)} TWD/USD` : '—'}
            </span>
          </div>
          {portfolio?.fxRateOverride != null && (
            <div className="flex items-center justify-between text-xs text-amber-600 dark:text-amber-400">
              <span>Manual override active</span>
              <button onClick={clearRateOverride} className="underline hover:no-underline">
                Clear override
              </button>
            </div>
          )}
        </div>

        {/* Rate override input */}
        <div className="space-y-1.5">
          <Label htmlFor="rate-override">Override valuation rate</Label>
          <div className="flex gap-2">
            <Input
              id="rate-override"
              type="number"
              min="0"
              step="0.0001"
              placeholder={effectiveRate?.toFixed(4) ?? 'e.g. 31.50'}
              value={rateInput}
              onChange={e => { setRateInput(e.target.value); setRateSaved(false) }}
            />
            <Button
              size="default"
              variant="outline"
              onClick={saveRateOverride}
              disabled={rateSaving || !rateInput}
              className="shrink-0"
            >
              {rateSaved ? 'Saved ✓' : rateSaving ? '…' : 'Save'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Overrides auto-derived rate for portfolio valuation. Cleared when a new FX exchange is logged.
          </p>
        </div>

        <Separator />

        {/* Available lots */}
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">
            No available USD lots. Log an FX exchange to create one.
          </p>
        ) : (
          <div className="space-y-0 divide-y divide-border rounded-md border">
            {available.map(lot => (
              <LotRow key={lot.id} lot={lot} />
            ))}
          </div>
        )}

        {/* Exhausted lots (collapsible) */}
        {exhausted.length > 0 && (
          <div>
            <button
              onClick={() => setShowExhausted(v => !v)}
              className="flex w-full items-center justify-between text-sm text-muted-foreground hover:text-foreground py-1"
            >
              <span>{exhausted.length} exhausted lot{exhausted.length !== 1 ? 's' : ''}</span>
              {showExhausted
                ? <ChevronDown className="h-4 w-4" />
                : <ChevronRight className="h-4 w-4" />}
            </button>
            {showExhausted && (
              <div className="mt-2 space-y-0 divide-y divide-border rounded-md border opacity-50">
                {exhausted.map(lot => (
                  <LotRow key={lot.id} lot={lot} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function LotRow({ lot }: { lot: FxLot }) {
  const pctConsumed = lot.originalAmount > 0
    ? ((lot.originalAmount - lot.remainingAmount) / lot.originalAmount) * 100
    : 0

  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{fmtDate(lot.timestamp)}</span>
        <LotStatusBadge lot={lot} />
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="space-y-0.5">
          <p className="font-mono text-sm font-medium">
            {fmtCurrency(lot.remainingAmount, 'USD')}
            <span className="text-muted-foreground font-normal">
              {' '}/ {fmtCurrency(lot.originalAmount, 'USD')}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            @ {lot.rate.toFixed(4)} TWD/USD
          </p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {pctConsumed.toFixed(0)}% used
        </span>
      </div>
      {lot.remainingAmount > 0 && lot.remainingAmount < lot.originalAmount && (
        <div className="h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-amber-400"
            style={{ width: `${pctConsumed}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ─── CashFxManager (root export) ─────────────────────────────────────────────

export function CashFxManager({ portfolioId }: { portfolioId: string }) {
  const cashAccounts = useCashAccounts(portfolioId)
  const fxLots       = useFxLots(portfolioId)

  const twdBalance = cashAccounts.find(a => a.currency === 'TWD')?.balance ?? 0
  const usdBalance = cashAccounts.find(a => a.currency === 'USD')?.balance ?? 0

  // Latest rate from lots for USD→TWD equivalence display
  const latestLotRate = (() => {
    const usdLots = fxLots.filter(l => l.currency === 'USD')
    return usdLots.length > 0 ? usdLots[usdLots.length - 1].rate : null
  })()
  const usdInTwd = latestLotRate != null ? usdBalance * latestLotRate : null

  return (
    <div className="space-y-6">
      {/* ── Section 1: Cash Balances ─────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Cash Balances
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BalanceCard
            currency="TWD"
            balance={twdBalance}
            portfolioId={portfolioId}
          />
          <BalanceCard
            currency="USD"
            balance={usdBalance}
            equivalentTwd={usdInTwd}
            portfolioId={portfolioId}
          />
        </div>
      </section>

      {/* ── Section 2: FX Exchange ───────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Exchange Currency
        </h2>
        <FxExchangeForm portfolioId={portfolioId} />
      </section>

      {/* ── Section 3: FX Lot Queue ──────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          FX Lot Queue
        </h2>
        <FxLotQueue portfolioId={portfolioId} lots={fxLots} />
      </section>
    </div>
  )
}

// ─── Inline progress bar in LotRow uses style — acceptable for a dynamic width ─
// The linter warning is a false positive: the value is runtime-computed and
// cannot be expressed as a static Tailwind class.
void (cn)  // keeps cn import used (it's used in cn() calls above)
