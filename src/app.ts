import Fastify from 'fastify'
import cors from '@fastify/cors'
import authPlugin from './plugins/auth.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { userRoutes } from './routes/users.js'
import { videoRoutes } from './routes/video.js'

export async function buildApp() {
  const app = Fastify({
    logger: true,
  })

  await app.register(cors, { origin: true })
  await app.register(authPlugin)

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(authRoutes, { prefix: '/api' })
  await app.register(userRoutes, { prefix: '/api' })
  await app.register(videoRoutes, { prefix: '/api' })

  return app
}
