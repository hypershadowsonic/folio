/**
 * holdingLifecycle.ts — holding status transition service.
 *
 * Provides:
 *   checkAndAutoArchive  — called after every SELL; archives if shares reach 0
 *   restoreHolding       — restores archived/legacy holding to active or legacy
 *
 * These functions are intentionally separate from holdingService.ts to keep the
 * lifecycle state machine in one place, distinct from position-tracking helpers.
 */

import { db } from '@/db/database'
import type { HoldingStatus } from '@/types'

// ─── Auto-archive ─────────────────────────────────────────────────────────────

/**
 * Checks whether a holding should be auto-archived after a SELL operation.
 * Archives the holding if:
 *   - status is NOT already 'archived'
 *   - currentShares is 0 (or undefined)
 *
 * Returns true if the holding was archived, false otherwise.
 * Must be called OUTSIDE a Dexie transaction (opens its own).
 */
export async function checkAndAutoArchive(holdingId: string): Promise<{
  archived: boolean
  ticker: string
  wasActive: boolean
  freedAllocationPct: number
}> {
  const holding = await db.holdings.get(holdingId)
  if (!holding) return { archived: false, ticker: '', wasActive: false, freedAllocationPct: 0 }

  const shares = holding.currentShares ?? 0
  if (holding.status === 'archived' || shares > 0) {
    return { archived: false, ticker: holding.ticker, wasActive: false, freedAllocationPct: 0 }
  }

  const wasActive = holding.status === 'active'
  const freedAllocationPct = wasActive ? (holding.targetAllocationPct ?? 0) : 0

  await db.holdings.update(holdingId, {
    status: 'archived',
    targetAllocationPct: 0,
    archivedAt: new Date(),
  })

  return { archived: true, ticker: holding.ticker, wasActive, freedAllocationPct }
}

// ─── Restore ──────────────────────────────────────────────────────────────────

export interface RestoreToActiveParams {
  sleeveId: string
  targetAllocationPct: number
}

/**
 * Restores an archived or legacy holding to 'active' or 'legacy' status.
 *
 * Restoring to 'active' requires a sleeve assignment and target allocation %.
 * Restoring to 'legacy' clears archivedAt and keeps targetAllocationPct = 0.
 *
 * Note: Does NOT validate that active target allocations sum to 100%.
 * The caller (UI) is responsible for showing the "targets don't sum to 100%" warning.
 */
export async function restoreHolding(
  holdingId: string,
  targetStatus: HoldingStatus,
  params?: RestoreToActiveParams,
): Promise<void> {
  const holding = await db.holdings.get(holdingId)
  if (!holding) throw new Error(`Holding ${holdingId} not found`)

  if (targetStatus === 'active') {
    if (!params) throw new Error('restoreHolding: sleeveId + targetAllocationPct required when restoring to active')
    await db.holdings.update(holdingId, {
      status: 'active',
      sleeveId: params.sleeveId,
      targetAllocationPct: params.targetAllocationPct,
      archivedAt: undefined,
    })
  } else {
    // Restoring to legacy: no allocation target, just clear archived state
    await db.holdings.update(holdingId, {
      status: 'legacy',
      targetAllocationPct: 0,
      archivedAt: undefined,
    })
  }
}
