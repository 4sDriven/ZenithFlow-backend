import type { FastifyInstance } from 'fastify'
import { getQwenBalance } from '../lib/qwen.js'

export async function qwenRoutes(app: FastifyInstance) {
  app.get('/qwen/balance', { preHandler: [app.requireAuth] }, async (_request, reply) => {
    try {
      const balance = await getQwenBalance()
      return { ok: true, balance, fetchedAt: new Date().toISOString() }
    } catch (err) {
      app.log.error(err, 'qwen balance query failed')
      return reply.code(502).send({
        ok: false,
        error: '余额查询失败：千问 CLI 可能未登录或凭据已过期',
      })
    }
  })
}
