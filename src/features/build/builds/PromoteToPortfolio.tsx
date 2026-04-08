import { useState } from 'react'
import { ArrowUpRight, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import { db } from '@/db/database'
import { createEntityLink } from '@/db/entityLinkService'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore } from '@/stores/uiStore'
import { useModeStore } from '@/stores/modeStore'
import type { Build, Portfolio, Sleeve, Holding, CashAccount } from '@/types'

interface PromoteToPortfolioProps {
  build: Build
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PromoteToPortfolio({ build }: PromoteToPortfolioProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(build.name)
  const [isPromoting, setIsPromoting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio)
  const setActiveTab = useUIStore((s) => s.setActiveTab)
  const setMode = useModeStore((s) => s.setMode)

  // Reset state when dialog opens
  function handleOpenChange(next: boolean) {
    if (next) {
      setName(build.name)
      setError(null)
    }
    setOpen(next)
  }

  async function handlePromote() {
    setIsPromoting(true)
    setError(null)

    try {
      const portfolioId = crypto.randomUUID()
      const sleeveId = crypto.randomUUID()
      const now = new Date()

      const portfolio: Portfolio = {
        id: portfolioId,
        name: name.trim(),
        baseCurrency: 'TWD',
        supportedCurrencies: ['TWD', 'USD'],
        monthlyDCABudget: build.dcaAmount,
        monthlyDCABudgetCurrency: build.dcaCurrency,
        defaultRebalanceStrategy: build.rebalanceStrategy,
        defaultAllocationMethod: 'proportional-to-drift',
        createdAt: now,
        updatedAt: now,
      }

      const sleeve: Sleeve = {
        id: sleeveId,
        portfolioId,
        name: 'Core',
        targetAllocationPct: 100,
        color: '#6366f1',
      }

      const holdings: Holding[] = build.holdings.map((bh) => ({
        id: crypto.randomUUID(),
        portfolioId,
        ticker: bh.ticker,
        name: bh.name,
        sleeveId,
        targetAllocationPct: bh.targetAllocationPct,
        driftThresholdPct: 2,
        currency: bh.currency,
        status: 'active',
      }))

      const cashAccounts: CashAccount[] = [
        { id: crypto.randomUUID(), portfolioId, currency: 'TWD', balance: 0 },
        { id: crypto.randomUUID(), portfolioId, currency: 'USD', balance: 0 },
      ]

      await db.transaction('rw', [db.portfolios, db.sleeves, db.holdings, db.cashAccounts], async () => {
        await db.portfolios.add(portfolio)
        await db.sleeves.add(sleeve)
        await db.holdings.bulkAdd(holdings)
        await db.cashAccounts.bulkAdd(cashAccounts)
      })

      await createEntityLink({
        sourceBuildId: build.id,
        targetFolioId: portfolioId,
        relationType: 'promoted_from',
      })

      await loadPortfolio()
      setOpen(false)
      setMode('portfolio')
      setActiveTab('dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promotion failed. Please try again.')
    } finally {
      setIsPromoting(false)
    }
  }

  const nameValid = name.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
          Promote
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Promote to Portfolio</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* What transfers */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">What transfers</p>
            <div className="space-y-1">
              {[
                `${build.holdings.length} holdings + target allocations`,
                `${build.rebalanceStrategy} rebalance strategy`,
                `${build.dcaFrequency} DCA · ${build.dcaCurrency} ${build.dcaAmount.toLocaleString()}`,
              ].map((item) => (
                <div key={item} className="flex items-center gap-2 text-sm">
                  <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">What doesn't transfer</p>
            <div className="space-y-1">
              {[
                'Backtest results',
                'Simulated shares / cost basis',
              ].map((item) => (
                <div key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <X className="h-3.5 w-3.5 shrink-0" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            A new Portfolio will be created with empty cash accounts. Configure your Ammo Pool in Settings afterward.
          </p>

          {/* Portfolio name */}
          <div className="space-y-1.5">
            <Label htmlFor="promote-name">Portfolio name</Label>
            <Input
              id="promote-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Portfolio"
              autoFocus
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button variant="outline" disabled={isPromoting}>Cancel</Button>
          </DialogClose>
          <Button onClick={handlePromote} disabled={!nameValid || isPromoting}>
            {isPromoting ? 'Promoting…' : 'Promote to Portfolio'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
