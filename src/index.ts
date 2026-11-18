import { setDefaultResultOrder } from 'node:dns'
import { buildApp } from './app.js'
import { config } from './config.js'

// 这台机器 IPv6 不可达，Node 默认优先 AAAA 会偶发 ETIMEDOUT（网易云 / B站 都踩过）
setDefaultResultOrder('ipv4first')

const app = await buildApp()

try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
