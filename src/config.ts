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
  // 文本生成首选渠道。默认百炼 qwen-plus：存量任务（摘要 / RAG 问答 / 结构化 JSON）够用且单价最低
  // 需要更强推理时改成 deepseek（需 DEEPSEEK_API_KEY）；另一渠道始终作为兜底
  TEXT_PROVIDER: z.enum(['deepseek', 'dashscope']).default('dashscope'),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
  // 网易云开放平台（AI 推荐歌单）：应用私钥 base64 单行，避免多行 PEM 进 env
  NETEASE_APP_ID: z.string().default('b3010d000000000049b0c40abe75f542'),
  NETEASE_APP_KEY_B64: z.string().default(''),
  NETEASE_DEVICE_ID: z.string().default('ncmcli_553f7cab207264dbfa7da9d9'),
  NETEASE_CLIENT_IP: z.string().default('127.0.0.1'),
  MEDIA_DIR: z.string().default('/var/lib/zenithflow/media'),
  PUBLIC_BASE_URL: z.string().default('http://47.238.148.245'),
  FFMPEG_PATH: z.string().default('/opt/zenithflow/bin/ffmpeg'),
  FFPROBE_PATH: z.string().default('/opt/zenithflow/bin/ffprobe'),
  QIANWEN_CLI_PATH: z.string().default('/usr/local/nodejs/bin/qianwen'),
})

export const config = envSchema.parse(process.env)

export type Config = typeof config
