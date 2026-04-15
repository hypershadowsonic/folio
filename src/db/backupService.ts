import { db } from '@/db/database'
import type { SnapshotRecord } from '@/db/database'
import type {
  AmmunitionPool,
  Benchmark,
  Build,
  CashAccount,
  Compare,
  EntityLink,
  FxLot,
  FxTransaction,
  Holding,
  LabDraft,
  Operation,
  Portfolio,
  Sleeve,
} from '@/types'

export interface FolioBackupV1Data {
  portfolios: Portfolio[]
  holdings: Holding[]
  sleeves: Sleeve[]
  cashAccounts: CashAccount[]
  fxTransactions: FxTransaction[]
  fxLots: FxLot[]
  operations: Operation[]
  ammunitionPools: AmmunitionPool[]
  snapshots: SnapshotRecord[]
}

export interface FolioBackupV2Data extends FolioBackupV1Data {
  builds: Build[]
  benchmarks: Benchmark[]
  compares: Compare[]
  entityLinks: EntityLink[]
  labDraft: LabDraft[]
}

export interface FolioBackupV1 {
  version: 1
  exportedAt: string
  data: FolioBackupV1Data
}

export interface FolioBackupV2 {
  version: 2
  exportedAt: string
  data: FolioBackupV2Data
}

export type FolioBackup = FolioBackupV1 | FolioBackupV2

export const BACKUP_TABLE_KEYS_V1 = [
  'portfolios',
  'holdings',
  'sleeves',
  'cashAccounts',
  'fxTransactions',
  'fxLots',
  'operations',
  'ammunitionPools',
  'snapshots',
] as const

export const BACKUP_TABLE_KEYS_V2 = [
  ...BACKUP_TABLE_KEYS_V1,
  'builds',
  'benchmarks',
  'compares',
  'entityLinks',
  'labDraft',
] as const

type BackupKeyV1 = (typeof BACKUP_TABLE_KEYS_V1)[number]
type BackupKeyV2 = (typeof BACKUP_TABLE_KEYS_V2)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireArrayField<T extends string>(
  data: Record<string, unknown>,
  key: T,
): unknown[] {
  const value = data[key]
  if (!Array.isArray(value)) {
    throw new Error(`Invalid backup file: missing table "${key}".`)
  }
  return value
}

function normalizeV1Data(data: Record<string, unknown>): FolioBackupV2Data {
  return {
    portfolios: requireArrayField(data, 'portfolios') as Portfolio[],
    holdings: requireArrayField(data, 'holdings') as Holding[],
    sleeves: requireArrayField(data, 'sleeves') as Sleeve[],
    cashAccounts: requireArrayField(data, 'cashAccounts') as CashAccount[],
    fxTransactions: requireArrayField(data, 'fxTransactions') as FxTransaction[],
    fxLots: requireArrayField(data, 'fxLots') as FxLot[],
    operations: requireArrayField(data, 'operations') as Operation[],
    ammunitionPools: requireArrayField(data, 'ammunitionPools') as AmmunitionPool[],
    snapshots: requireArrayField(data, 'snapshots') as SnapshotRecord[],
    builds: [],
    benchmarks: [],
    compares: [],
    entityLinks: [],
    labDraft: [],
  }
}

function normalizeV2Data(data: Record<string, unknown>): FolioBackupV2Data {
  return {
    portfolios: requireArrayField(data, 'portfolios') as Portfolio[],
    holdings: requireArrayField(data, 'holdings') as Holding[],
    sleeves: requireArrayField(data, 'sleeves') as Sleeve[],
    cashAccounts: requireArrayField(data, 'cashAccounts') as CashAccount[],
    fxTransactions: requireArrayField(data, 'fxTransactions') as FxTransaction[],
    fxLots: requireArrayField(data, 'fxLots') as FxLot[],
    operations: requireArrayField(data, 'operations') as Operation[],
    ammunitionPools: requireArrayField(data, 'ammunitionPools') as AmmunitionPool[],
    snapshots: requireArrayField(data, 'snapshots') as SnapshotRecord[],
    builds: requireArrayField(data, 'builds') as Build[],
    benchmarks: requireArrayField(data, 'benchmarks') as Benchmark[],
    compares: requireArrayField(data, 'compares') as Compare[],
    entityLinks: requireArrayField(data, 'entityLinks') as EntityLink[],
    labDraft: requireArrayField(data, 'labDraft') as LabDraft[],
  }
}

export function normalizeBackupPayload(raw: unknown): FolioBackupV2 {
  if (!isRecord(raw)) {
    throw new Error('Invalid backup file: expected an object payload.')
  }

  const version = raw['version']
  const exportedAt = raw['exportedAt']
  const data = raw['data']

  if (version !== 1 && version !== 2) {
    throw new Error('Invalid backup file: unsupported backup version.')
  }
  if (typeof exportedAt !== 'string') {
    throw new Error('Invalid backup file: missing exportedAt.')
  }
  if (!isRecord(data)) {
    throw new Error('Invalid backup file: missing data.')
  }

  return {
    version: 2,
    exportedAt,
    data: version === 1 ? normalizeV1Data(data) : normalizeV2Data(data),
  }
}

export function countBackupRecords(data: FolioBackupV2Data): number {
  return BACKUP_TABLE_KEYS_V2.reduce((sum, key) => sum + data[key].length, 0)
}

export async function createBackupPayload(): Promise<FolioBackupV2> {
  const [
    portfolios,
    holdings,
    sleeves,
    cashAccounts,
    fxTransactions,
    fxLots,
    operations,
    ammunitionPools,
    snapshots,
    builds,
    benchmarks,
    compares,
    entityLinks,
    labDraft,
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
    db.builds.toArray(),
    db.benchmarks.toArray(),
    db.compares.toArray(),
    db.entityLinks.toArray(),
    db.labDraft.toArray(),
  ])

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    data: {
      portfolios,
      holdings,
      sleeves,
      cashAccounts,
      fxTransactions,
      fxLots,
      operations,
      ammunitionPools,
      snapshots,
      builds,
      benchmarks,
      compares,
      entityLinks,
      labDraft,
    },
  }
}

async function clearImportedData(): Promise<void> {
  await db.priceCaches.clear()
  await db.labDraft.clear()
  await db.entityLinks.clear()
  await db.compares.clear()
  await db.benchmarks.clear()
  await db.builds.clear()
  await db.snapshots.clear()
  await db.operations.clear()
  await db.fxLots.clear()
  await db.fxTransactions.clear()
  await db.cashAccounts.clear()
  await db.holdings.clear()
  await db.sleeves.clear()
  await db.ammunitionPools.clear()
  await db.portfolios.clear()
}

async function restoreImportedData(data: FolioBackupV2Data): Promise<void> {
  if (data.portfolios.length > 0) await db.portfolios.bulkPut(data.portfolios)
  if (data.sleeves.length > 0) await db.sleeves.bulkPut(data.sleeves)
  if (data.holdings.length > 0) await db.holdings.bulkPut(data.holdings)
  if (data.cashAccounts.length > 0) await db.cashAccounts.bulkPut(data.cashAccounts)
  if (data.fxTransactions.length > 0) await db.fxTransactions.bulkPut(data.fxTransactions)
  if (data.fxLots.length > 0) await db.fxLots.bulkPut(data.fxLots)
  if (data.operations.length > 0) await db.operations.bulkPut(data.operations)
  if (data.ammunitionPools.length > 0) await db.ammunitionPools.bulkPut(data.ammunitionPools)
  if (data.snapshots.length > 0) await db.snapshots.bulkPut(data.snapshots)
  if (data.builds.length > 0) await db.builds.bulkPut(data.builds)
  if (data.benchmarks.length > 0) await db.benchmarks.bulkPut(data.benchmarks)
  if (data.compares.length > 0) await db.compares.bulkPut(data.compares)
  if (data.entityLinks.length > 0) await db.entityLinks.bulkPut(data.entityLinks)
  if (data.labDraft.length > 0) await db.labDraft.bulkPut(data.labDraft)
}

export async function importBackupPayload(raw: unknown): Promise<FolioBackupV2> {
  const normalized = normalizeBackupPayload(raw)

  await db.transaction(
    'rw',
    [
      db.portfolios,
      db.holdings,
      db.sleeves,
      db.cashAccounts,
      db.fxTransactions,
      db.fxLots,
      db.operations,
      db.ammunitionPools,
      db.snapshots,
      db.priceCaches,
      db.builds,
      db.benchmarks,
      db.compares,
      db.entityLinks,
      db.labDraft,
    ],
    async () => {
      await clearImportedData()
      await restoreImportedData(normalized.data)
    },
  )

  return normalized
}

export function getBackupTableLabelCount(): number {
  return BACKUP_TABLE_KEYS_V2.length
}

export function getBackupTableKeys(): readonly BackupKeyV2[] {
  return BACKUP_TABLE_KEYS_V2
}

export function getLegacyBackupTableKeys(): readonly BackupKeyV1[] {
  return BACKUP_TABLE_KEYS_V1
}
