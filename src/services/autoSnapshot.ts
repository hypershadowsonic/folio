/**
 * autoSnapshot.ts — weekly auto-snapshot service.
 *
 * Called once on app open. Silently captures a portfolio snapshot if
 * the most recent one is older than 7 days (or if none exists yet).
 *
 * Not a service worker — just a plain async function called from App.tsx.
 * A proper background service is deferred to Phase 7 (PWA).
 */

import { db } from '@/db/database'
import { captureSnapshot, resolveCurrentFxRate } from '@/db/snapshotService'
import { calculateCurrentAllocations } from '@/engine/rebalance'
import { calculateDriftStatus } from '@/engine/drift'
import { sendDriftAlert } from './notifications'
import type { PortfolioSnapshot } from '@/types'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// ─── captureAndStore ──────────────────────────────────────────────────────────

/**
 * Runs captureSnapshot and persists the result to the `snapshots` table.
 * Returns the captured PortfolioSnapshot.
 */
export async function captureAndStoreSnapshot(portfolioId: string): Promise<PortfolioSnapshot> {
  const snapshot = await captureSnapshot(portfolioId)
  await db.snapshots.put({
    ...snapshot,
    id:          crypto.randomUUID(),
    portfolioId,
  })
  return snapshot
}

// ─── checkAndCaptureWeeklySnapshot ───────────────────────────────────────────

/**
 * Checks whether a weekly snapshot is due and captures one if so.
 *
 * - No snapshots exist   → capture immediately, return it
 * - Most recent > 7 days → capture, return it
 * - Most recent ≤ 7 days → no action, return null
 *
 * Console output:
 *   "Auto-snapshot: captured (YYYY-MM-DD)"
 *   "Auto-snapshot: not due (last: YYYY-MM-DD)"
 */
export async function checkAndCaptureWeeklySnapshot(
  portfolioId: string,
): Promise<PortfolioSnapshot | null> {
  const snaps = await db.snapshots
    .where('portfolioId')
    .equals(portfolioId)
    .sortBy('timestamp')

  const mostRecent = snaps[snaps.length - 1] ?? null

  if (!mostRecent) {
    const snapshot = await captureAndStoreSnapshot(portfolioId)
    console.log(`Auto-snapshot: captured (first) ${new Date(snapshot.timestamp).toISOString().slice(0, 10)}`)
    await checkAndAlertDrift(portfolioId)
    return snapshot
  }

  const ageMs = Date.now() - new Date(mostRecent.timestamp).getTime()

  if (ageMs >= SEVEN_DAYS_MS) {
    const snapshot = await captureAndStoreSnapshot(portfolioId)
    console.log(`Auto-snapshot: captured ${new Date(snapshot.timestamp).toISOString().slice(0, 10)}`)
    await checkAndAlertDrift(portfolioId)
    return snapshot
  }

  console.log(`Auto-snapshot: not due (last: ${new Date(mostRecent.timestamp).toISOString().slice(0, 10)})`)
  return null
}

// ─── checkAndAlertDrift ───────────────────────────────────────────────────────

/**
 * Recalculates drift from live DB state and calls sendDriftAlert if any
 * holdings exceed their threshold. Called after auto-snapshot capture.
 */
async function checkAndAlertDrift(portfolioId: string): Promise<void> {
  const [holdings, sleeves, fxRate] = await Promise.all([
    db.holdings.where('portfolioId').equals(portfolioId).toArray(),
    db.sleeves.where('portfolioId').equals(portfolioId).toArray(),
    resolveCurrentFxRate(portfolioId),
  ])

  const holdingStates = calculateCurrentAllocations(holdings, fxRate)
  const summary       = calculateDriftStatus(holdingStates, holdings, sleeves)

  if (summary.overallHealth === 'action-needed') {
    await sendDriftAlert(summary)
  }
}
