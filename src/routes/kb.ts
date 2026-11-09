import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { knowledgeChunks, knowledgeItems } from '../db/schema.js'
import { cosineSimilarity, embedTexts } from '../lib/embed.js'
import { answerWithContext, chunkText, extractUrlContent, lexicalScore } from '../lib/kb.js'
import { extractFileText } from '../lib/extract.js'
import { rerankDocuments } from '../lib/rerank.js'

const tagsInput = z
  .union([z.array(z.string().max(32)).max(10), z.string().max(500)])
  .optional()

const itemSchema = z.object({
  type: z.enum(['note', 'url', 'text']),
  title: z.string().max(300).optional(),
  content: z.string().max(200_000).optional(),
  url: z.string().url().max(2000).optional(),
  tags: tagsInput,
})

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  topK: z.coerce.number().int().min(1).max(10).default(5),
})

function normalizeTags(input?: string[] | string): string[] {
  const raw = Array.isArray(input) ? input : (input ?? '').split(/[,，、]/)
  const seen = new Set<string>()
  for (const tag of raw) {
    const trimmed = tag.trim().slice(0, 32)
    if (trimmed) seen.add(trimmed)
  }
  return [...seen].slice(0, 10)
}

function toItemSummary(item: typeof knowledgeItems.$inferSelect, chunkCount: number) {
  return {
    id: item.id,
    title: item.title,
    sourceType: item.sourceType,
    sourceUrl: item.sourceUrl,
    fileName: item.fileName,
    tags: item.tags,
    status: item.status,
    chunkCount,
    createdAt: item.createdAt,
  }
}

export async function kbRoutes(app: FastifyInstance) {
  app.get('/kb/items', { preHandler: [app.requireAuth] }, async (request) => {
    const query = z.object({ tag: z.string().max(32).optional() }).safeParse(request.query)
    const tag = query.data?.tag?.trim()

    const items = await db
      .select()
      .from(knowledgeItems)
      .where(
        tag
          ? and(
              eq(knowledgeItems.userId, request.user.sub),
              sql`${knowledgeItems.tags} @> ARRAY[${tag}]::text[]`,
            )
          : eq(knowledgeItems.userId, request.user.sub),
      )
      .orderBy(desc(knowledgeItems.createdAt))

    const counts = await db
      .select({ itemId: knowledgeChunks.itemId, count: sql<number>`count(*)::int` })
      .from(knowledgeChunks)
      .groupBy(knowledgeChunks.itemId)

    const countMap = new Map(counts.map((c) => [c.itemId, c.count]))

    return { ok: true, items: items.map((item) => toItemSummary(item, countMap.get(item.id) ?? 0)) }
  })

  async function ingest(params: {
    userId: number
    title: string
    sourceType: 'note' | 'url' | 'text' | 'file'
    sourceUrl?: string | null
    fileName?: string | null
    tags: string[]
    text: string
  }) {
    const chunks = chunkText(params.text)
    if (chunks.length === 0) throw new Error('EMPTY_CONTENT')

    const embeddings = await embedTexts(chunks)

    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(knowledgeItems)
        .values({
          userId: params.userId,
          title: params.title.slice(0, 300),
          sourceType: params.sourceType,
          sourceUrl: params.sourceUrl ?? null,
          fileName: params.fileName ?? null,
          tags: params.tags,
          contentText: params.text,
          status: 'ready',
        })
        .returning()

      if (!created) throw new Error('INSERT_FAILED')

      await tx.insert(knowledgeChunks).values(
        chunks.map((chunk, i) => ({
          itemId: created.id,
          chunkIndex: i,
          content: chunk,
          embedding: embeddings[i]!,
        })),
      )

      return { item: created, chunkCount: chunks.length }
    })
  }

  app.post('/kb/items', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = itemSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }

    const { type, title: rawTitle, content, url, tags } = parsed.data
    let title = rawTitle?.trim() ?? ''
    let text = ''
    let sourceUrl: string | null = null

    try {
      if (type === 'url') {
        if (!url) return reply.code(400).send({ ok: false, error: '缺少 url' })
        const fetched = await extractUrlContent(url)
        title = title || fetched.title
        text = fetched.text
        sourceUrl = url
      } else {
        text = (content ?? '').trim()
        title = title || text.slice(0, 30) || '未命名笔记'
      }

      if (!text) {
        return reply.code(400).send({ ok: false, error: '内容为空' })
      }

      const result = await ingest({
        userId: request.user.sub,
        title,
        sourceType: type,
        sourceUrl,
        tags: normalizeTags(tags),
        text,
      })

      return {
        ok: true,
        item: { id: result.item.id, title: result.item.title, chunkCount: result.chunkCount },
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'EMPTY_CONTENT') {
        return reply.code(400).send({ ok: false, error: '没有可入库的内容' })
      }
      app.log.error(err, 'kb ingest failed')
      return reply.code(502).send({ ok: false, error: '入库失败，请检查链接或稍后重试' })
    }
  })

  app.post('/kb/upload', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const query = z
      .object({ title: z.string().max(300).optional(), tags: z.string().max(500).optional() })
      .safeParse(request.query)

    let data
    try {
      data = await request.file()
    } catch {
      return reply.code(400).send({ ok: false, error: '文件上传失败或超过大小限制' })
    }

    if (!data) {
      return reply.code(400).send({ ok: false, error: '缺少文件' })
    }

    try {
      const buffer = await data.toBuffer()
      const text = (await extractFileText(buffer, data.filename, data.mimetype)).trim()
      if (!text) {
        return reply.code(400).send({ ok: false, error: '未能从文件提取到文本' })
      }

      const result = await ingest({
        userId: request.user.sub,
        title: query.data?.title?.trim() || data.filename,
        sourceType: 'file',
        fileName: data.filename,
        tags: normalizeTags(query.data?.tags),
        text,
      })

      return {
        ok: true,
        item: { id: result.item.id, title: result.item.title, chunkCount: result.chunkCount },
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'EMPTY_CONTENT') {
        return reply.code(400).send({ ok: false, error: '没有可入库的内容' })
      }
      app.log.error(err, 'kb upload failed')
      const message = err instanceof Error ? err.message : '文件解析失败'
      return reply.code(400).send({ ok: false, error: message })
    }
  })

  app.delete('/kb/items/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }

    await db
      .delete(knowledgeItems)
      .where(and(eq(knowledgeItems.id, params.data.id), eq(knowledgeItems.userId, request.user.sub)))

    return { ok: true }
  })

  app.post('/kb/ask', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = askSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }

    const { question, topK } = parsed.data
    const rrfK = 60

    try {
      const rows = await db
        .select({
          chunkId: knowledgeChunks.id,
          itemId: knowledgeChunks.itemId,
          title: knowledgeItems.title,
          sourceType: knowledgeItems.sourceType,
          sourceUrl: knowledgeItems.sourceUrl,
          tags: knowledgeItems.tags,
          chunkIndex: knowledgeChunks.chunkIndex,
          content: knowledgeChunks.content,
          embedding: knowledgeChunks.embedding,
        })
        .from(knowledgeChunks)
        .innerJoin(knowledgeItems, eq(knowledgeChunks.itemId, knowledgeItems.id))
        .where(eq(knowledgeItems.userId, request.user.sub))

      if (rows.length === 0) {
        return { ok: true, answer: '知识库还没有资料，请先添加笔记、网页或文件。', citations: [] }
      }

      const [questionVector] = await embedTexts([question])
      if (!questionVector) throw new Error('问题向量生成失败')

      const vectorScores = new Map<number, number>()
      const vectorRanked = rows
        .map((row) => {
          const score = cosineSimilarity(questionVector, row.embedding)
          vectorScores.set(row.chunkId, score)
          return { row, score }
        })
        .sort((a, b) => b.score - a.score)

      const lexicalRanked = rows
        .map((row) => ({ row, score: lexicalScore(question, row.content) }))
        .sort((a, b) => b.score - a.score)

      const fused = new Map<number, { row: (typeof rows)[number]; score: number }>()
      const addRank = (row: (typeof rows)[number], rank: number) => {
        const current = fused.get(row.chunkId)
        const inc = 1 / (rrfK + rank)
        if (current) current.score += inc
        else fused.set(row.chunkId, { row, score: inc })
      }

      vectorRanked.slice(0, 20).forEach((item, rank) => addRank(item.row, rank))
      lexicalRanked.slice(0, 20).forEach((item, rank) => addRank(item.row, rank))

      const candidates = [...fused.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((c) => c.row)

      let picked: typeof candidates = []
      let reranked = false
      try {
        const results = await rerankDocuments(
          question,
          candidates.map((c) => c.content),
          topK,
        )
        picked = results.map((r) => candidates[r.index]).filter((c): c is (typeof rows)[number] => Boolean(c))
        reranked = picked.length > 0
      } catch (err) {
        app.log.warn(err, 'kb rerank failed, fallback to fused order')
      }
      if (!reranked) picked = candidates.slice(0, topK)

      const answer = await answerWithContext({
        question,
        contexts: picked.map((p) => ({ title: p.title, content: p.content })),
      })

      return {
        ok: true,
        answer,
        reranked,
        citations: picked.map((p) => ({
          itemId: p.itemId,
          title: p.title,
          sourceType: p.sourceType,
          sourceUrl: p.sourceUrl,
          tags: p.tags,
          chunkIndex: p.chunkIndex,
          content: p.content,
          score: Number((vectorScores.get(p.chunkId) ?? 0).toFixed(4)),
        })),
      }
    } catch (err) {
      app.log.error(err, 'kb ask failed')
      return reply.code(502).send({ ok: false, error: '问答失败，请稍后重试' })
    }
  })
}
