import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users, type User } from '../db/schema.js'
import { verifyPassword } from '../lib/password.js'

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
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
}
