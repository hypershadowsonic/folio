import { usePortfolioStore } from '@/stores/portfolioStore'
import { useUIStore } from '@/stores/uiStore'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Sun, Moon } from 'lucide-react'
import { PortfolioSettings } from './PortfolioSettings'
import { CashFxManager } from './CashFxManager'
import { AmmunitionPoolSettings } from './AmmunitionPoolSettings'
import { BenchmarkSettings } from './BenchmarkSettings'
import { DataManager } from './DataManager'

export default function Settings() {
  const portfolio = usePortfolioStore((s) => s.portfolio)
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)

  // App.tsx guarantees portfolio is defined before rendering this tab,
  // but guard here for safety.
  if (!portfolio) return null

  return (
    <div className="px-4 pt-5 pb-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>
      </div>

      <Tabs defaultValue="portfolio">
        <TabsList className="w-full mb-2">
          <TabsTrigger value="portfolio"  className="flex-1 text-xs">Portfolio</TabsTrigger>
          <TabsTrigger value="cash-fx"    className="flex-1 text-xs">Cash &amp; FX</TabsTrigger>
          <TabsTrigger value="ammo"       className="flex-1 text-xs">Ammo Pool</TabsTrigger>
          <TabsTrigger value="benchmark"  className="flex-1 text-xs">Benchmark</TabsTrigger>
          <TabsTrigger value="data"       className="flex-1 text-xs">Data</TabsTrigger>
        </TabsList>

        <TabsContent value="portfolio">
          <PortfolioSettings portfolioId={portfolio.id} />
        </TabsContent>

        <TabsContent value="cash-fx">
          <CashFxManager portfolioId={portfolio.id} />
        </TabsContent>

        <TabsContent value="ammo">
          <AmmunitionPoolSettings portfolioId={portfolio.id} />
        </TabsContent>

        <TabsContent value="benchmark">
          <BenchmarkSettings portfolioId={portfolio.id} />
        </TabsContent>

        <TabsContent value="data">
          <DataManager />
        </TabsContent>
      </Tabs>
    </div>
  )
}
