import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  BILI_TOKEN_SECRET: z.string().min(16),
  DASHSCOPE_API_KEY: z.string().min(1),
  DASHSCOPE_BASE_URL: z.string().default('https://dashscope.aliyuncs.com'),
  MEDIA_DIR: z.string().default('/var/lib/zenithflow/media'),
  PUBLIC_BASE_URL: z.string().default('http://47.238.148.245'),
  FFMPEG_PATH: z.string().default('/opt/zenithflow/bin/ffmpeg'),
  FFPROBE_PATH: z.string().default('/opt/zenithflow/bin/ffprobe'),
  QIANWEN_CLI_PATH: z.string().default('/usr/local/nodejs/bin/qianwen'),
})

export const config = envSchema.parse(process.env)

export type Config = typeof config
