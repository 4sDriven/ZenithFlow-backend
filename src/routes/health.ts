import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'zenith-flow-backend',
    timestamp: new Date().toISOString(),
  }))
}
