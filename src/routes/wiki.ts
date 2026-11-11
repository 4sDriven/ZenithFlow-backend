import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { resolveSite, searchWiki, WikiPageError } from '../lib/wiki/mediawiki.js'
import { readWikiPage, WikiError } from '../lib/wiki/service.js'
import { assertPublicHost, normalizeInputUrl, WikiUrlError } from '../lib/wiki/url.js'

const pageQuery = z.object({
  u: z.string().trim().min(1).max(2048),
})

const searchQuery = z.object({
  u: z.string().trim().min(1).max(2048),
  q: z.string().trim().min(2).max(80),
})

function fail(error: unknown) {
  if (error instanceof WikiError) {
    return { status: error.status, body: { ok: false, error: error.message, code: error.code } }
  }
  if (error instanceof WikiUrlError) {
    return {
      status: error.code === 'blocked' ? 403 : 400,
      body: { ok: false, error: error.message, code: error.code },
    }
  }
  if (error instanceof WikiPageError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : 502
    return { status, body: { ok: false, error: error.message, code: error.code } }
  }
  return {
    status: 502,
    body: { ok: false, error: error instanceof Error ? error.message : '读取失败' },
  }
}

export async function wikiRoutes(app: FastifyInstance) {
  app.get('/wiki/page', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const parsed = pageQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '请输入要打开的网址' })
    }

    try {
      return await readWikiPage(parsed.data.u)
    } catch (error) {
      const { status, body } = fail(error)
      return reply.code(status).send(body)
    }
  })

  app.get('/wiki/search', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const parsed = searchQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '请输入站点地址和关键词' })
    }

    try {
      const pageUrl = normalizeInputUrl(parsed.data.u)
      await assertPublicHost(pageUrl)
      const site = await resolveSite(pageUrl)
      if (!site) {
        return reply.code(400).send({ ok: false, error: '该站点不是 MediaWiki，不支持站内搜索' })
      }
      return { ok: true, results: await searchWiki(site, parsed.data.q) }
    } catch (error) {
      const { status, body } = fail(error)
      return reply.code(status).send(body)
    }
  })
}
