import { config } from '../config.js'

/**
 * 纯文本生成统一入口。
 *
 * 首选渠道由 TEXT_PROVIDER 决定（默认 DeepSeek 官方），失败时自动退回另一个：
 * - deepseek：`https://api.deepseek.com/chat/completions`，非思考模式
 * - dashscope：百炼 OpenAI 兼容模式，qwen-plus
 *
 * 视频 / 语音 / 向量 / 重排仍走百炼，不经过这里。
 */

export type TextProvider = 'deepseek' | 'dashscope'

export type ChatTextOptions = {
  system?: string
  user: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

type Message = { role: 'system' | 'user'; content: string }

type Attempt = {
  provider: TextProvider
  url: string
  apiKey: string
  body: Record<string, unknown>
}

const DEFAULT_TIMEOUT_MS = 90_000

function buildAttempt(provider: TextProvider, messages: Message[], options: ChatTextOptions): Attempt | null {
  if (provider === 'deepseek') {
    if (!config.DEEPSEEK_API_KEY) return null
    return {
      provider,
      url: `${config.DEEPSEEK_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      apiKey: config.DEEPSEEK_API_KEY,
      body: {
        model: config.DEEPSEEK_MODEL,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        // 官方默认开启思考，会把 max_tokens 大量花在思维链上；脚本 / 日报不需要
        thinking: { type: 'disabled' },
      },
    }
  }

  return {
    provider,
    url: `${config.DASHSCOPE_BASE_URL.replace(/\/$/, '')}/compatible-mode/v1/chat/completions`,
    apiKey: config.DASHSCOPE_API_KEY,
    body: {
      model: 'qwen-plus',
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    },
  }
}

function providerOrder(): TextProvider[] {
  const preferred: TextProvider = config.TEXT_PROVIDER
  const fallback: TextProvider = preferred === 'deepseek' ? 'dashscope' : 'deepseek'
  return [preferred, fallback]
}

/**
 * 调用文本模型，返回 `choices[0].message.content`。
 * 首选渠道失败（网络 / 4xx / 5xx / 空回复）时自动换另一个渠道再试一次。
 */
export async function chatText(options: ChatTextOptions): Promise<string> {
  const messages: Message[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  messages.push({ role: 'user', content: options.user })

  const errors: string[] = []

  for (const provider of providerOrder()) {
    const attempt = buildAttempt(provider, messages, options)
    if (!attempt) {
      errors.push(`${provider}: 未配置密钥`)
      continue
    }

    try {
      const res = await fetch(attempt.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${attempt.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(attempt.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })

      if (!res.ok) {
        const text = await res.text()
        errors.push(`${provider}: ${res.status} ${text.slice(0, 160)}`)
        continue
      }

      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content?.trim()
      if (!content) {
        errors.push(`${provider}: 空回复`)
        continue
      }

      if (provider !== config.TEXT_PROVIDER) {
        console.warn(`[text] ${config.TEXT_PROVIDER} 不可用，已退回 ${provider}`)
      }
      return content
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`模型调用失败：${errors.join('；')}`)
}
