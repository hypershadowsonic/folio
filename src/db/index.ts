// Canonical exports — import directly from database.ts or hooks.ts for
// tree-shaking, or use this barrel for convenience.
export { db, FolioDB, seedDefaultPortfolio } from './database'
export type { SnapshotRecord } from './database'
export * from './hooks'
export { captureSnapshot } from './snapshotService'
