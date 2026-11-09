import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users, type User } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../lib/password.js'

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
})

function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '请求格式错误' })
    }

    const { username, password } = parsed.data
    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1)

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ ok: false, error: '用户名或密码错误' })
    }

    const token = await reply.jwtSign({
      sub: user.id,
      username: user.username,
      role: user.role,
    })

    return { ok: true, token, user: toPublicUser(user) }
  })

  app.get('/auth/me', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const [user] = await db.select().from(users).where(eq(users.id, request.user.sub)).limit(1)

    if (!user) {
      return reply.code(401).send({ ok: false, error: '用户不存在' })
    }

    return { ok: true, user: toPublicUser(user) }
  })

  app.post('/auth/password', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = passwordSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '新密码至少 8 位' })
    }

    const { currentPassword, newPassword } = parsed.data
    const [user] = await db.select().from(users).where(eq(users.id, request.user.sub)).limit(1)
    if (!user) {
      return reply.code(404).send({ ok: false, error: '用户不存在' })
    }

    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return reply.code(400).send({ ok: false, error: '当前密码不正确' })
    }

    if (currentPassword === newPassword) {
      return reply.code(400).send({ ok: false, error: '新密码不能与当前密码相同' })
    }

    await db
      .update(users)
      .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, user.id))

    return { ok: true }
  })
}
