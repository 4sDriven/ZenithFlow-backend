import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'

export type JwtPayload = {
  sub: number
  username: string
  role: 'admin' | 'user'
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user: JwtPayload
  }
}

export default fp(async (app) => {
  await app.register(jwt, { secret: config.JWT_SECRET })

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch {
      await reply.code(401).send({ ok: false, error: '未登录或登录已过期' })
    }
  })

  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch {
      await reply.code(401).send({ ok: false, error: '未登录或登录已过期' })
      return
    }

    if (request.user.role !== 'admin') {
      await reply.code(403).send({ ok: false, error: '需要管理员权限' })
    }
  })
})
