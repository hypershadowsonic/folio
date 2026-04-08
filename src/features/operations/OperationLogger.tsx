/**
 * OperationLogger — full-screen operation entry sheet.
 *
 * Triggered by a global "+" FAB. Handles all 8 loggable operation types:
 * BUY, SELL, TACTICAL_ROTATION, DRAWDOWN_DEPLOY, DIVIDEND_REINVEST,
 * CASH_DEPOSIT, CASH_WITHDRAWAL, FX_EXCHANGE.
 *
 * Uses Radix Dialog primitives directly for a full-screen layout without the
 * built-in close button that the shadcn DialogContent wrapper includes.
 */

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  TrendingUp, TrendingDown, ArrowLeftRight, ShieldAlert,
  Coins, PiggyBank, Wallet, ArrowRightLeft, X, ChevronLeft,
  CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select, SelectContent, SelectGroup, SelectItem,
  SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { db } from '@/db'
import { useHoldings, useSleeves, useCashAccounts } from '@/db/hooks'
import {
  createTradeOperation, createTacticalRotation,
  InsufficientSharesError,
} from '@/db/operationService'
import {
  recordCashDeposit, recordCashWithdrawal, recordFxExchange,
  InsufficientCashError,
} from '@/db/cashFxService'
import { InsufficientFxLotsError } from '@/engine/fifo'
import type { Holding, OperationType, Sleeve } from '@/types'
import { getLatestCachedPrice } from '@/services/yahooFinance'

// ─── Operation type config ────────────────────────────────────────────────────

type LoggableType =
  | 'BUY' | 'SELL' | 'TACTICAL_ROTATION' | 'DRAWDOWN_DEPLOY'
  | 'DIVIDEND_REINVEST' | 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL' | 'FX_EXCHANGE'

type FormGroup = 'trade' | 'rotation' | 'cash' | 'fx'

interface TypeConfig {
  type: LoggableType
  label: string
  description: string
  Icon: React.ComponentType<{ className?: string }>
  group: FormGroup
}

const TYPE_CONFIG: TypeConfig[] = [
  { type: 'BUY',               label: 'Buy',        description: 'Purchase shares',        Icon: TrendingUp,     group: 'trade'    },
  { type: 'SELL',              label: 'Sell',       description: 'Sell shares',             Icon: TrendingDown,   group: 'trade'    },
  { type: 'TACTICAL_ROTATION', label: 'Rotation',   description: 'Sell one, buy another',  Icon: ArrowLeftRight, group: 'rotation' },
  { type: 'DRAWDOWN_DEPLOY',   label: 'Deploy',     description: 'Drawdown deployment',    Icon: ShieldAlert,    group: 'trade'    },
  { type: 'DIVIDEND_REINVEST', label: 'Dividend',   description: 'Reinvest dividend',      Icon: Coins,          group: 'trade'    },
  { type: 'CASH_DEPOSIT',      label: 'Deposit',    description: 'Add cash to brokerage',  Icon: PiggyBank,      group: 'cash'     },
  { type: 'CASH_WITHDRAWAL',   label: 'Withdraw',   description: 'Remove cash',             Icon: Wallet,         group: 'cash'     },
  { type: 'FX_EXCHANGE',       label: 'FX',         description: 'Convert TWD ↔ USD',       Icon: ArrowRightLeft, group: 'fx'       },
]

// ─── Props ────────────────────────────────────────────────────────────────────

interface OperationLoggerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  portfolioId: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a Date as a datetime-local input value (YYYY-MM-DDThh:mm). */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function groupBySleeve(holdings: Holding[], sleeves: Sleeve[]) {
  const sleeveMap = new Map(sleeves.map(s => [s.id, s]))
  const groups = new Map<string, { sleeve: Sleeve; holdings: Holding[] }>()
  for (const h of holdings) {
    const sleeve = sleeveMap.get(h.sleeveId)
    if (!sleeve) continue
    if (!groups.has(h.sleeveId)) groups.set(h.sleeveId, { sleeve, holdings: [] })
    groups.get(h.sleeveId)!.holdings.push(h)
  }
  return [...groups.values()].sort((a, b) => a.sleeve.name.localeCompare(b.sleeve.name))
}

function fmtCurrency(amount: number, currency: 'TWD' | 'USD') {
  return currency === 'TWD'
    ? `TWD ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `USD ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ─── Holding selector (reused in trade & rotation forms) ──────────────────────

function HoldingSelect({
  id, value, onValueChange, grouped, legacyHoldings, placeholder,
}: {
  id: string
  value: string
  onValueChange: (v: string) => void
  grouped: ReturnType<typeof groupBySleeve>
  legacyHoldings: Holding[]
  placeholder: string
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {grouped.map(({ sleeve, holdings }) => (
          <SelectGroup key={sleeve.id}>
            <SelectLabel>{sleeve.name}</SelectLabel>
            {holdings.map(h => (
              <SelectItem key={h.id} value={h.id}>
                {h.ticker} — {h.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {legacyHoldings.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-amber-600 dark:text-amber-400">Legacy</SelectLabel>
            {legacyHoldings.map(h => (
              <SelectItem key={h.id} value={h.id} className="text-muted-foreground">
                {h.ticker} — {h.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OperationLogger({ open, onOpenChange, portfolioId }: OperationLoggerProps) {

  // ── Navigation ──────────────────────────────────────────────────────────────
  const [selectedType, setSelectedType] = useState<LoggableType | null>(null)

  // ── Live data ────────────────────────────────────────────────────────────────
  const allHoldings   = useHoldings(portfolioId)
  const holdings      = useMemo(() => allHoldings.filter(h => h.status === 'active'), [allHoldings])
  const legacyHoldings= useMemo(() => allHoldings.filter(h => h.status === 'legacy'), [allHoldings])
  const sleeves       = useSleeves(portfolioId)
  const accounts      = useCashAccounts(portfolioId)

  const prevTags = useLiveQuery(async () => {
    const ops = await db.operations.where('portfolioId').equals(portfolioId).toArray()
    const tags = ops.map(o => o.tag).filter((t): t is string => Boolean(t))
    return [...new Set(tags)]
  }, [portfolioId], []) as string[]

  // ── Trade form state ─────────────────────────────────────────────────────────
  const [holdingId, setHoldingId]         = useState('')
  const [shares, setShares]               = useState('')
  const [price, setPrice]                 = useState('')
  const [fees, setFees]                   = useState('0')
  const [rationale, setRationale]         = useState('')
  const [tag, setTag]                     = useState('')

  // ── Rotation form state ──────────────────────────────────────────────────────
  const [sellHoldingId, setSellHoldingId] = useState('')
  const [sellShares, setSellShares]       = useState('')
  const [sellPrice, setSellPrice]         = useState('')
  const [sellFees, setSellFees]           = useState('0')
  const [buyHoldingId, setBuyHoldingId]   = useState('')
  const [buyShares, setBuyShares]         = useState('')
  const [buyPrice, setBuyPrice]           = useState('')
  const [buyFees, setBuyFees]             = useState('0')
  const [rotRationale, setRotRationale]   = useState('')
  const [rotTag, setRotTag]               = useState('')

  // ── Cash form state ──────────────────────────────────────────────────────────
  const [cashCurrency, setCashCurrency]   = useState<'TWD' | 'USD'>('TWD')
  const [cashAmount, setCashAmount]       = useState('')
  const [cashNote, setCashNote]           = useState('')

  // ── FX form state ────────────────────────────────────────────────────────────
  const [fxFrom, setFxFrom]               = useState('')
  const [fxTo, setFxTo]                   = useState('')
  const [fxRate, setFxRate]               = useState('')
  const [fxFees, setFxFees]               = useState('0')
  const [fxNote, setFxNote]               = useState('')

  // ── Operation datetime (user-selectable, defaults to now) ───────────────────
  const [opDatetime, setOpDatetime]       = useState(() => toDatetimeLocal(new Date()))

  // Reset datetime to "now" each time the dialog opens
  useEffect(() => {
    if (open) setOpDatetime(toDatetimeLocal(new Date()))
  }, [open])

  // ── Status ───────────────────────────────────────────────────────────────────
  const [saving, setSaving]               = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [successMsg, setSuccessMsg]       = useState<string | null>(null)

  // ── Derived: trade form ──────────────────────────────────────────────────────
  const allHoldingMap = useMemo(() => new Map([...holdings, ...legacyHoldings].map(h => [h.id, h])), [holdings, legacyHoldings])
  const grouped       = useMemo(() => groupBySleeve(holdings, sleeves), [holdings, sleeves])

  // Auto-fill price from cache when a holding is selected
  const handleHoldingSelect = useCallback(async (id: string) => {
    setHoldingId(id)
    const h = allHoldingMap.get(id)
    if (!h) return
    const cached = await getLatestCachedPrice(h.ticker)
    if (cached !== null) setPrice(cached.toFixed(2))
  }, [allHoldingMap])

  const handleSellHoldingSelect = useCallback(async (id: string) => {
    setSellHoldingId(id)
    const h = allHoldingMap.get(id)
    if (!h) return
    const cached = await getLatestCachedPrice(h.ticker)
    if (cached !== null) setSellPrice(cached.toFixed(2))
  }, [allHoldingMap])

  const handleBuyHoldingSelect = useCallback(async (id: string) => {
    setBuyHoldingId(id)
    const h = allHoldingMap.get(id)
    if (!h) return
    const cached = await getLatestCachedPrice(h.ticker)
    if (cached !== null) setBuyPrice(cached.toFixed(2))
  }, [allHoldingMap])

  const selectedHolding  = allHoldingMap.get(holdingId)
  const holdingCurrency  = selectedHolding?.currency ?? 'USD'
  const parsedShares     = parseFloat(shares) || 0
  const parsedPrice      = parseFloat(price) || 0
  const parsedFees       = parseFloat(fees) || 0
  const subtotal         = parsedShares * parsedPrice + parsedFees
  const cashBalance      = accounts.find(a => a.currency === holdingCurrency)?.balance ?? 0
  const isBuy            = selectedType !== 'SELL'
  const insufficientCash = isBuy && subtotal > 0 && subtotal > cashBalance

  // ── Derived: rotation form ───────────────────────────────────────────────────
  const sellH        = allHoldingMap.get(sellHoldingId)
  const buyH         = allHoldingMap.get(buyHoldingId)
  const rotSellNet   = (parseFloat(sellShares)||0) * (parseFloat(sellPrice)||0) - (parseFloat(sellFees)||0)
  const rotBuyCost   = (parseFloat(buyShares)||0)  * (parseFloat(buyPrice)||0)  + (parseFloat(buyFees)||0)
  const rotNetCash   = rotSellNet - rotBuyCost
  const rotCurrency  = sellH?.currency ?? buyH?.currency ?? 'USD'

  // ── FX auto-rate calculation ─────────────────────────────────────────────────
  function handleFxFrom(val: string) {
    setFxFrom(val)
    const f = parseFloat(val)
    const t = parseFloat(fxTo)
    if (f > 0 && t > 0) setFxRate((f / t).toFixed(4))
  }
  function handleFxTo(val: string) {
    setFxTo(val)
    const f = parseFloat(fxFrom)
    const t = parseFloat(val)
    if (f > 0 && t > 0) setFxRate((f / t).toFixed(4))
  }

  // ── Reset all state ──────────────────────────────────────────────────────────
  function resetAll() {
    setSelectedType(null)
    setOpDatetime(toDatetimeLocal(new Date()))
    setHoldingId(''); setShares(''); setPrice(''); setFees('0')
    setRationale(''); setTag('')
    setSellHoldingId(''); setSellShares(''); setSellPrice(''); setSellFees('0')
    setBuyHoldingId('');  setBuyShares('');  setBuyPrice('');  setBuyFees('0')
    setRotRationale(''); setRotTag('')
    setCashCurrency('TWD'); setCashAmount(''); setCashNote('')
    setFxFrom(''); setFxTo(''); setFxRate(''); setFxFees('0'); setFxNote('')
    setError(null); setSuccessMsg(null)
  }

  function handleClose() { resetAll(); onOpenChange(false) }

  function onSuccess(msg: string) {
    setSuccessMsg(msg)
    setSaving(false)
    setTimeout(handleClose, 1500)
  }

  function onError(err: unknown) {
    setSaving(false)
    if (err instanceof InsufficientCashError) {
      setError(`Insufficient ${err.currency} — short by ${err.shortfall.toFixed(2)}.`)
    } else if (err instanceof InsufficientFxLotsError) {
      setError(`Not enough USD FX lots — short by ${err.shortfall.toFixed(2)}.`)
    } else if (err instanceof InsufficientSharesError) {
      setError(`Not enough shares — short by ${err.shortfall.toFixed(6)}.`)
    } else {
      setError('Something went wrong. Please try again.')
    }
  }

  // ── Timestamp validation ────────────────────────────────────────────────────
  function getTimestamp(): Date | null {
    if (!opDatetime) return new Date()
    const d = new Date(opDatetime)
    if (isNaN(d.getTime())) { setError('Invalid date/time.'); return null }
    if (d > new Date()) { setError('Date cannot be in the future.'); return null }
    return d
  }

  // ── Submit: trade ────────────────────────────────────────────────────────────
  async function submitTrade() {
    if (!selectedType || !holdingId)       { setError('Select a holding.'); return }
    if (!parsedShares || parsedShares <= 0) { setError('Enter a valid share count.'); return }
    if (!parsedPrice  || parsedPrice  <= 0) { setError('Enter a valid price per share.'); return }
    if (rationale.trim().length < 10)       { setError('Rationale must be at least 10 characters.'); return }
    const timestamp = getTimestamp(); if (!timestamp) return
    setSaving(true); setError(null)
    try {
      const { autoArchived } = await createTradeOperation(portfolioId, {
        type: selectedType as OperationType,
        entries: [{
          holdingId,
          side: selectedType === 'SELL' ? 'SELL' : 'BUY',
          shares: parsedShares,
          pricePerShare: parsedPrice,
          fees: parsedFees,
        }],
        rationale: rationale.trim(),
        tag: tag.trim() || undefined,
        timestamp,
      })
      if (autoArchived.length > 0) {
        const ev = autoArchived[0]
        const msg = ev.wasActive
          ? `${ev.ticker} archived — redistribute its ${ev.freedAllocationPct.toFixed(1)}% target in Settings.`
          : `${ev.ticker} archived (0 shares remaining).`
        onSuccess(msg)
      } else {
        onSuccess('Operation logged.')
      }
    } catch (err) { onError(err) }
  }

  // ── Submit: rotation ─────────────────────────────────────────────────────────
  async function submitRotation() {
    if (!sellH || !buyH)                     { setError('Select both sell and buy holdings.'); return }
    const pSellShares = parseFloat(sellShares)
    const pSellPrice  = parseFloat(sellPrice)
    const pBuyShares  = parseFloat(buyShares)
    const pBuyPrice   = parseFloat(buyPrice)
    if (!pSellShares || !pSellPrice)         { setError('Fill in the sell side.'); return }
    if (!pBuyShares  || !pBuyPrice)          { setError('Fill in the buy side.'); return }
    if (rotRationale.trim().length < 10)     { setError('Rationale must be at least 10 characters.'); return }
    const timestamp = getTimestamp(); if (!timestamp) return
    setSaving(true); setError(null)
    try {
      const { autoArchived } = await createTacticalRotation(portfolioId, {
        sell: { holdingId: sellHoldingId, side: 'SELL', shares: pSellShares, pricePerShare: pSellPrice, fees: parseFloat(sellFees)||0 },
        buy:  { holdingId: buyHoldingId,  side: 'BUY',  shares: pBuyShares,  pricePerShare: pBuyPrice,  fees: parseFloat(buyFees)||0  },
        rationale: rotRationale.trim(),
        tag: rotTag.trim() || undefined,
        timestamp,
      })
      if (autoArchived.length > 0) {
        const ev = autoArchived[0]
        const msg = ev.wasActive
          ? `${ev.ticker} archived — redistribute its ${ev.freedAllocationPct.toFixed(1)}% target in Settings.`
          : `${ev.ticker} archived (0 shares remaining).`
        onSuccess(msg)
      } else {
        onSuccess('Rotation logged.')
      }
    } catch (err) { onError(err) }
  }

  // ── Submit: cash ─────────────────────────────────────────────────────────────
  async function submitCash() {
    const parsed = parseFloat(cashAmount)
    if (!parsed || parsed <= 0) { setError('Enter a valid positive amount.'); return }
    const timestamp = getTimestamp(); if (!timestamp) return
    setSaving(true); setError(null)
    try {
      if (selectedType === 'CASH_DEPOSIT') {
        await recordCashDeposit(portfolioId, cashCurrency, parsed, cashNote || undefined, timestamp)
        onSuccess('Deposit logged.')
      } else {
        await recordCashWithdrawal(portfolioId, cashCurrency, parsed, cashNote || undefined, timestamp)
        onSuccess('Withdrawal logged.')
      }
    } catch (err) { onError(err) }
  }

  // ── Submit: FX ───────────────────────────────────────────────────────────────
  async function submitFx() {
    const parsedFrom = parseFloat(fxFrom)
    const parsedTo   = parseFloat(fxTo)
    const parsedRate = parseFloat(fxRate)
    if (!parsedFrom || parsedFrom <= 0) { setError('Enter the TWD amount.'); return }
    if (!parsedTo   || parsedTo   <= 0) { setError('Enter the USD amount.'); return }
    if (!parsedRate || parsedRate <= 0) { setError('Enter the exchange rate.'); return }
    const timestamp = getTimestamp(); if (!timestamp) return
    setSaving(true); setError(null)
    try {
      await recordFxExchange(portfolioId, {
        fromCurrency: 'TWD', fromAmount: parsedFrom,
        toCurrency: 'USD',   toAmount: parsedTo,
        rate: parsedRate, fees: parseFloat(fxFees)||0, feesCurrency: 'TWD',
        note: fxNote || undefined,
      }, timestamp)
      onSuccess(`FX lot created: USD ${parsedTo.toFixed(2)} @ ${parsedRate}`)
    } catch (err) { onError(err) }
  }

  // ── Which submit to call ─────────────────────────────────────────────────────
  const config    = TYPE_CONFIG.find(c => c.type === selectedType)
  const submitFns: Record<FormGroup, () => Promise<void>> = {
    trade:    submitTrade,
    rotation: submitRotation,
    cash:     submitCash,
    fx:       submitFx,
  }
  const submitLabel: Record<FormGroup, string> = {
    trade:    `Log ${config?.label ?? 'Operation'}`,
    rotation: 'Log Rotation',
    cash:     selectedType === 'CASH_DEPOSIT' ? 'Log Deposit' : 'Log Withdrawal',
    fx:       'Log FX Exchange',
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <DialogPrimitive.Root open={open} onOpenChange={v => { if (!v) handleClose() }}>
      <DialogPrimitive.Portal>
        {/* Backdrop */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />

        {/* Full-screen panel */}
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col bg-background overflow-hidden focus:outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">
            {config?.label ?? 'Log Operation'}
          </DialogPrimitive.Title>

          {/* ── Header ──────────────────────────────────────────────────────── */}
          <div className="shrink-0 flex items-center gap-2 px-4 py-4 border-b">
            {selectedType && !successMsg && (
              <Button
                variant="ghost" size="icon" className="h-8 w-8 shrink-0 -ml-1"
                onClick={() => { setSelectedType(null); setError(null) }}
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Back</span>
              </Button>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold leading-none">
                {selectedType ? (config?.label ?? 'Log Operation') : 'Log Operation'}
              </h2>
              {selectedType && config && (
                <p className="text-xs text-muted-foreground mt-0.5">{config.description}</p>
              )}
            </div>
            <Button
              variant="ghost" size="icon" className="h-8 w-8 shrink-0"
              onClick={handleClose}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          </div>

          {/* ── Body ────────────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto">

            {/* ── Success screen ──────────────────────────────────────────── */}
            {successMsg && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
                <div className="h-14 w-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <CheckCircle2 className="h-7 w-7 text-green-600 dark:text-green-400" />
                </div>
                <p className="font-medium text-green-700 dark:text-green-400">{successMsg}</p>
              </div>
            )}

            {/* ── Type selector ────────────────────────────────────────────── */}
            {!selectedType && !successMsg && (
              <div className="p-4 grid grid-cols-2 gap-3">
                {TYPE_CONFIG.map(({ type, label, description, Icon }) => (
                  <button
                    key={type}
                    onClick={() => { setSelectedType(type); setError(null) }}
                    className="flex flex-col gap-2 p-4 rounded-xl border bg-card text-left hover:bg-accent hover:border-accent transition-colors"
                  >
                    <Icon className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium leading-none">{label}</p>
                      <p className="text-xs text-muted-foreground mt-1 leading-snug">{description}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* ── Operation date/time (shown for all form types) ──────────── */}
            {selectedType && !successMsg && (
              <div className="px-4 pt-4 pb-0 space-y-1.5">
                <Label htmlFor="op-datetime">Operation Date &amp; Time</Label>
                <input
                  id="op-datetime"
                  type="datetime-local"
                  title="Operation date and time"
                  max={toDatetimeLocal(new Date())}
                  value={opDatetime}
                  onChange={e => { setOpDatetime(e.target.value); setError(null) }}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="text-xs text-muted-foreground">Back-date to the actual execution date. Cannot be in the future.</p>
              </div>
            )}

            {/* ── Trade form (BUY / SELL / DRAWDOWN_DEPLOY / DIVIDEND_REINVEST) */}
            {!successMsg && config?.group === 'trade' && (
              <div className="p-4 space-y-4 pb-6">

                {/* Holding */}
                <div className="space-y-1.5">
                  <Label htmlFor="op-holding">Holding</Label>
                  <HoldingSelect
                    id="op-holding"
                    value={holdingId}
                    onValueChange={(id) => void handleHoldingSelect(id)}
                    grouped={grouped}
                    legacyHoldings={legacyHoldings}
                    placeholder="Select a holding…"
                  />
                </div>

                {/* Shares + Price */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="op-shares">Shares</Label>
                    <Input
                      id="op-shares"
                      type="number" min="0" step="0.000001" placeholder="0.000000"
                      value={shares} onChange={e => setShares(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="op-price">Price / share</Label>
                    <Input
                      id="op-price"
                      type="number" min="0" step="0.01" placeholder="0.00"
                      value={price} onChange={e => setPrice(e.target.value)}
                    />
                  </div>
                </div>

                {/* Fees + Currency */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="op-fees">Fees</Label>
                    <Input
                      id="op-fees"
                      type="number" min="0" step="0.01" placeholder="0.00"
                      value={fees} onChange={e => setFees(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Currency</Label>
                    <div className="h-10 flex items-center px-3 rounded-md border bg-muted text-sm text-muted-foreground">
                      {selectedHolding ? holdingCurrency : '—'}
                    </div>
                  </div>
                </div>

                {/* Subtotal + cash indicator */}
                {selectedHolding && subtotal > 0 && (
                  <div className={`rounded-lg p-3 text-sm ${insufficientCash ? 'bg-destructive/10 border border-destructive/30' : 'bg-muted'}`}>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span className="font-medium tabular-nums">{fmtCurrency(subtotal, holdingCurrency)}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-muted-foreground">Available {holdingCurrency}</span>
                      <span className={`tabular-nums ${insufficientCash ? 'text-destructive font-medium' : ''}`}>
                        {fmtCurrency(cashBalance, holdingCurrency)}
                      </span>
                    </div>
                    {insufficientCash && (
                      <p className="text-destructive text-xs mt-1.5">
                        Short by {fmtCurrency(subtotal - cashBalance, holdingCurrency)} — add cash before trading.
                      </p>
                    )}
                  </div>
                )}

                {/* Rationale */}
                <div className="space-y-1.5">
                  <Label htmlFor="op-rationale">
                    Rationale <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="op-rationale"
                    placeholder="Why are you making this trade? (min 10 characters)"
                    value={rationale}
                    onChange={e => setRationale(e.target.value)}
                    rows={3}
                  />
                  {rationale.length > 0 && rationale.length < 10 && (
                    <p className="text-xs text-muted-foreground">{rationale.length} / 10 min</p>
                  )}
                </div>

                {/* Tag */}
                <div className="space-y-1.5">
                  <Label htmlFor="op-tag">Tag (optional)</Label>
                  <Input
                    id="op-tag"
                    list="op-tag-suggestions"
                    placeholder="e.g. monthly-dca, rebalance-q1"
                    value={tag}
                    onChange={e => setTag(e.target.value)}
                  />
                  <datalist id="op-tag-suggestions">
                    {prevTags.map(t => <option key={t} value={t} />)}
                  </datalist>
                </div>
              </div>
            )}

            {/* ── Tactical Rotation form ───────────────────────────────────── */}
            {!successMsg && config?.group === 'rotation' && (
              <div className="p-4 space-y-4 pb-6">

                {/* Sell side */}
                <div className="space-y-3">
                  <p className="text-sm font-medium text-destructive">Sell</p>
                  <div className="space-y-1.5">
                    <Label>Holding to sell</Label>
                    <HoldingSelect
                      id="rot-sell-holding"
                      value={sellHoldingId}
                      onValueChange={(id) => void handleSellHoldingSelect(id)}
                      grouped={grouped}
                      legacyHoldings={legacyHoldings}
                      placeholder="Select holding…"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="rot-sell-shares">Shares</Label>
                      <Input id="rot-sell-shares" type="number" min="0" step="0.000001" placeholder="0" value={sellShares} onChange={e => setSellShares(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rot-sell-price">Price</Label>
                      <Input id="rot-sell-price" type="number" min="0" step="0.01" placeholder="0.00" value={sellPrice} onChange={e => setSellPrice(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rot-sell-fees">Fees</Label>
                      <Input id="rot-sell-fees" type="number" min="0" step="0.01" placeholder="0" value={sellFees} onChange={e => setSellFees(e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* Net cash divider */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-border" />
                  {(sellH || buyH) && (rotSellNet > 0 || rotBuyCost > 0) && (
                    <span className={`text-xs font-medium tabular-nums ${rotNetCash >= 0 ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
                      Net {rotNetCash >= 0 ? '+' : ''}{fmtCurrency(rotNetCash, rotCurrency)}
                    </span>
                  )}
                  <div className="flex-1 h-px bg-border" />
                </div>

                {/* Buy side */}
                <div className="space-y-3">
                  <p className="text-sm font-medium text-primary">Buy</p>
                  <div className="space-y-1.5">
                    <Label>Holding to buy</Label>
                    <HoldingSelect
                      id="rot-buy-holding"
                      value={buyHoldingId}
                      onValueChange={(id) => void handleBuyHoldingSelect(id)}
                      grouped={grouped}
                      legacyHoldings={legacyHoldings}
                      placeholder="Select holding…"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="rot-buy-shares">Shares</Label>
                      <Input id="rot-buy-shares" type="number" min="0" step="0.000001" placeholder="0" value={buyShares} onChange={e => setBuyShares(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rot-buy-price">Price</Label>
                      <Input id="rot-buy-price" type="number" min="0" step="0.01" placeholder="0.00" value={buyPrice} onChange={e => setBuyPrice(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rot-buy-fees">Fees</Label>
                      <Input id="rot-buy-fees" type="number" min="0" step="0.01" placeholder="0" value={buyFees} onChange={e => setBuyFees(e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* Rationale */}
                <div className="space-y-1.5">
                  <Label htmlFor="rot-rationale">
                    Rationale <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="rot-rationale"
                    placeholder="Why are you rotating? (min 10 characters)"
                    value={rotRationale}
                    onChange={e => setRotRationale(e.target.value)}
                    rows={3}
                  />
                  {rotRationale.length > 0 && rotRationale.length < 10 && (
                    <p className="text-xs text-muted-foreground">{rotRationale.length} / 10 min</p>
                  )}
                </div>

                {/* Tag */}
                <div className="space-y-1.5">
                  <Label htmlFor="rot-tag">Tag (optional)</Label>
                  <Input
                    id="rot-tag"
                    list="rot-tag-suggestions"
                    placeholder="e.g. tactical-q1"
                    value={rotTag}
                    onChange={e => setRotTag(e.target.value)}
                  />
                  <datalist id="rot-tag-suggestions">
                    {prevTags.map(t => <option key={t} value={t} />)}
                  </datalist>
                </div>
              </div>
            )}

            {/* ── Cash form ────────────────────────────────────────────────── */}
            {!successMsg && config?.group === 'cash' && (
              <div className="p-4 space-y-4 pb-6">

                <div className="space-y-1.5">
                  <Label>Currency</Label>
                  <RadioGroup
                    value={cashCurrency}
                    onValueChange={v => setCashCurrency(v as 'TWD' | 'USD')}
                    className="flex gap-6"
                  >
                    {(['TWD', 'USD'] as const).map(c => (
                      <div key={c} className="flex items-center gap-2">
                        <RadioGroupItem value={c} id={`cash-cur-${c}`} />
                        <Label htmlFor={`cash-cur-${c}`}>{c}</Label>
                      </div>
                    ))}
                  </RadioGroup>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cash-amount">Amount</Label>
                  <Input
                    id="cash-amount"
                    type="number" min="0" step="0.01" placeholder="0.00"
                    value={cashAmount} onChange={e => setCashAmount(e.target.value)}
                  />
                </div>

                <div className="rounded-lg bg-muted p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Current {cashCurrency} balance
                    </span>
                    <span className="tabular-nums">
                      {fmtCurrency(accounts.find(a => a.currency === cashCurrency)?.balance ?? 0, cashCurrency)}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cash-note">Note (optional)</Label>
                  <Textarea
                    id="cash-note"
                    placeholder="e.g. Monthly salary transfer to brokerage"
                    value={cashNote}
                    onChange={e => setCashNote(e.target.value)}
                    rows={2}
                  />
                </div>
              </div>
            )}

            {/* ── FX Exchange form ─────────────────────────────────────────── */}
            {!successMsg && config?.group === 'fx' && (
              <div className="p-4 space-y-4 pb-6">

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="fx-from">TWD (from)</Label>
                    <Input
                      id="fx-from"
                      type="number" min="0" step="1" placeholder="0"
                      value={fxFrom} onChange={e => handleFxFrom(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fx-to">USD (to)</Label>
                    <Input
                      id="fx-to"
                      type="number" min="0" step="0.01" placeholder="0.00"
                      value={fxTo} onChange={e => handleFxTo(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="fx-rate">Rate (TWD/USD)</Label>
                    <Input
                      id="fx-rate"
                      type="number" min="0" step="0.0001" placeholder="e.g. 31.50"
                      value={fxRate} onChange={e => setFxRate(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Auto-calculated from amounts above.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fx-fees">Fees (TWD)</Label>
                    <Input
                      id="fx-fees"
                      type="number" min="0" step="0.01" placeholder="0"
                      value={fxFees} onChange={e => setFxFees(e.target.value)}
                    />
                  </div>
                </div>

                <div className="rounded-lg bg-muted p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">TWD balance</span>
                    <span className="tabular-nums">
                      {fmtCurrency(accounts.find(a => a.currency === 'TWD')?.balance ?? 0, 'TWD')}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="fx-note">Note (optional)</Label>
                  <Textarea
                    id="fx-note"
                    placeholder="e.g. IBKR monthly DCA conversion"
                    value={fxNote}
                    onChange={e => setFxNote(e.target.value)}
                    rows={2}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── Footer: error + submit ───────────────────────────────────────── */}
          {selectedType && !successMsg && (
            <div className="shrink-0 border-t bg-background px-4 py-4 space-y-3">
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                className="w-full"
                disabled={saving}
                onClick={() => { void submitFns[config!.group]() }}
              >
                {saving ? 'Saving…' : submitLabel[config!.group]}
              </Button>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
