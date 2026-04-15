/**
 * DataManager - full JSON export and import for all durable Folio data.
 *
 * Export: bundles all user-authored Dexie tables into a versioned backup file.
 * Import: accepts both legacy v1 backups and current v2 backups.
 */

import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  countBackupRecords,
  createBackupPayload,
  getBackupTableKeys,
  getBackupTableLabelCount,
  importBackupPayload,
  normalizeBackupPayload,
  type FolioBackupV2,
} from '@/db/backupService'

function fmtDate(): string {
  return new Date().toISOString().slice(0, 10)
}

const BACKUP_TABLE_KEYS = getBackupTableKeys()

export function DataManager() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [confirmData, setConfirmData] = useState<FolioBackupV2 | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleExport() {
    setExporting(true)
    setError(null)
    setSuccess(null)

    try {
      const payload = await createBackupPayload()
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = Object.assign(document.createElement('a'), {
        href: url,
        download: `folio-backup-${fmtDate()}.json`,
      })

      anchor.click()
      URL.revokeObjectURL(url)

      setSuccess(
        `Exported ${countBackupRecords(payload.data)} records across ${getBackupTableLabelCount()} tables.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    setSuccess(null)

    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string) as unknown
        setConfirmData(normalizeBackupPayload(parsed))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to parse file.')
      }
    }
    reader.readAsText(file)

    e.target.value = ''
  }

  async function handleConfirmImport() {
    if (!confirmData) return

    setImporting(true)
    setError(null)

    try {
      await importBackupPayload(confirmData)
      setConfirmData(null)
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6 pt-2">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Export Data</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Download all durable Folio data as a single JSON file. Includes portfolio state,
          operations, build-mode data, and settings. Price cache is excluded.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={handleExport}
          disabled={exporting}
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exporting...' : 'Export Backup'}
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Import Data</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Restore from a Folio backup file.{' '}
          <span className="font-medium text-destructive">
            This will replace all current data and clear cached prices.
          </span>
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
                {BACKUP_TABLE_KEYS.map((key) => (
                  <li key={key}>
                    <span className="font-medium">{confirmData.data[key].length}</span>{' '}
                    {key}
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
              {importing ? 'Importing...' : 'Replace & Import'}
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

      {success && (
        <div className="flex items-center gap-2 rounded-md bg-card border border-border px-3 py-2.5 text-sm">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="text-emerald-700 dark:text-emerald-400">{success}</span>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
