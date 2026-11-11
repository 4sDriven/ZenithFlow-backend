import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import authPlugin from './plugins/auth.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { userRoutes } from './routes/users.js'
import { videoRoutes } from './routes/video.js'
import { qwenRoutes } from './routes/qwen.js'
import { kbRoutes } from './routes/kb.js'
import { englishRoutes } from './routes/english.js'
import { biliRoutes } from './routes/bili.js'
import { newspaperRoutes } from './routes/newspaper.js'
import { wikiRoutes } from './routes/wiki.js'

export async function buildApp() {
  const app = Fastify({
    logger: true,
  })

  await app.register(cors, { origin: true })
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })
  await app.register(authPlugin)

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(authRoutes, { prefix: '/api' })
  await app.register(userRoutes, { prefix: '/api' })
  await app.register(videoRoutes, { prefix: '/api' })
  await app.register(qwenRoutes, { prefix: '/api' })
  await app.register(kbRoutes, { prefix: '/api' })
  await app.register(englishRoutes, { prefix: '/api' })
  await app.register(biliRoutes, { prefix: '/api' })
  await app.register(newspaperRoutes, { prefix: '/api' })
  await app.register(wikiRoutes, { prefix: '/api' })

  return app
}
