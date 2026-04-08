import { useState, useEffect } from 'react'
import { BarChart2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { db } from '@/db/database'
import { useBuilds, useBenchmarks, useCompares } from '@/db/buildHooks'
import { BuildCard } from './BuildCard'
import { BuildCreator } from './BuildCreator'
import { BuildDetail } from './BuildDetail'
import { BenchmarkCard } from '../benchmarks/BenchmarkCard'
import { BenchmarkCreator } from '../benchmarks/BenchmarkCreator'
import { BenchmarkDetail } from '../benchmarks/BenchmarkDetail'
import { CompareCard } from '../compares/CompareCard'
import { CompareCreator } from '../compares/CompareCreator'
import { CompareDetail } from '../compares/CompareDetail'
import type { Build, Benchmark, Compare } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type BuildsView =
  | 'list'
  | 'create-build' | 'create-benchmark' | 'create-compare'
  | 'detail-build' | 'detail-benchmark' | 'detail-compare'

type ListItem =
  | { kind: 'build'; data: Build }
  | { kind: 'benchmark'; data: Benchmark }
  | { kind: 'compare'; data: Compare }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mergeAndSort(builds: Build[], benchmarks: Benchmark[], compares: Compare[]): ListItem[] {
  const items: ListItem[] = [
    ...builds.map((data): ListItem => ({ kind: 'build', data })),
    ...benchmarks.map((data): ListItem => ({ kind: 'benchmark', data })),
    ...compares.map((data): ListItem => ({ kind: 'compare', data })),
  ]
  return items.sort((a, b) => {
    if (a.data.isFavorite !== b.data.isFavorite) return a.data.isFavorite ? -1 : 1
    return b.data.createdAt.getTime() - a.data.createdAt.getTime()
  })
}

// ─── Main component ───────────────────────────────────────────────────────────

export function Builds() {
  const [view, setView] = useState<BuildsView>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingBuild, setEditingBuild] = useState<Build | undefined>(undefined)
  const [editingBenchmark, setEditingBenchmark] = useState<Benchmark | undefined>(undefined)
  const [editingCompare, setEditingCompare] = useState<Compare | undefined>(undefined)
  const [addOpen, setAddOpen] = useState(false)

  const builds = useBuilds()
  const benchmarks = useBenchmarks()
  const compares = useCompares()

  const allItems = mergeAndSort(builds, benchmarks, compares)

  const selectedBuild = builds.find((b) => b.id === selectedId)
  const selectedBenchmark = benchmarks.find((b) => b.id === selectedId)
  const selectedCompare = compares.find((c) => c.id === selectedId)

  // Guard: if selected item was deleted while in detail, go back to list
  useEffect(() => {
    if (view === 'detail-build' && selectedId && !selectedBuild) setView('list')
    if (view === 'detail-benchmark' && selectedId && !selectedBenchmark) setView('list')
    if (view === 'detail-compare' && selectedId && !selectedCompare) setView('list')
  }, [view, selectedId, selectedBuild, selectedBenchmark, selectedCompare])

  // ─── Favorite toggle ────────────────────────────────────────────────────────

  async function handleFavoriteToggle(item: ListItem) {
    await db.transaction('rw', db.builds, db.benchmarks, db.compares, async () => {
      await db.builds.filter((b) => b.isFavorite).modify({ isFavorite: false })
      await db.benchmarks.filter((b) => b.isFavorite).modify({ isFavorite: false })
      await db.compares.filter((c) => c.isFavorite).modify({ isFavorite: false })
      if (!item.data.isFavorite) {
        if (item.kind === 'build') await db.builds.update(item.data.id, { isFavorite: true })
        else if (item.kind === 'benchmark') await db.benchmarks.update(item.data.id, { isFavorite: true })
        else await db.compares.update(item.data.id, { isFavorite: true })
      }
    })
  }

  // ─── Routed views ────────────────────────────────────────────────────────────

  if (view === 'create-build') {
    return (
      <BuildCreator
        editBuild={editingBuild}
        onDone={(id) => {
          setSelectedId(id)
          setEditingBuild(undefined)
          setView('detail-build')
        }}
        onCancel={() => {
          setEditingBuild(undefined)
          setView(selectedId && view !== 'create-build' ? 'detail-build' : 'list')
        }}
      />
    )
  }

  if (view === 'create-benchmark') {
    return (
      <BenchmarkCreator
        editBenchmark={editingBenchmark}
        onDone={(id) => {
          setSelectedId(id)
          setEditingBenchmark(undefined)
          setView('detail-benchmark')
        }}
        onCancel={() => {
          setEditingBenchmark(undefined)
          setView(editingBenchmark ? 'detail-benchmark' : 'list')
        }}
      />
    )
  }

  if (view === 'create-compare') {
    return (
      <CompareCreator
        editCompare={editingCompare}
        onDone={(id) => {
          setSelectedId(id)
          setEditingCompare(undefined)
          setView('detail-compare')
        }}
        onCancel={() => {
          setEditingCompare(undefined)
          setView(editingCompare ? 'detail-compare' : 'list')
        }}
      />
    )
  }

  if (view === 'detail-build' && selectedBuild) {
    return (
      <BuildDetail
        build={selectedBuild}
        onBack={() => setView('list')}
        onEdit={() => {
          setEditingBuild(selectedBuild)
          setView('create-build')
        }}
        onDelete={async () => { await db.builds.delete(selectedBuild.id); setSelectedId(null); setView('list') }}
        onDuplicate={async () => {
          const newBuild: Build = {
            ...selectedBuild,
            id: crypto.randomUUID(),
            name: `${selectedBuild.name} - Duplicated`,
            isFavorite: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          await db.builds.add(newBuild)
          setSelectedId(newBuild.id)
        }}
      />
    )
  }

  if (view === 'detail-benchmark' && selectedBenchmark) {
    return (
      <BenchmarkDetail
        benchmark={selectedBenchmark}
        onBack={() => setView('list')}
        onEdit={() => {
          setEditingBenchmark(selectedBenchmark)
          setView('create-benchmark')
        }}
        onDelete={async () => { await db.benchmarks.delete(selectedBenchmark.id); setSelectedId(null); setView('list') }}
      />
    )
  }

  if (view === 'detail-compare' && selectedCompare) {
    return (
      <CompareDetail
        compare={selectedCompare}
        onBack={() => setView('list')}
        onEdit={() => {
          setEditingCompare(selectedCompare)
          setView('create-compare')
        }}
        onDelete={async () => { await db.compares.delete(selectedCompare.id); setSelectedId(null); setView('list') }}
      />
    )
  }

  // ─── List view ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Builds</h1>
          <p className="text-sm text-muted-foreground">Backtests and benchmarks</p>
        </div>
        <div className="relative shrink-0">
          <Button size="sm" onClick={() => setAddOpen(true)}>+ Add</Button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 w-40 rounded-md border bg-background shadow-md py-1">
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors"
                  onClick={() => { setAddOpen(false); setEditingBuild(undefined); setView('create-build') }}
                >
                  + Build
                </button>
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors"
                  onClick={() => { setAddOpen(false); setEditingBenchmark(undefined); setView('create-benchmark') }}
                >
                  + Benchmark
                </button>
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors"
                  onClick={() => { setAddOpen(false); setEditingCompare(undefined); setView('create-compare') }}
                >
                  + Compare
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Empty state */}
      {allItems.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <div className="rounded-full bg-muted p-4">
              <BarChart2 className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Nothing here yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Create a Build to backtest a DCA strategy, or a Benchmark to track a single ticker.
              </p>
            </div>
            <Button size="sm" onClick={() => { setEditingBuild(undefined); setView('create-build') }}>
              Create your first build
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {allItems.map((item) => {
            if (item.kind === 'build') {
              return (
                <BuildCard
                  key={item.data.id}
                  build={item.data}
                  onSelect={() => { setSelectedId(item.data.id); setView('detail-build') }}
                  onFavoriteToggle={() => void handleFavoriteToggle(item)}
                />
              )
            }
            if (item.kind === 'benchmark') {
              return (
                <BenchmarkCard
                  key={item.data.id}
                  benchmark={item.data}
                  onSelect={() => { setSelectedId(item.data.id); setView('detail-benchmark') }}
                  onFavoriteToggle={() => void handleFavoriteToggle(item)}
                />
              )
            }
            return (
              <CompareCard
                key={item.data.id}
                compare={item.data}
                onSelect={() => { setSelectedId(item.data.id); setView('detail-compare') }}
                onFavoriteToggle={() => void handleFavoriteToggle(item)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Builds
