/**
 * notifications.ts — Browser notification helpers.
 *
 * Uses the Web Notifications API. No server-side push or VAPID required.
 * Notifications only fire when the app is open (foreground notifications).
 *
 * Callers:
 *   - requestNotificationPermission() — call once on app start or on user opt-in
 *   - sendDriftAlert(summary) — called by drift monitor when thresholds are exceeded
 */

import type { PortfolioDriftSummary } from '@/engine/drift'

const ICON = '/folio-icon-192.png'

// ─── requestNotificationPermission ───────────────────────────────────────────

/**
 * Requests browser notification permission from the user.
 * Returns true if permission was granted (or was already granted).
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false

  const result = await Notification.requestPermission()
  return result === 'granted'
}

// ─── sendDriftAlert ───────────────────────────────────────────────────────────

/**
 * Fires a browser notification when portfolio drift thresholds are exceeded.
 * No-ops silently if permission is not granted or the API is unavailable.
 */
export async function sendDriftAlert(summary: PortfolioDriftSummary): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return

  const { overallHealth, criticalCount, warningCount } = summary

  if (overallHealth === 'healthy') return

  const title = overallHealth === 'action-needed'
    ? `⚠ Folio: ${criticalCount} holding${criticalCount !== 1 ? 's' : ''} need rebalancing`
    : `Folio: ${warningCount} holding${warningCount !== 1 ? 's' : ''} approaching drift threshold`

  const body = overallHealth === 'action-needed'
    ? `${criticalCount} critical drift${criticalCount !== 1 ? 's' : ''} detected. Open Folio to review.`
    : `${warningCount} holding${warningCount !== 1 ? 's' : ''} nearing drift limit. Monitor or rebalance soon.`

  new Notification(title, { body, icon: ICON })
}
