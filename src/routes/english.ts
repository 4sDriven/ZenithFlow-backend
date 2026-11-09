import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { englishAssignments, englishEpisodes, englishSeries } from '../db/schema.js'
import { audioFile, ensureCached, isCached, thumbFile } from '../lib/english-cache.js'
import {
  ensureAlignment,
  ensureAssignment,
  ensureSeries,
  refreshAllSeries,
  todayStr,
} from '../lib/english-service.js'

const seriesSelect = {
  id: englishEpisodes.id,
  seriesSlug: englishSeries.slug,
  seriesName: englishSeries.name,
  title: englishEpisodes.title,
  pageUrl: englishEpisodes.pageUrl,
  audioUrl: englishEpisodes.audioUrl,
  thumbnailUrl: englishEpisodes.thumbnailUrl,
  publishedAt: englishEpisodes.publishedAt,
  transcript: englishEpisodes.transcript,
  vocabulary: englishEpisodes.vocabulary,
  alignment: englishEpisodes.alignment,
}

function toEpisode(row: {
  id: number
  seriesSlug: string
  seriesName: string
  title: string
  pageUrl: string
  audioUrl: string | null
  thumbnailUrl: string | null
  publishedAt: Date | null
  transcript: { speaker: string; text: string }[]
  vocabulary: { word: string; meaning: string }[]
  alignment: number[]
}) {
  return {
    id: row.id,
    seriesSlug: row.seriesSlug,
    seriesName: row.seriesName,
    title: row.title,
    pageUrl: row.pageUrl,
    audioUrl: row.audioUrl,
    thumbnailUrl: row.thumbnailUrl,
    publishedAt: row.publishedAt,
    transcript: row.transcript,
    vocabulary: row.vocabulary,
    alignment: row.alignment,
  }
}

async function loadEpisode(episodeId: number) {
  const [row] = await db
    .select(seriesSelect)
    .from(englishEpisodes)
    .innerJoin(englishSeries, eq(englishEpisodes.seriesId, englishSeries.id))
    .where(eq(englishEpisodes.id, episodeId))
    .limit(1)
  return row ?? null
}

export async function englishRoutes(app: FastifyInstance) {
  await ensureSeries()

  app.get('/english/series', { preHandler: [app.requireAdmin] }, async () => {
    await ensureSeries()
    const list = await db.select().from(englishSeries).orderBy(englishSeries.id)
    const counts = await db
      .select({ seriesId: englishEpisodes.seriesId, count: sql<number>`count(*)::int` })
      .from(englishEpisodes)
      .groupBy(englishEpisodes.seriesId)
    const map = new Map(counts.map((c) => [c.seriesId, c.count]))
    return {
      ok: true,
      series: list.map((s) => ({ ...s, episodeCount: map.get(s.id) ?? 0 })),
    }
  })

  app.post('/english/refresh', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(40) })
      .safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '参数不合法' })

    const results = await refreshAllSeries(parsed.data.limit)
    return { ok: true, results }
  })

  app.get('/english/today', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const date = todayStr()
    const assignment = await ensureAssignment(request.user.sub, date)
    if (!assignment) {
      return reply.code(404).send({ ok: false, error: '素材池为空，请先刷新素材' })
    }

    const episode = await loadEpisode(assignment.episodeId)
    if (!episode) return reply.code(404).send({ ok: false, error: '素材不存在' })

    return {
      ok: true,
      date,
      assignment: {
        id: assignment.id,
        status: assignment.status,
        note: assignment.note,
        completedAt: assignment.completedAt,
      },
      episode: toEpisode(episode),
    }
  })

  app.get('/english/episodes', { preHandler: [app.requireAdmin] }, async (request) => {
    const parsed = z
      .object({
        series: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(request.query)
    const { series, limit } = parsed.success ? parsed.data : { series: undefined, limit: 30 }

    const rows = await db
      .select({
        id: englishEpisodes.id,
        seriesSlug: englishSeries.slug,
        seriesName: englishSeries.name,
        title: englishEpisodes.title,
        pageUrl: englishEpisodes.pageUrl,
        thumbnailUrl: englishEpisodes.thumbnailUrl,
        publishedAt: englishEpisodes.publishedAt,
      })
      .from(englishEpisodes)
      .innerJoin(englishSeries, eq(englishEpisodes.seriesId, englishSeries.id))
      .where(series ? eq(englishSeries.slug, series) : undefined)
      .orderBy(desc(englishEpisodes.publishedAt), desc(englishEpisodes.id))
      .limit(limit)

    return { ok: true, episodes: rows }
  })

  app.get('/english/thumbnail/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ ok: false, error: '参数不合法' })

    const [row] = await db
      .select({ thumbnailUrl: englishEpisodes.thumbnailUrl })
      .from(englishEpisodes)
      .where(eq(englishEpisodes.id, params.data.id))
      .limit(1)

    if (!row?.thumbnailUrl) return reply.code(404).send({ ok: false, error: '暂无缩略图' })

    const file = thumbFile(params.data.id)
    try {
      await ensureCached(row.thumbnailUrl, file)
    } catch {
      if (!(await isCached(file))) {
        return reply.code(502).send({ ok: false, error: '缩略图获取失败' })
      }
    }

    reply.header('Content-Type', 'image/jpeg')
    reply.header('Cache-Control', 'public, max-age=604800')
    return reply.send(createReadStream(file))
  })

  app.get('/english/audio/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ ok: false, error: '参数不合法' })

    const [row] = await db
      .select({ audioUrl: englishEpisodes.audioUrl })
      .from(englishEpisodes)
      .where(eq(englishEpisodes.id, params.data.id))
      .limit(1)

    if (!row?.audioUrl) return reply.code(404).send({ ok: false, error: '暂无音频' })

    const file = audioFile(params.data.id)
    try {
      await ensureCached(row.audioUrl, file)
    } catch {
      if (!(await isCached(file))) {
        return reply.code(502).send({ ok: false, error: '音频获取失败' })
      }
    }

    const size = (await stat(file)).size
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Content-Type', 'audio/mpeg')
    reply.header('Cache-Control', 'public, max-age=604800')

    const range = request.headers.range
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
    if (match) {
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : size - 1
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= size) end = size - 1
      if (start > end || start >= size) {
        reply.header('Content-Range', `bytes */${size}`)
        return reply.code(416).send()
      }
      reply.code(206)
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`)
      reply.header('Content-Length', String(end - start + 1))
      return reply.send(createReadStream(file, { start, end }))
    }

    reply.header('Content-Length', String(size))
    return reply.send(createReadStream(file))
  })

  app.post(
    '/english/episodes/:id/align',
    { preHandler: [app.requireAdmin] },
    async (request, reply) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
      if (!params.success) return reply.code(400).send({ ok: false, error: '参数不合法' })

      try {
        await ensureAlignment(params.data.id)
      } catch (e) {
        return reply
          .code(502)
          .send({ ok: false, error: e instanceof Error ? e.message : '对齐失败' })
      }

      const episode = await loadEpisode(params.data.id)
      if (!episode) return reply.code(404).send({ ok: false, error: '素材不存在' })
      return { ok: true, alignment: episode.alignment }
    },
  )

  app.get('/english/assignments/:id', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ ok: false, error: '参数不合法' })

    const [assignment] = await db
      .select()
      .from(englishAssignments)
      .where(
        and(
          eq(englishAssignments.id, params.data.id),
          eq(englishAssignments.userId, request.user.sub),
        ),
      )
      .limit(1)

    if (!assignment) return reply.code(404).send({ ok: false, error: '记录不存在' })

    const episode = await loadEpisode(assignment.episodeId)
    if (!episode) return reply.code(404).send({ ok: false, error: '素材不存在' })

    return {
      ok: true,
      date: assignment.assignedDate,
      assignment: {
        id: assignment.id,
        status: assignment.status,
        note: assignment.note,
        completedAt: assignment.completedAt,
      },
      episode: toEpisode(episode),
    }
  })

  app.get('/english/assignments', { preHandler: [app.requireAdmin] }, async (request) => {
    const parsed = z
      .object({ from: z.string().max(10).optional(), to: z.string().max(10).optional() })
      .safeParse(request.query)
    const { from, to } = parsed.success ? parsed.data : { from: undefined, to: undefined }

    const conditions = [eq(englishAssignments.userId, request.user.sub)]
    if (from) conditions.push(gte(englishAssignments.assignedDate, from))
    if (to) conditions.push(lte(englishAssignments.assignedDate, to))

    const rows = await db
      .select({
        id: englishAssignments.id,
        assignedDate: englishAssignments.assignedDate,
        status: englishAssignments.status,
        completedAt: englishAssignments.completedAt,
        episodeId: englishEpisodes.id,
        title: englishEpisodes.title,
        seriesName: englishSeries.name,
        thumbnailUrl: englishEpisodes.thumbnailUrl,
      })
      .from(englishAssignments)
      .innerJoin(englishEpisodes, eq(englishAssignments.episodeId, englishEpisodes.id))
      .innerJoin(englishSeries, eq(englishEpisodes.seriesId, englishSeries.id))
      .where(and(...conditions))
      .orderBy(desc(englishAssignments.assignedDate))

    return { ok: true, assignments: rows }
  })

  app.get('/english/stats', { preHandler: [app.requireAdmin] }, async (request) => {
    const done = await db
      .select({ assignedDate: englishAssignments.assignedDate })
      .from(englishAssignments)
      .where(
        and(eq(englishAssignments.userId, request.user.sub), eq(englishAssignments.status, 'done')),
      )
      .orderBy(desc(englishAssignments.assignedDate))

    const dates = new Set(done.map((d) => d.assignedDate))
    let streak = 0
    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    if (!dates.has(todayStr())) cursor.setDate(cursor.getDate() - 1)
    while (true) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
      if (!dates.has(key)) break
      streak++
      cursor.setDate(cursor.getDate() - 1)
    }

    return { ok: true, totalDone: done.length, streak }
  })

  app.post(
    '/english/assignments/:id/complete',
    { preHandler: [app.requireAdmin] },
    async (request, reply) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
      const body = z.object({ note: z.string().max(5000).optional() }).safeParse(request.body ?? {})
      if (!params.success || !body.success) {
        return reply.code(400).send({ ok: false, error: '参数不合法' })
      }

      const [updated] = await db
        .update(englishAssignments)
        .set({
          status: 'done',
          note: body.data.note ?? undefined,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(englishAssignments.id, params.data.id),
            eq(englishAssignments.userId, request.user.sub),
          ),
        )
        .returning()

      if (!updated) return reply.code(404).send({ ok: false, error: '记录不存在' })
      return {
        ok: true,
        assignment: { id: updated.id, status: updated.status, note: updated.note },
      }
    },
  )

  app.post(
    '/english/assignments/:id/skip',
    { preHandler: [app.requireAdmin] },
    async (request, reply) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
      if (!params.success) return reply.code(400).send({ ok: false, error: '参数不合法' })

      const [updated] = await db
        .update(englishAssignments)
        .set({ status: 'skipped', updatedAt: new Date() })
        .where(
          and(
            eq(englishAssignments.id, params.data.id),
            eq(englishAssignments.userId, request.user.sub),
          ),
        )
        .returning()

      if (!updated) return reply.code(404).send({ ok: false, error: '记录不存在' })
      return { ok: true, assignment: { id: updated.id, status: updated.status } }
    },
  )

  app.post(
    '/english/assignments/:id/note',
    { preHandler: [app.requireAdmin] },
    async (request, reply) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
      const body = z.object({ note: z.string().max(5000) }).safeParse(request.body ?? {})
      if (!params.success || !body.success) {
        return reply.code(400).send({ ok: false, error: '参数不合法' })
      }

      const [updated] = await db
        .update(englishAssignments)
        .set({ note: body.data.note, updatedAt: new Date() })
        .where(
          and(
            eq(englishAssignments.id, params.data.id),
            eq(englishAssignments.userId, request.user.sub),
          ),
        )
        .returning()

      if (!updated) return reply.code(404).send({ ok: false, error: '记录不存在' })
      return { ok: true, assignment: { id: updated.id, note: updated.note } }
    },
  )
}
