import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPublicHost, WikiUrlError } from './url.js'

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * Cloudflare 的判定很看 UA：
 * - 浏览器 UA + 非浏览器 TLS 指纹 → 下发大体积 challenge
 * - 已知的 curl UA → 直接 429 限流
 * - 自定义的诚实 UA → 正常放行
 * 所以优先用自家 UA，被拒再依次退回 curl / 浏览器。
 */
const USER_AGENTS = [
  'ZenithFlowWikiReader/1.0',
  'curl/7.61.1',
  BROWSER_USER_AGENT,
]

/** wiki.gg 等站点会按 TLS 指纹拦截 Node 原生 fetch，这里统一走 curl */
const CURL_BIN = ['/usr/bin/curl', '/bin/curl', '/usr/local/bin/curl'].find((path) =>
  existsSync(path),
)

const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

export class WikiFetchError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'too_large' | 'http' | 'network' | 'blocked' = 'network',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'WikiFetchError'
  }
}

export type FetchResult = {
  status: number
  finalUrl: URL
  contentType: string
  body: Buffer
  redirected: boolean
}

type CurlRun = {
  code: number
  stdout: string
  stderr: string
}

function runCurl(args: string[], timeoutMs: number): Promise<CurlRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL_BIN as string, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new WikiFetchError('上游响应超时', 'timeout'))
    }, timeoutMs + 3000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new WikiFetchError(`无法执行 curl：${error.message}`, 'network'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

type CurlOnce = {
  status: number
  redirectUrl: string
  contentType: string
  body: Buffer
  cfMitigated: boolean
}

async function curlOnce(
  url: URL,
  options: {
    timeoutMs: number
    maxBytes: number
    accept: string
    userAgent: string
    headers?: Record<string, string>
  },
): Promise<CurlOnce> {
  if (!CURL_BIN) {
    throw new WikiFetchError('服务器缺少 curl，无法抓取上游页面', 'network')
  }

  const dir = await mkdtemp(join(tmpdir(), 'zf-wiki-'))
  const bodyPath = join(dir, 'body')
  const headerPath = join(dir, 'headers')

  try {
    const args = [
      '-sS',
      '--proto',
      '=http,https',
      '--max-redirs',
      '0',
      '--connect-timeout',
      '10',
      '--max-time',
      String(Math.max(5, Math.ceil(options.timeoutMs / 1000))),
      '--compressed',
      '--max-filesize',
      String(options.maxBytes),
      '-A',
      options.userAgent,
      '-H',
      'Accept-Language: zh-CN,zh;q=0.9,en;q=0.6',
      '-H',
      `Accept: ${options.accept}`,
      '-D',
      headerPath,
      '-o',
      bodyPath,
      '-w',
      '%{http_code}\n%{redirect_url}\n%{content_type}',
    ]

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      args.push('-H', `${name}: ${value}`)
    }

    args.push(url.href)

    const { code, stdout, stderr } = await runCurl(args, options.timeoutMs)

    // curl 退出码：63 = 超过 --max-filesize，28 = 超时
    if (code === 63) {
      const headersText = await readFile(headerPath, 'utf8').catch(() => '')
      // Cloudflare 的 challenge 响应会声明一个很大的体积，先交给换 UA 重试处理
      if (/cf-mitigated:\s*challenge/i.test(headersText)) {
        return {
          status: 403,
          redirectUrl: '',
          contentType: 'text/html',
          body: Buffer.alloc(0),
          cfMitigated: true,
        }
      }
      throw new WikiFetchError('页面体积超出限制', 'too_large')
    }
    if (code === 28) throw new WikiFetchError('上游响应超时', 'timeout')
    if (code !== 0) {
      throw new WikiFetchError(`抓取失败：${stderr.trim() || `curl exit ${code}`}`, 'network')
    }

    const [statusLine = '', redirectLine = '', ...rest] = stdout.split('\n')
    const status = Number.parseInt(statusLine, 10) || 0
    const body = await readFile(bodyPath).catch(() => Buffer.alloc(0))
    const headersText = await readFile(headerPath, 'utf8').catch(() => '')

    if (body.length > options.maxBytes) {
      throw new WikiFetchError('页面体积超出限制', 'too_large')
    }

    return {
      status,
      redirectUrl: redirectLine.trim(),
      contentType: (rest.join('\n') || '').trim(),
      body,
      cfMitigated: /cf-mitigated:\s*challenge/i.test(headersText),
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export type FetchOptions = {
  timeoutMs?: number
  maxBytes?: number
  accept?: string
  headers?: Record<string, string>
}

/** 被拒绝时换一个 UA 再试一次 */
function isChallengeResponse(result: CurlOnce): boolean {
  if (result.cfMitigated) return true
  return result.status === 403 || result.status === 429 || result.status === 503
}

/** 手动跟随重定向：每一跳都重新做 SSRF 校验，最多 3 跳 */
export async function fetchRaw(input: URL, options: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const accept =
    options.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'

  let current = input
  let redirected = false

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current)

    let result = await curlOnce(current, {
      timeoutMs,
      maxBytes,
      accept,
      userAgent: USER_AGENTS[0] as string,
      headers: options.headers,
    })

    for (let uaIndex = 1; uaIndex < USER_AGENTS.length; uaIndex += 1) {
      if (!isChallengeResponse(result)) break
      // 给限流一点点冷却时间，再换身份重试
      await new Promise((resolve) => setTimeout(resolve, 250))
      result = await curlOnce(current, {
        timeoutMs,
        maxBytes,
        accept,
        userAgent: USER_AGENTS[uaIndex] as string,
        headers: options.headers,
      })
    }

    if (result.status >= 300 && result.status < 400) {
      if (!result.redirectUrl) {
        throw new WikiFetchError(`上游返回 ${result.status} 但没有跳转地址`, 'http', result.status)
      }
      if (hop === MAX_REDIRECTS) {
        throw new WikiFetchError('重定向次数过多', 'network')
      }

      let next: URL
      try {
        next = new URL(result.redirectUrl, current)
      } catch {
        throw new WikiFetchError('上游返回了非法的跳转地址', 'http', result.status)
      }
      if (!/^https?:$/.test(next.protocol)) {
        throw new WikiFetchError('上游跳转到不支持的协议', 'blocked')
      }

      current = next
      redirected = true
      continue
    }

    return {
      status: result.status,
      finalUrl: current,
      contentType: result.contentType,
      body: result.body,
      redirected,
    }
  }

  throw new WikiFetchError('重定向次数过多', 'network')
}

function decodeBody(buffer: Buffer, contentType: string, override?: string): string {
  const charset =
    override ?? contentType.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase() ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

export async function fetchHtml(
  url: URL,
  options: FetchOptions = {},
): Promise<{ html: string; finalUrl: URL; status: number }> {
  const result = await fetchRaw(url, options)
  if (result.status >= 400) {
    throw new WikiFetchError(`上游返回 HTTP ${result.status}`, 'http', result.status)
  }
  return {
    html: decodeBody(result.body, result.contentType),
    finalUrl: result.finalUrl,
    status: result.status,
  }
}

export async function fetchJson<T>(
  url: URL,
  options: FetchOptions = {},
): Promise<{ data: T; finalUrl: URL; status: number }> {
  const result = await fetchRaw(url, {
    ...options,
    accept: 'application/json,text/javascript;q=0.9,*/*;q=0.8',
  })
  if (result.status >= 400) {
    throw new WikiFetchError(`上游返回 HTTP ${result.status}`, 'http', result.status)
  }
  const text = decodeBody(result.body, result.contentType).trim()
  try {
    return {
      data: JSON.parse(text) as T,
      finalUrl: result.finalUrl,
      status: result.status,
    }
  } catch {
    throw new WikiFetchError('上游返回的不是合法 JSON', 'network')
  }
}

/** 所有对上游的请求串行 + 间隔，避免高频点击把源站打出风控 */
const REQUEST_GAP_MS = 150
let chain: Promise<void> = Promise.resolve()
let lastAt = 0

export function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = REQUEST_GAP_MS - (Date.now() - lastAt)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastAt = Date.now()
    return fn()
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export { WikiUrlError }
