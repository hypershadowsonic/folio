import { usePortfolioStore } from '@/stores/portfolioStore'
import { PortfolioSettings } from './PortfolioSettings'

export default function Settings() {
  const portfolio = usePortfolioStore((s) => s.portfolio)

  // App.tsx guarantees portfolio is defined before rendering this tab,
  // but guard here for safety.
  if (!portfolio) return null

  return <PortfolioSettings portfolioId={portfolio.id} />
}
