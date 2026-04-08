import { db } from './database'
import type { EntityLink } from '@/types'

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Creates an EntityLink record and returns its generated id.
 */
export async function createEntityLink(
  link: Omit<EntityLink, 'id' | 'createdAt'>,
): Promise<string> {
  const record: EntityLink = {
    ...link,
    id: crypto.randomUUID(),
    createdAt: new Date(),
  }
  await db.entityLinks.add(record)
  return record.id
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Returns all EntityLinks where the given Build is the source (promoted_from)
 * or the target (forked_from).
 */
export async function getLinksForBuild(buildId: string): Promise<EntityLink[]> {
  const [asSource, asTarget] = await Promise.all([
    db.entityLinks.where('sourceBuildId').equals(buildId).toArray(),
    db.entityLinks.where('targetBuildId').equals(buildId).toArray(),
  ])
  return [...asSource, ...asTarget]
}

/**
 * Returns all EntityLinks where the given Portfolio is the source (forked_from)
 * or the target (promoted_from).
 */
export async function getLinksForPortfolio(portfolioId: string): Promise<EntityLink[]> {
  const [asSource, asTarget] = await Promise.all([
    db.entityLinks.where('sourceFolioId').equals(portfolioId).toArray(),
    db.entityLinks.where('targetFolioId').equals(portfolioId).toArray(),
  ])
  return [...asSource, ...asTarget]
}
