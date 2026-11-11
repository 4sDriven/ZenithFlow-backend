const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 所有报纸采集请求串行 + 间隔，避免把源站打出风控 */
const REQUEST_GAP_MS = 220
let requestChain: Promise<void> = Promise.resolve()
let lastRequestAt = 0

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestChain.then(async () => {
    const wait = REQUEST_GAP_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return fn()
  })
  requestChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export type FetchOptions = {
  timeoutMs?: number
  headers?: Record<string, string>
  charset?: string
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const response = await schedule(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          ...options.headers,
        },
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? '',
      }
    } finally {
      clearTimeout(timer)
    }
  })

  const headerCharset = response.contentType.match(/charset=([\w-]+)/i)?.[1]
  const charset = options.charset ?? headerCharset ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(response.buffer)
  } catch {
    return new TextDecoder('utf-8').decode(response.buffer)
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('返回内容不是合法 JSON')
  }
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

export function stripHtml(input: string): string {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clip(input: string, max: number): string {
  const text = input.trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).replace(/[，。；、\s]+$/g, '')}…`
}

export function absoluteUrl(url: string, base?: string): string | null {
  const raw = decodeEntities(url).trim()
  if (!raw || raw.startsWith('javascript:') || raw.startsWith('#')) return null
  try {
    if (raw.startsWith('//')) return `https:${raw}`
    return new URL(raw, base).toString()
  } catch {
    return null
  }
}

/** Bing 的 apiclick 链接里带 url=原文地址 */
export function unwrapBingUrl(href: string): string | null {
  const decoded = decodeEntities(href)
  try {
    const parsed = new URL(decoded)
    const target = parsed.searchParams.get('url')
    if (target) return target
  } catch {
    /* ignore */
  }
  return absoluteUrl(decoded)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function parseCnTime(label: string | null | undefined): string | null {
  if (!label) return null
  const raw = label.replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const now = Date.now()

  const minutes = raw.match(/(\d+)\s*分钟前/)
  if (minutes) return new Date(now - Number(minutes[1]) * 60_000).toISOString()
  const hours = raw.match(/(\d+)\s*小时前/)
  if (hours) return new Date(now - Number(hours[1]) * 3_600_000).toISOString()
  const days = raw.match(/(\d+)\s*天前/)
  if (days) return new Date(now - Number(days[1]) * 86_400_000).toISOString()
  if (raw.includes('刚刚') || raw.includes('刚才')) return new Date(now).toISOString()

  const today = raw.match(/今天\s*(\d{1,2}):(\d{2})/)
  if (today) {
    const date = new Date()
    date.setHours(Number(today[1]), Number(today[2]), 0, 0)
    return date.toISOString()
  }
  const yesterday = raw.match(/昨天\s*(\d{1,2}):(\d{2})/)
  if (yesterday) {
    const date = new Date(now - 86_400_000)
    date.setHours(Number(yesterday[1]), Number(yesterday[2]), 0, 0)
    return date.toISOString()
  }

  const full = raw.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\s*(\d{1,2}):(\d{2}))?/)
  if (full) {
    const date = new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4] ?? 0),
      Number(full[5] ?? 0),
    )
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const short = raw.match(/^(\d{1,2})[-/](\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?$/)
  if (short) {
    const date = new Date()
    date.setMonth(Number(short[1]) - 1, Number(short[2]))
    date.setHours(Number(short[3] ?? 0), Number(short[4] ?? 0), 0, 0)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function isFresh(iso: string | null, maxAgeHours: number): boolean {
  if (!iso) return true
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return true
  return Date.now() - time <= maxAgeHours * 3_600_000
}

export function normalizeTitle(title: string): string {
  return title
    .replace(/\s+/g, '')
    .replace(/[“”"'’‘《》【】\[\]（）()：:，,。.!！?？|/\\-]/g, '')
    .toLowerCase()
}
