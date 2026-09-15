import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users, type User } from '../db/schema.js'
import { hashPassword } from '../lib/password.js'

const createSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(6).max(128),
  role: z.enum(['admin', 'user']).default('user'),
  displayName: z.string().max(128).optional(),
})

const updateSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  displayName: z.string().max(128).optional(),
  password: z.string().min(6).max(128).optional(),
})

function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    createdAt: user.createdAt,
  }
}

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: [app.requireAdmin] }, async () => {
    const list = await db.select().from(users).orderBy(users.id)
    return { ok: true, users: list.map(toPublicUser) }
  })

  app.post('/users', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }

    const { username, password, role, displayName } = parsed.data
    const [exists] = await db.select().from(users).where(eq(users.username, username)).limit(1)
    if (exists) {
      return reply.code(409).send({ ok: false, error: '用户名已存在' })
    }

    const [created] = await db
      .insert(users)
      .values({ username, passwordHash: hashPassword(password), role, displayName })
      .returning()

    if (!created) {
      return reply.code(500).send({ ok: false, error: '创建失败' })
    }

    return reply.code(201).send({ ok: true, user: toPublicUser(created) })
  })

  app.patch('/users/:id', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const parsed = updateSchema.safeParse(request.body)
    if (!Number.isInteger(id) || !parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() }
    if (parsed.data.role) patch.role = parsed.data.role
    if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName
    if (parsed.data.password) patch.passwordHash = hashPassword(parsed.data.password)

    const [updated] = await db.update(users).set(patch).where(eq(users.id, id)).returning()
    if (!updated) {
      return reply.code(404).send({ ok: false, error: '用户不存在' })
    }

    return { ok: true, user: toPublicUser(updated) }
  })

  app.delete('/users/:id', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }
    if (id === request.user.sub) {
      return reply.code(400).send({ ok: false, error: '不能删除自己' })
    }

    const [deleted] = await db.delete(users).where(eq(users.id, id)).returning()
    if (!deleted) {
      return reply.code(404).send({ ok: false, error: '用户不存在' })
    }

    return { ok: true }
  })
}
