import { config } from '../config.js'

const base = config.DASHSCOPE_BASE_URL.replace(/\/$/, '')

export function chunkText(text: string, size = 600, overlap = 80): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []

  const chunks: string[] = []
  let start = 0

  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)

    if (end < clean.length) {
      const window = clean.slice(start, end)
      const cut = Math.max(
        window.lastIndexOf('\n'),
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('. '),
      )
      if (cut > size * 0.5) end = start + cut + 1
    }

    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break

    start = Math.max(end - overlap, start + 1)
  }

  return chunks
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
}

export async function extractUrlContent(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZenithFlow/1.0)' },
    redirect: 'follow',
  })

  if (!res.ok) {
    throw new Error(`抓取网页失败 (${res.status})`)
  }

  const html = await res.text()
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = (titleMatch?.[1] ? decodeEntities(titleMatch[1]).trim() : '') || url

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, text: cleaned }
}

function tokenize(input: string): Set<string> {
  const lower = input.toLowerCase()
  const tokens = new Set<string>()

  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) {
    tokens.add(word)
  }

  const cjk = lower.replace(/[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.add(cjk.slice(i, i + 2))
  }

  return tokens
}

export function lexicalScore(query: string, text: string): number {
  const queryTokens = tokenize(query)
  if (queryTokens.size === 0) return 0

  const textTokens = tokenize(text)
  let hit = 0
  for (const token of queryTokens) {
    if (textTokens.has(token)) hit++
  }

  return hit / queryTokens.size
}

export async function answerWithContext(params: {
  question: string
  contexts: { title: string; content: string }[]
}): Promise<string> {
  const { question, contexts } = params

  const contextText = contexts
    .map((c, i) => `【资料 ${i + 1}｜${c.title}】\n${c.content}`)
    .join('\n\n')

  const system =
    '你是个人知识库助手。只依据用户提供的「资料」回答问题，资料中没有的信息不要编造。用简体中文简洁准确地回答。引用资料时在句末用 [1][2] 标注对应资料编号。'
  const user = `资料：\n${contextText}\n\n问题：${question}`

  const res = await fetch(`${base}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen-plus',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
    }),
  })

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    code?: string
    message?: string
  }

  const content = data.choices?.[0]?.message?.content
  if (!res.ok || !content) {
    throw new Error(`问答失败 (${data.code ?? res.status}) ${data.message ?? ''}`)
  }

  return content
}
