import { usePortfolioStore } from '@/stores/portfolioStore'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PortfolioSettings } from './PortfolioSettings'
import { CashFxManager } from './CashFxManager'

export default function Settings() {
  const portfolio = usePortfolioStore((s) => s.portfolio)

  // App.tsx guarantees portfolio is defined before rendering this tab,
  // but guard here for safety.
  if (!portfolio) return null

  return (
    <div className="px-4 pt-5 pb-8">
      <h1 className="text-xl font-semibold mb-4">Settings</h1>

      <Tabs defaultValue="portfolio">
        <TabsList className="w-full mb-2">
          <TabsTrigger value="portfolio" className="flex-1">Portfolio</TabsTrigger>
          <TabsTrigger value="cash-fx"   className="flex-1">Cash &amp; FX</TabsTrigger>
        </TabsList>

        <TabsContent value="portfolio">
          <PortfolioSettings portfolioId={portfolio.id} />
        </TabsContent>

        <TabsContent value="cash-fx">
          <CashFxManager portfolioId={portfolio.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
