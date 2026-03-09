import { usePortfolioStore } from '@/stores/portfolioStore'
import { OperationHistory } from './OperationHistory'

export default function Operations() {
  const portfolio = usePortfolioStore(s => s.portfolio)
  if (!portfolio) return null
  return <OperationHistory portfolioId={portfolio.id} />
}
