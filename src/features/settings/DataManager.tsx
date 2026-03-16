/**
 * DataManager — full JSON export and import for all Folio data.
 *
 * Export: reads all 9 Dexie tables, bundles into a single JSON file download.
 * Import: reads a JSON file, validates structure, clears and restores all tables.
 */

import { useState, useRef } from 'react'
import { Download, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { db } from '@/db/database'
import type { SnapshotRecord } from '@/db/database'
import type {
  Portfolio, Holding, Sleeve, CashAccount,
  FxTransaction, FxLot, Operation, AmmunitionPool,
} from '@/types'

// ─── Export envelope type ─────────────────────────────────────────────────────

interface FolioExport {
  version: 1
  exportedAt: string
  data: {
    portfolios:      Portfolio[]
    holdings:        Holding[]
    sleeves:         Sleeve[]
    cashAccounts:    CashAccount[]
    fxTransactions:  FxTransaction[]
    fxLots:          FxLot[]
    operations:      Operation[]
    ammunitionPools: AmmunitionPool[]
    snapshots:       SnapshotRecord[]
  }
}

const REQUIRED_KEYS: (keyof FolioExport['data'])[] = [
  'portfolios', 'holdings', 'sleeves', 'cashAccounts',
  'fxTransactions', 'fxLots', 'operations', 'ammunitionPools', 'snapshots',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DataManager() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [confirmData, setConfirmData] = useState<FolioExport | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // ── Export ──────────────────────────────────────────────────────────────────

  async function handleExport() {
    setExporting(true)
    setError(null)
    setSuccess(null)
    try {
      const [
        portfolios, holdings, sleeves, cashAccounts,
        fxTransactions, fxLots, operations, ammunitionPools, snapshots,
      ] = await Promise.all([
        db.portfolios.toArray(),
        db.holdings.toArray(),
        db.sleeves.toArray(),
        db.cashAccounts.toArray(),
        db.fxTransactions.toArray(),
        db.fxLots.toArray(),
        db.operations.toArray(),
        db.ammunitionPools.toArray(),
        db.snapshots.toArray(),
      ])

      const payload: FolioExport = {
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          portfolios, holdings, sleeves, cashAccounts,
          fxTransactions, fxLots, operations, ammunitionPools, snapshots,
        },
      }

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const a    = Object.assign(document.createElement('a'), {
        href: url,
        download: `folio-backup-${fmtDate()}.json`,
      })
      a.click()
      URL.revokeObjectURL(url)

      const total = Object.values(payload.data).reduce((s, arr) => s + arr.length, 0)
      setSuccess(`Exported ${total} records across 9 tables.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  // ── Import: file pick ───────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    setSuccess(null)
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as unknown

        if (
          typeof parsed !== 'object' || parsed === null ||
          (parsed as { version?: unknown }).version !== 1 ||
          typeof (parsed as { data?: unknown }).data !== 'object'
        ) {
          setError('Invalid backup file: missing version or data fields.')
          return
        }

        const data = (parsed as FolioExport).data
        const missingKeys = REQUIRED_KEYS.filter(k => !Array.isArray(data[k]))
        if (missingKeys.length > 0) {
          setError(`Invalid backup file: missing tables — ${missingKeys.join(', ')}.`)
          return
        }

        setConfirmData(parsed as FolioExport)
      } catch {
        setError('Failed to parse file. Make sure it is a valid Folio backup JSON.')
      }
    }
    reader.readAsText(file)

    // Reset input so the same file can be re-selected after a cancel
    e.target.value = ''
  }

  // ── Import: confirm and execute ─────────────────────────────────────────────

  async function handleConfirmImport() {
    if (!confirmData) return
    setImporting(true)
    setError(null)
    try {
      const { data } = confirmData

      await db.transaction(
        'rw',
        [
          db.portfolios, db.holdings, db.sleeves, db.cashAccounts,
          db.fxTransactions, db.fxLots, db.operations, db.ammunitionPools, db.snapshots,
        ],
        async () => {
          // Clear in reverse dependency order
          await Promise.all([
            db.snapshots.clear(),
            db.operations.clear(),
            db.fxLots.clear(),
            db.fxTransactions.clear(),
            db.cashAccounts.clear(),
            db.holdings.clear(),
            db.sleeves.clear(),
            db.ammunitionPools.clear(),
            db.portfolios.clear(),
          ])

          // Restore in dependency order
          if (data.portfolios.length)      await db.portfolios.bulkPut(data.portfolios)
          if (data.sleeves.length)         await db.sleeves.bulkPut(data.sleeves)
          if (data.holdings.length)        await db.holdings.bulkPut(data.holdings)
          if (data.cashAccounts.length)    await db.cashAccounts.bulkPut(data.cashAccounts)
          if (data.fxTransactions.length)  await db.fxTransactions.bulkPut(data.fxTransactions)
          if (data.fxLots.length)          await db.fxLots.bulkPut(data.fxLots)
          if (data.operations.length)      await db.operations.bulkPut(data.operations)
          if (data.ammunitionPools.length) await db.ammunitionPools.bulkPut(data.ammunitionPools)
          if (data.snapshots.length)       await db.snapshots.bulkPut(data.snapshots)
        },
      )

      setConfirmData(null)
      // Reload to reinitialise Zustand stores from fresh Dexie state
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
      setImporting(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 pt-2">

      {/* ── Export ──────────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Export Data</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Download all portfolio data as a single JSON file. Includes all holdings, sleeves,
          operations, cash accounts, FX lots, and snapshots.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={handleExport}
          disabled={exporting}
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export Backup'}
        </Button>
      </div>

      {/* ── Import ──────────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Import Data</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Restore from a Folio backup file.{' '}
          <span className="font-medium text-destructive">This will replace ALL current data.</span>
        </p>
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
        >
          <Upload className="h-4 w-4" />
          Select Backup File
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* ── Confirmation dialog ─────────────────────────────────────────────── */}
      {confirmData && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 dark:bg-amber-500/10 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 dark:text-amber-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                Confirm import from {new Date(confirmData.exportedAt).toLocaleDateString()}
              </p>
              <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
                This will replace all existing data. Record counts in backup:
              </p>
              <ul className="text-xs text-muted-foreground space-y-0.5 pl-1">
                {REQUIRED_KEYS.map(k => (
                  <li key={k}>
                    <span className="font-medium">{confirmData.data[k].length}</span>{' '}
                    {k}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={handleConfirmImport}
              disabled={importing}
            >
              {importing ? 'Importing…' : 'Replace & Import'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmData(null)}
              disabled={importing}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Status messages ─────────────────────────────────────────────────── */}
      {success && (
        <div className="flex items-center gap-2 rounded-md bg-card border border-border px-3 py-2.5 text-sm">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="text-emerald-700 dark:text-emerald-400">{success}</span>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

    </div>
  )
}
