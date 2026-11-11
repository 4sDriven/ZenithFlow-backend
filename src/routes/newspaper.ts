import type { FastifyInstance } from 'fastify'
import {
  generateNewspaper,
  getNewspaperView,
  isNewspaperGenerating,
} from '../lib/newspaper/service.js'

export async function newspaperRoutes(app: FastifyInstance) {
  app.get('/newspaper/today', { preHandler: [app.requireAuth] }, async () => {
    return getNewspaperView()
  })

  app.post(
    '/newspaper/generate',
    { preHandler: [app.requireAdmin] },
    async (_request, reply) => {
      if (isNewspaperGenerating()) {
        return reply.code(409).send({ ok: false, error: '报纸正在生成中，请稍后再试' })
      }

      // 不阻塞请求：生成通常 1-3 分钟，前端轮询 /newspaper/today
      void generateNewspaper({ trigger: 'manual' }).catch((error) => {
        app.log.error({ err: error }, 'newspaper generation failed')
      })

      return { ok: true, started: true }
    },
  )
}
