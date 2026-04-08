import { useState, useEffect } from 'react'
import { Moon, Sun, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ApiStatusIndicator } from '@/components/ApiStatus'
import { useUIStore } from '@/stores/uiStore'
import { getCacheStats, clearCache } from '@/services/yahooFinance'
import type { CacheStats } from '@/types'

export function BuildSettings() {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const buildDisplayCurrency = useUIStore((s) => s.buildDisplayCurrency)
  const setBuildDisplayCurrency = useUIStore((s) => s.setBuildDisplayCurrency)
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [clearingCache, setClearingCache] = useState(false)

  useEffect(() => {
    getCacheStats().then(setCacheStats).catch(console.error)
  }, [])

  async function handleClearCache() {
    setClearingCache(true)
    try {
      await clearCache()
      setCacheStats({ tickerCount: 0, totalPricePoints: 0, oldestFetchedAt: null })
    } finally {
      setClearingCache(false)
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">App preferences and data management</p>
      </div>

      {/* Display Currency */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Display Currency</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            {(['USD', 'TWD'] as const).map((c) => (
              <Button
                key={c}
                variant={buildDisplayCurrency === c ? 'default' : 'outline'}
                size="sm"
                onClick={() => setBuildDisplayCurrency(c)}
                className="flex-1"
              >
                {c}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Default currency for new builds and chart displays.
          </p>
        </CardContent>
      </Card>

      {/* Theme */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground capitalize">{theme} mode</p>
            </div>
            <Button variant="outline" size="icon" onClick={toggleTheme}>
              {theme === 'light'
                ? <Moon className="h-4 w-4" />
                : <Sun className="h-4 w-4" />
              }
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Cache Management */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Price Cache</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">API Status</p>
            <ApiStatusIndicator />
          </div>

          <Separator />

          {cacheStats ? (
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cached tickers</span>
                <span className="font-medium">{cacheStats.tickerCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Price data points</span>
                <span className="font-medium">{cacheStats.totalPricePoints.toLocaleString()}</span>
              </div>
              {cacheStats.oldestFetchedAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Oldest fetch</span>
                  <span className="font-medium text-xs">
                    {cacheStats.oldestFetchedAt.toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading cache info…</p>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full text-destructive hover:text-destructive"
            onClick={handleClearCache}
            disabled={clearingCache || cacheStats?.tickerCount === 0}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {clearingCache ? 'Clearing…' : 'Clear Cache'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Prices are cached for 24 hours. Clear to force a fresh fetch on next use.
          </p>
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Folio Build</span>
            <span className="text-muted-foreground">v0.1.0 — Phase 11</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
