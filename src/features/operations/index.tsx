import { useState } from 'react'
import { Plus, Landmark, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { usePortfolioStore } from '@/stores/portfolioStore'
import { useOperations } from '@/db/hooks'
import { OperationCard } from './OperationCard'
import { LogCashDialog } from './LogCashDialog'
import { LogFxDialog } from './LogFxDialog'

type ActionSheet = 'pick' | 'cash' | 'fx' | null

export default function Operations() {
  const portfolio = usePortfolioStore(s => s.portfolio)
  const [sheet, setSheet] = useState<ActionSheet>(null)

  const portfolioId = portfolio?.id
  const operations = useOperations(portfolioId)

  if (!portfolio) return null

  return (
    <div className="relative flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="px-4 pt-5 pb-3">
        <h1 className="text-xl font-semibold">Operations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {operations.length === 0
            ? 'No operations yet.'
            : `${operations.length} operation${operations.length !== 1 ? 's' : ''}`}
        </p>
      </div>

      {/* ── Operation list ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-3">
        {operations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <p className="text-sm">Tap the + button to log your first operation.</p>
          </div>
        ) : (
          operations.map(op => (
            <OperationCard key={op.id} operation={op} />
          ))
        )}
      </div>

      {/* ── Floating action button ──────────────────────────────────────── */}
      <div className="absolute bottom-6 right-4">
        <Button
          size="icon"
          className="h-14 w-14 rounded-full shadow-lg"
          onClick={() => setSheet('pick')}
        >
          <Plus className="h-6 w-6" />
          <span className="sr-only">Log operation</span>
        </Button>
      </div>

      {/* ── Action type picker ──────────────────────────────────────────── */}
      <Dialog open={sheet === 'pick'} onOpenChange={v => !v && setSheet(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Log Operation</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <Button
              variant="outline"
              className="justify-start gap-3 h-12"
              onClick={() => setSheet('cash')}
            >
              <Landmark className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-medium">Cash deposit / withdrawal</div>
                <div className="text-xs text-muted-foreground">Move money in or out of brokerage</div>
              </div>
            </Button>

            <Button
              variant="outline"
              className="justify-start gap-3 h-12"
              onClick={() => setSheet('fx')}
            >
              <ArrowLeftRight className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-medium">FX exchange</div>
                <div className="text-xs text-muted-foreground">Convert TWD ↔ USD</div>
              </div>
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Cash log dialog ─────────────────────────────────────────────── */}
      <LogCashDialog
        open={sheet === 'cash'}
        onOpenChange={v => setSheet(v ? 'cash' : null)}
        portfolioId={portfolio.id}
      />

      {/* ── FX exchange dialog ──────────────────────────────────────────── */}
      <LogFxDialog
        open={sheet === 'fx'}
        onOpenChange={v => setSheet(v ? 'fx' : null)}
        portfolioId={portfolio.id}
      />
    </div>
  )
}
