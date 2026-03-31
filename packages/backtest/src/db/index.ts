import Dexie, { type Table } from 'dexie'
import type { Build, Benchmark, Compare, PriceCache } from '@/types'

class FolioBuildDB extends Dexie {
  builds!: Table<Build>
  benchmarks!: Table<Benchmark>
  compares!: Table<Compare>
  priceCache!: Table<PriceCache>

  constructor() {
    super('folio-build-db')
    this.version(1).stores({
      builds:     'id, createdAt, isFavorite',
      benchmarks: 'id, ticker, createdAt, isFavorite',
      compares:   'id, createdAt, isFavorite',
      priceCache: 'ticker, fetchedAt',
    })
  }
}

export const db = new FolioBuildDB()
