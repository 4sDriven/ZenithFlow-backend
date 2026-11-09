import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { biliAccounts, type BiliAccount } from '../db/schema.js'
import { decryptSecret, encryptSecret } from '../lib/secret-box.js'
import {
  BiliError,
  buildBiliCookieHeader,
  createBiliComment,
  fetchBiliNav,
  fetchCommentBatch,
  fetchSubReplies,
  fetchThread,
  fetchUpVideos,
  generateBiliQrCode,
  invalidateBiliCommentCache,
  likeBiliComment,
  pollBiliQrCode,
  resolveVideo,
  searchUps,
  searchVideos,
} from '../lib/bilibili.js'

const searchQuery = z.object({
  keyword: z.string().trim().min(1).max(50),
  page: z.coerce.number().int().min(1).max(50).default(1),
})

const upSearchQuery = z.object({
  keyword: z.string().trim().min(1).max(50),
  page: z.coerce.number().int().min(1).max(50).default(1),
})

const upVideosQuery = z.object({
  mid: z.string().trim().regex(/^\d{1,20}$/),
  page: z.coerce.number().int().min(1).max(10).default(1),
  order: z.enum(['pubdate', 'click']).default('pubdate'),
})

const commentsQuery = z.object({
  input: z.string().trim().min(1).max(300),
  cursor: z
    .string()
    .trim()
    .regex(/^\d{1,6}:\d{1,6}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** 兼容旧的页码参数：page=2 等价于 cursor=2:0&limit=30 */
  page: z.coerce.number().int().min(1).max(20000).optional(),
  sort: z.enum(['hot', 'latest']).default('hot'),
})

const repliesQuery = z.object({
  input: z.string().trim().min(1).max(300),
  root: z.string().trim().min(1).max(40),
  page: z.coerce.number().int().min(1).max(2000).default(1),
})

const threadQuery = z.object({
  input: z.string().trim().min(1).max(300),
  root: z.string().trim().regex(/^\d{1,40}$/),
  rpid: z.string().trim().regex(/^\d{1,40}$/),
  limit: z.coerce.number().int().min(20).max(800).default(200),
})

const qrPollQuery = z.object({
  key: z.string().trim().regex(/^[a-f0-9]{32}$/i),
})

const likeBody = z.object({
  aid: z.coerce.number().int().positive(),
  rpid: z.string().trim().regex(/^\d{1,40}$/),
  action: z.union([z.literal(0), z.literal(1)]),
})

const addCommentBody = z.object({
  aid: z.coerce.number().int().positive(),
  message: z.string().trim().min(1).max(1000),
  root: z.string().trim().regex(/^\d{1,40}$/).default('0'),
  parent: z.string().trim().regex(/^\d{1,40}$/).default('0'),
})

const QR_TTL = 3 * 60 * 1000
const QR_GENERATE_COOLDOWN = 3000

type PendingQr = { userId: number; createdAt: number }
const pendingQrCodes = new Map<string, PendingQr>()
const qrGenerateAt = new Map<number, number>()

function pruneQrState() {
  const now = Date.now()
  for (const [key, item] of pendingQrCodes) {
    if (now - item.createdAt > QR_TTL) pendingQrCodes.delete(key)
  }
  for (const [userId, at] of qrGenerateAt) {
    if (now - at > 60_000) qrGenerateAt.delete(userId)
  }
}

function toPublicBiliAccount(row: BiliAccount) {
  return {
    mid: row.mid,
    uname: row.uname,
    boundAt: row.boundAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
    expired: row.tokenExpiresAt ? row.tokenExpiresAt.getTime() <= Date.now() : false,
  }
}

/** 取出当前站点账号绑定的 B 站登录态（只用于点赞/回复等写操作） */
async function loadBiliAuth(userId: number) {
  const [row] = await db
    .select()
    .from(biliAccounts)
    .where(eq(biliAccounts.userId, userId))
    .limit(1)

  if (!row) throw new BiliError(409, '请先绑定 B 站账号')
  if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= Date.now()) {
    throw new BiliError(401, 'B 站登录已过期，请重新扫码绑定')
  }

  let cookies: Record<string, string>
  try {
    cookies = JSON.parse(decryptSecret(row.cookiesEnc)) as Record<string, string>
  } catch {
    throw new BiliError(401, 'B 站登录凭据已损坏，请重新扫码绑定')
  }

  const csrf = cookies.bili_jct
  if (!cookies.SESSDATA || !csrf) {
    throw new BiliError(401, 'B 站登录凭据不完整，请重新扫码绑定')
  }

  return {
    mid: row.mid,
    uname: row.uname,
    csrf,
    cookieHeader: buildBiliCookieHeader(cookies),
  }
}

export async function biliRoutes(app: FastifyInstance) {
  app.get('/bili/search', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = searchQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '请输入 1~50 字的搜索关键词' })
    }

    const { keyword, page } = parsed.data

    try {
      const result = await searchVideos(keyword, page)
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili search failed')
      return reply.code(502).send({ ok: false, error: '搜索 B 站视频失败，请稍后再试' })
    }
  })

  app.get('/bili/up/search', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = upSearchQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '请输入 1~50 字的 UP 主名字' })
    }

    const { keyword, page } = parsed.data

    try {
      const result = await searchUps(keyword, page)
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili up search failed')
      return reply.code(502).send({ ok: false, error: '搜索 UP 主失败，请稍后再试' })
    }
  })

  app.get('/bili/up/videos', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = upVideosQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'UP 主参数不正确，无法获取投稿' })
    }

    const { mid, page, order } = parsed.data

    try {
      const result = await fetchUpVideos(mid, page, order)
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili up videos failed')
      return reply.code(502).send({ ok: false, error: '获取 UP 主投稿失败，请稍后再试' })
    }
  })

  app.get('/bili/comments', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = commentsQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: '请输入 B 站视频链接、BV 号或 av 号',
      })
    }

    const { input, sort } = parsed.data
    const legacy = parsed.data.cursor === undefined && parsed.data.page !== undefined
    const rawCursor = parsed.data.cursor ?? `${parsed.data.page ?? 1}:0`
    const [page, offset] = rawCursor.split(':').map((part) => Number(part))
    const limit = legacy ? 30 : parsed.data.limit

    try {
      const video = await resolveVideo(input)
      const result = await fetchCommentBatch(
        video,
        { page: page || 1, offset: offset || 0 },
        limit,
        sort,
      )
      return { ok: true, video, sort, ...result }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili comments failed')
      return reply.code(502).send({ ok: false, error: '获取 B 站评论失败，请稍后再试' })
    }
  })

  app.get('/bili/replies', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = repliesQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不完整，无法加载子评论' })
    }

    const { input, root, page } = parsed.data

    try {
      const video = await resolveVideo(input)
      const result = await fetchSubReplies(video, root, page)
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili sub replies failed')
      return reply.code(502).send({ ok: false, error: '获取子评论失败，请稍后再试' })
    }
  })

  app.get('/bili/thread', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = threadQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不完整，无法加载讨论关系' })
    }

    const { input, root, rpid, limit } = parsed.data

    try {
      const video = await resolveVideo(input)
      const result = await fetchThread(video, root, rpid, limit)
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili thread failed')
      return reply.code(502).send({ ok: false, error: '获取讨论关系失败，请稍后再试' })
    }
  })

  app.post('/bili/comments/like', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = likeBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '点赞参数不正确' })
    }

    const { aid, rpid, action } = parsed.data

    try {
      const auth = await loadBiliAuth(request.user.sub)
      await likeBiliComment(auth.cookieHeader, auth.csrf, aid, rpid, action)
      return { ok: true, action, liked: action === 1 }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili comment like failed')
      return reply.code(502).send({ ok: false, error: '点赞失败，请稍后再试' })
    }
  })

  app.post('/bili/comments', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = addCommentBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '请输入 1~1000 字的评论内容' })
    }

    const { aid, message, root, parent } = parsed.data
    if (parent !== '0' && root === '0') {
      return reply.code(400).send({ ok: false, error: '回复参数不完整，无法提交' })
    }

    try {
      const auth = await loadBiliAuth(request.user.sub)
      const video = await resolveVideo(String(aid))
      const created = await createBiliComment(
        video,
        auth.cookieHeader,
        auth.csrf,
        message,
        root,
        parent,
      )
      invalidateBiliCommentCache(video.aid)
      return { ok: true, ...created }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili comment add failed')
      return reply.code(502).send({ ok: false, error: '发表评论失败，请稍后再试' })
    }
  })

  app.post('/bili/auth/qrcode', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const userId = request.user.sub
    pruneQrState()

    const last = qrGenerateAt.get(userId) ?? 0
    if (Date.now() - last < QR_GENERATE_COOLDOWN) {
      return reply.code(429).send({ ok: false, error: '操作太频繁，请稍后再试' })
    }

    try {
      const code = await generateBiliQrCode()
      pendingQrCodes.set(code.key, { userId, createdAt: Date.now() })
      qrGenerateAt.set(userId, Date.now())
      return { ok: true, ...code }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili qrcode generate failed')
      return reply.code(502).send({ ok: false, error: '获取 B 站二维码失败，请稍后再试' })
    }
  })

  app.get('/bili/auth/qrcode/poll', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = qrPollQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, status: 'expired', error: '二维码参数不正确' })
    }

    pruneQrState()
    const pending = pendingQrCodes.get(parsed.data.key)
    if (!pending || pending.userId !== request.user.sub) {
      return reply
        .code(410)
        .send({ ok: false, status: 'expired', error: '二维码已失效，请刷新' })
    }

    try {
      const result = await pollBiliQrCode(parsed.data.key)

      if (result.status !== 'success') {
        if (result.status === 'expired') pendingQrCodes.delete(parsed.data.key)
        return { ok: true, status: result.status, message: result.message }
      }

      if (!result.cookies) {
        throw new BiliError(502, 'B 站登录成功但未拿到登录凭据，请重新扫码')
      }

      const cookieHeader = buildBiliCookieHeader(result.cookies)
      const nav = await fetchBiliNav(cookieHeader)
      const cookiesEnc = encryptSecret(JSON.stringify(result.cookies))
      const refreshTokenEnc = result.refreshToken
        ? encryptSecret(result.refreshToken)
        : null
      const expiresAt = result.expiresAt ? new Date(result.expiresAt) : null
      const now = new Date()

      const [row] = await db
        .insert(biliAccounts)
        .values({
          userId: request.user.sub,
          mid: nav.mid,
          uname: nav.uname,
          cookiesEnc,
          refreshTokenEnc,
          tokenExpiresAt: expiresAt,
          boundAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: biliAccounts.userId,
          set: {
            mid: nav.mid,
            uname: nav.uname,
            cookiesEnc,
            refreshTokenEnc,
            tokenExpiresAt: expiresAt,
            boundAt: now,
            updatedAt: now,
          },
        })
        .returning()

      pendingQrCodes.delete(parsed.data.key)
      return {
        ok: true,
        status: 'success',
        message: '登录成功',
        account: row ? toPublicBiliAccount(row) : null,
      }
    } catch (err) {
      if (err instanceof BiliError) {
        return reply.code(err.status).send({ ok: false, error: err.message })
      }
      app.log.error(err, 'bilibili qrcode poll failed')
      return reply.code(502).send({ ok: false, error: '轮询 B 站二维码失败，请稍后再试' })
    }
  })

  app.get('/bili/auth/me', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const [row] = await db
      .select()
      .from(biliAccounts)
      .where(eq(biliAccounts.userId, request.user.sub))
      .limit(1)

    if (!row) return { ok: true, account: null }
    return { ok: true, account: toPublicBiliAccount(row) }
  })

  app.delete('/bili/auth', { preHandler: [app.requireAuth] }, async (request) => {
    await db.delete(biliAccounts).where(eq(biliAccounts.userId, request.user.sub))
    return { ok: true }
  })
}
