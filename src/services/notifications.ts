/**
 * notifications.ts — PWA push notification stubs (Phase 7).
 *
 * Phase 5: console.log only — no real push.
 * Phase 7: replace with real Service Worker + Web Push API.
 */

import type { PortfolioDriftSummary } from '@/engine/drift'

// ─── requestNotificationPermission ───────────────────────────────────────────

/**
 * Requests browser notification permission from the user.
 * Phase 7 stub — always returns false.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  console.log('[notifications] requestNotificationPermission — stub (Phase 7 implements real push)')
  return false
}

// ─── sendDriftAlert ───────────────────────────────────────────────────────────

/**
 * Sends a push notification alerting the user that drift thresholds are exceeded.
 * Phase 7 stub — logs to console only.
 */
export async function sendDriftAlert(summary: PortfolioDriftSummary): Promise<void> {
  const { overallHealth, criticalCount, warningCount } = summary
  console.log(
    `[notifications] sendDriftAlert: ${overallHealth}`,
    `(${criticalCount} critical, ${warningCount} warning)`,
    '— stub (Phase 7)',
  )
}
