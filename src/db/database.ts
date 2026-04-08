import Dexie, { type Table } from 'dexie'
import type {
  Portfolio,
  Holding,
  Sleeve,
  CashAccount,
  FxTransaction,
  FxLot,
  Operation,
  AmmunitionPool,
  PortfolioSnapshot,
  PriceCache,
  Build,
  Benchmark,
  Compare,
  EntityLink,
} from '@/types'

// PortfolioSnapshot has no id/portfolioId in the domain type (it's always
// embedded in an Operation's snapshotBefore/snapshotAfter). When we store
// stand-alone periodic snapshots we need both for indexing.
export type SnapshotRecord = PortfolioSnapshot & {
  id: string
  portfolioId: string
}

// ─── Database class ───────────────────────────────────────────────────────────

export class FolioDB extends Dexie {
  portfolios!:      Table<Portfolio>
  holdings!:        Table<Holding>
  sleeves!:         Table<Sleeve>
  cashAccounts!:    Table<CashAccount>
  fxTransactions!:  Table<FxTransaction>
  fxLots!:          Table<FxLot>
  operations!:      Table<Operation>
  ammunitionPools!: Table<AmmunitionPool>
  snapshots!:       Table<SnapshotRecord>
  priceCaches!:     Table<PriceCache>
  builds!:          Table<Build>
  benchmarks!:      Table<Benchmark>
  compares!:        Table<Compare>
  entityLinks!:     Table<EntityLink>

  constructor() {
    super('folio-db')

    /**
     * Version 1 — initial schema.
     *
     * Dexie index syntax:
     *   'primaryKey, index1, index2, [compound+index]'
     *
     * Only index fields you actually query/filter/sort on.
     * Non-indexed fields are still fully stored and readable.
     */
    this.version(1).stores({
      // Primary key + query indexes
      portfolios: 'id, createdAt',

      // Query by portfolio; also by sleeve for allocation grouping
      holdings: 'id, portfolioId, sleeveId, ticker',

      // Query by portfolio
      sleeves: 'id, portfolioId',

      // Query by portfolio + currency for per-currency balance lookup
      cashAccounts: 'id, portfolioId, currency, [portfolioId+currency]',

      // Query by portfolio + time; sort by timestamp for history view
      fxTransactions: 'id, portfolioId, timestamp',

      // FIFO ordering: always query by fxTransactionId first, then sort by
      // timestamp ascending to consume oldest lot first
      fxLots: 'id, fxTransactionId, timestamp, [fxTransactionId+timestamp]',

      // Rich query surface for operation log filters
      operations: 'id, portfolioId, timestamp, type, tag, [portfolioId+timestamp], [portfolioId+type]',

      // One record per portfolio (portfolioId IS the primary key)
      ammunitionPools: 'portfolioId',

      // Stand-alone periodic snapshots; query by portfolio + time
      snapshots: 'id, portfolioId, timestamp, [portfolioId+timestamp]',
    })

    /**
     * Version 2 — holding lifecycle (status field).
     *
     * Adds `status` index to holdings table for efficient filtering.
     * Migration sets status = 'active' for all existing holdings.
     *
     * Table schema changes: holdings gains `status` and `[portfolioId+status]` index.
     * All other tables are re-declared unchanged (required by Dexie when any table changes).
     */
    this.version(2).stores({
      portfolios: 'id, createdAt',
      holdings: 'id, portfolioId, sleeveId, ticker, status, [portfolioId+status]',
      sleeves: 'id, portfolioId',
      cashAccounts: 'id, portfolioId, currency, [portfolioId+currency]',
      fxTransactions: 'id, portfolioId, timestamp',
      fxLots: 'id, fxTransactionId, timestamp, [fxTransactionId+timestamp]',
      operations: 'id, portfolioId, timestamp, type, tag, [portfolioId+timestamp], [portfolioId+type]',
      ammunitionPools: 'portfolioId',
      snapshots: 'id, portfolioId, timestamp, [portfolioId+timestamp]',
    }).upgrade(async tx => {
      // Set status = 'active' on all existing holdings that don't have a status yet
      await tx.table('holdings').toCollection().modify((holding: Record<string, unknown>) => {
        if (!holding['status']) {
          holding['status'] = 'active'
        }
      })
    })

    /**
     * Version 3 — price cache table.
     *
     * Adds `priceCaches` for Yahoo Finance price data with 24h TTL.
     * Primary key is `ticker`; `fetchedAt` indexed for expiry queries.
     * No data migration needed — new empty table.
     */
    this.version(3).stores({
      portfolios:      'id, createdAt',
      holdings:        'id, portfolioId, sleeveId, ticker, status, [portfolioId+status]',
      sleeves:         'id, portfolioId',
      cashAccounts:    'id, portfolioId, currency, [portfolioId+currency]',
      fxTransactions:  'id, portfolioId, timestamp',
      fxLots:          'id, fxTransactionId, timestamp, [fxTransactionId+timestamp]',
      operations:      'id, portfolioId, timestamp, type, tag, [portfolioId+timestamp], [portfolioId+type]',
      ammunitionPools: 'portfolioId',
      snapshots:       'id, portfolioId, timestamp, [portfolioId+timestamp]',
      priceCaches:     'ticker, fetchedAt',
    })

    /**
     * Version 4 — Build mode tables.
     *
     * Adds `builds`, `benchmarks`, and `compares` for the Build simulation mode.
     * `isFavorite` is indexed for fast favorites-first sorting.
     * No data upgrade needed — new empty tables.
     */
    this.version(4).stores({
      portfolios:      'id, createdAt',
      holdings:        'id, portfolioId, sleeveId, ticker, status, [portfolioId+status]',
      sleeves:         'id, portfolioId',
      cashAccounts:    'id, portfolioId, currency, [portfolioId+currency]',
      fxTransactions:  'id, portfolioId, timestamp',
      fxLots:          'id, fxTransactionId, timestamp, [fxTransactionId+timestamp]',
      operations:      'id, portfolioId, timestamp, type, tag, [portfolioId+timestamp], [portfolioId+type]',
      ammunitionPools: 'portfolioId',
      snapshots:       'id, portfolioId, timestamp, [portfolioId+timestamp]',
      priceCaches:     'ticker, fetchedAt',
      builds:          'id, createdAt, isFavorite',
      benchmarks:      'id, ticker, createdAt, isFavorite',
      compares:        'id, createdAt, isFavorite',
    })

    /**
     * Version 5 — EntityLink table.
     *
     * Adds `entityLinks` to track lineage between Builds and Portfolios:
     * - `promoted_from`: a Build was promoted to a live Portfolio
     * - `forked_from`: a Portfolio was forked to a Build
     *
     * All four ID fields are indexed to support fast lookups from either side.
     * No data upgrade needed — new empty table.
     */
    this.version(5).stores({
      portfolios:      'id, createdAt',
      holdings:        'id, portfolioId, sleeveId, ticker, status, [portfolioId+status]',
      sleeves:         'id, portfolioId',
      cashAccounts:    'id, portfolioId, currency, [portfolioId+currency]',
      fxTransactions:  'id, portfolioId, timestamp',
      fxLots:          'id, fxTransactionId, timestamp, [fxTransactionId+timestamp]',
      operations:      'id, portfolioId, timestamp, type, tag, [portfolioId+timestamp], [portfolioId+type]',
      ammunitionPools: 'portfolioId',
      snapshots:       'id, portfolioId, timestamp, [portfolioId+timestamp]',
      priceCaches:     'ticker, fetchedAt',
      builds:          'id, createdAt, isFavorite',
      benchmarks:      'id, ticker, createdAt, isFavorite',
      compares:        'id, createdAt, isFavorite',
      entityLinks:     'id, sourceBuildId, sourceFolioId, targetBuildId, targetFolioId',
    })
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const db = new FolioDB()

// ─── Seed ─────────────────────────────────────────────────────────────────────

/**
 * Creates a default empty portfolio with TWD and USD cash accounts if no
 * portfolio exists yet. Safe to call multiple times — exits early if data
 * already present.
 *
 * Returns the id of the (existing or newly created) portfolio.
 */
export async function seedDefaultPortfolio(): Promise<string> {
  const existing = await db.portfolios.toCollection().first()
  if (existing) return existing.id

  const portfolioId = crypto.randomUUID()
  const now = new Date()

  const portfolio: Portfolio = {
    id: portfolioId,
    name: 'My Portfolio',
    baseCurrency: 'TWD',
    supportedCurrencies: ['TWD', 'USD'],
    monthlyDCABudget: 0,
    monthlyDCABudgetCurrency: 'USD',
    defaultRebalanceStrategy: 'soft',
    defaultAllocationMethod: 'proportional-to-drift',
    createdAt: now,
    updatedAt: now,
  }

  const twdAccount: CashAccount = {
    id: crypto.randomUUID(),
    portfolioId,
    currency: 'TWD',
    balance: 0,
  }

  const usdAccount: CashAccount = {
    id: crypto.randomUUID(),
    portfolioId,
    currency: 'USD',
    balance: 0,
  }

  // Single transaction so either everything lands or nothing does
  await db.transaction('rw', [db.portfolios, db.cashAccounts], async () => {
    await db.portfolios.add(portfolio)
    await db.cashAccounts.bulkAdd([twdAccount, usdAccount])
  })

  return portfolioId
}
