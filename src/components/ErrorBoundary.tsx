/**
 * ErrorBoundary — catches unhandled render errors in any child subtree.
 *
 * Keeps the rest of the app (including bottom nav) alive when one tab crashes.
 * Use one instance per tab so a crash is contained to that tab only.
 */

import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  children: ReactNode
  /** Tab name shown in the fallback UI (e.g. "Performance") */
  tabName?: string
}

interface State {
  hasError: boolean
  error: Error | null
  showDetails: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, showDetails: false }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary] Crash in "${this.props.tabName ?? 'tab'}":`, error, info.componentStack)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, showDetails: false })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const { error, showDetails } = this.state
    const tabName = this.props.tabName ?? 'This tab'

    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center gap-4">
        <div className="rounded-full bg-destructive/10 p-4">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>

        <div className="space-y-1">
          <p className="text-sm font-semibold">{tabName} crashed</p>
          <p className="text-xs text-muted-foreground">
            Something went wrong rendering this tab.
          </p>
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}>
            {showDetails ? 'Hide' : 'Show'} details
          </Button>
          <Button size="sm" onClick={this.handleRetry}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>

        {showDetails && error && (
          <pre className="w-full max-w-sm rounded-md bg-muted px-3 py-2 text-left text-[10px] text-muted-foreground overflow-auto max-h-48 whitespace-pre-wrap break-all">
            {error.message}
            {'\n\n'}
            {error.stack}
          </pre>
        )}
      </div>
    )
  }
}
