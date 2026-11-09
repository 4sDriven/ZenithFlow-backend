import { and, eq, notInArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  englishAssignments,
  englishEpisodes,
  englishSeries,
  type EnglishAssignment,
  type EnglishEpisode,
} from '../db/schema.js'
import { config } from '../config.js'
import { DEFAULT_SERIES, fetchEpisode, fetchFeed } from './bbc.js'
import { audioFile, ensureCached } from './english-cache.js'
import { transcribeAudio } from './asr.js'
import { alignTurns } from './english-align.js'

export type RefreshResult = { slug: string; added: number; error?: string }

export function toDateStr(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayStr(): string {
  return toDateStr(new Date())
}

export function tomorrowStr(): string {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return toDateStr(date)
}

export async function ensureSeries(): Promise<void> {
  for (const series of DEFAULT_SERIES) {
    await db.insert(englishSeries).values(series).onConflictDoNothing({ target: englishSeries.slug })
  }
}

export async function refreshAllSeries(limit = 40): Promise<RefreshResult[]> {
  await ensureSeries()
  const series = await db.select().from(englishSeries).where(eq(englishSeries.enabled, true))
  const results: RefreshResult[] = []

  for (const s of series) {
    try {
      const items = await fetchFeed(s.feedUrl, limit)
      if (items.length === 0) {
        results.push({ slug: s.slug, added: 0 })
        continue
      }
      const inserted = await db
        .insert(englishEpisodes)
        .values(
          items.map((item) => ({
            seriesId: s.id,
            guid: item.guid,
            title: item.title,
            pageUrl: item.pageUrl,
            thumbnailUrl: item.thumbnailUrl,
            publishedAt: item.publishedAt,
          })),
        )
        .onConflictDoNothing({ target: englishEpisodes.guid })
        .returning({ id: englishEpisodes.id })
      results.push({ slug: s.slug, added: inserted.length })
    } catch {
      results.push({ slug: s.slug, added: 0, error: '抓取失败' })
    }
  }

  return results
}

export async function pickEpisode(userId: number): Promise<EnglishEpisode | null> {
  const used = await db
    .select({ episodeId: englishAssignments.episodeId })
    .from(englishAssignments)
    .where(eq(englishAssignments.userId, userId))

  const usedIds = used.map((u) => u.episodeId)

  const base = () =>
    db
      .select({ episode: englishEpisodes })
      .from(englishEpisodes)
      .innerJoin(englishSeries, eq(englishEpisodes.seriesId, englishSeries.id))

  const conditions = [eq(englishSeries.enabled, true)]
  if (usedIds.length) conditions.push(notInArray(englishEpisodes.id, usedIds))

  const [fresh] = await base()
    .where(and(...conditions))
    .orderBy(sql`random()`)
    .limit(1)

  if (fresh) return fresh.episode

  const [fallback] = await base()
    .where(eq(englishSeries.enabled, true))
    .orderBy(sql`random()`)
    .limit(1)
  return fallback?.episode ?? null
}

export async function ensureContent(episodeId: number): Promise<void> {
  const [row] = await db
    .select({
      id: englishEpisodes.id,
      pageUrl: englishEpisodes.pageUrl,
      audioUrl: englishEpisodes.audioUrl,
      transcript: englishEpisodes.transcript,
    })
    .from(englishEpisodes)
    .where(eq(englishEpisodes.id, episodeId))
    .limit(1)

  if (!row) return
  if (row.audioUrl && row.transcript.length > 0) return

  try {
    const content = await fetchEpisode(row.pageUrl)
    await db
      .update(englishEpisodes)
      .set({
        title: content.title || undefined,
        audioUrl: content.audioUrl,
        thumbnailUrl: content.thumbnailUrl,
        transcript: content.transcript,
        vocabulary: content.vocabulary,
        alignment: [],
        status: content.transcript.length > 0 ? 'ready' : 'failed',
        updatedAt: new Date(),
      })
      .where(eq(englishEpisodes.id, episodeId))

    if (content.audioUrl) {
      void ensureCached(content.audioUrl, audioFile(episodeId)).catch(() => {})
    }
  } catch {
    await db
      .update(englishEpisodes)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(englishEpisodes.id, episodeId))
  }
}

const alignmentInflight = new Map<number, Promise<void>>()

export function ensureAlignment(episodeId: number): Promise<void> {
  const running = alignmentInflight.get(episodeId)
  if (running) return running
  const task = runAlignment(episodeId).finally(() => alignmentInflight.delete(episodeId))
  alignmentInflight.set(episodeId, task)
  return task
}

async function runAlignment(episodeId: number): Promise<void> {
  const [row] = await db
    .select({
      audioUrl: englishEpisodes.audioUrl,
      transcript: englishEpisodes.transcript,
      alignment: englishEpisodes.alignment,
    })
    .from(englishEpisodes)
    .where(eq(englishEpisodes.id, episodeId))
    .limit(1)

  if (!row || !row.audioUrl || row.transcript.length === 0) return
  if (row.alignment.length > 0) return

  await ensureCached(row.audioUrl, audioFile(episodeId))

  const publicBase = config.PUBLIC_BASE_URL.replace(/\/$/, '')
  const words = await transcribeAudio(`${publicBase}/api/english/audio/${episodeId}`)
  if (words.length === 0) return

  const alignment = alignTurns(row.transcript, words)
  await db
    .update(englishEpisodes)
    .set({ alignment, updatedAt: new Date() })
    .where(eq(englishEpisodes.id, episodeId))
}

export async function ensureAssignment(
  userId: number,
  date: string,
): Promise<EnglishAssignment | null> {
  const [existing] = await db
    .select()
    .from(englishAssignments)
    .where(
      and(eq(englishAssignments.userId, userId), eq(englishAssignments.assignedDate, date)),
    )
    .limit(1)

  if (existing) {
    await ensureContent(existing.episodeId)
    void ensureAlignment(existing.episodeId).catch(() => {})
    return existing
  }

  const episode = await pickEpisode(userId)
  if (!episode) return null

  const [created] = await db
    .insert(englishAssignments)
    .values({ userId, episodeId: episode.id, assignedDate: date })
    .onConflictDoNothing()
    .returning()

  let assignment = created
  if (!assignment) {
    ;[assignment] = await db
      .select()
      .from(englishAssignments)
      .where(
        and(eq(englishAssignments.userId, userId), eq(englishAssignments.assignedDate, date)),
      )
      .limit(1)
  }

  if (assignment) {
    await ensureContent(assignment.episodeId)
    void ensureAlignment(assignment.episodeId).catch(() => {})
  }
  return assignment ?? null
}
