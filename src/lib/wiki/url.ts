import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class WikiUrlError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'blocked' = 'invalid',
  ) {
    super(message)
    this.name = 'WikiUrlError'
  }
}

/** 允许直接访问的协议 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * 用户粘贴的地址可能没有协议，补成 https。
 * 只接受 http/https（阻止 file: / gopher: / data: 等）
 */
export function normalizeInputUrl(raw: string): URL {
  const input = raw.trim()
  if (!input) throw new WikiUrlError('请输入网址')

  let candidate = input
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new WikiUrlError('网址格式不正确')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new WikiUrlError('只支持 http / https 网址')
  }
  if (!url.hostname) throw new WikiUrlError('网址缺少域名')

  url.hash = ''
  return url
}

/** IPv4 保留 / 内网段 */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16（含云元数据 169.254.169.254）
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0000200, 24], // 192.0.2/24
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15
  [0xc6336400, 24], // 198.51.100/24
  [0xcb007100, 24], // 203.0.113/24
  [0xe0000000, 4], // 224/4 组播
  [0xf0000000, 4], // 240/4 保留
]

function ipv4ToInt(address: string): number {
  const [a = 0, b = 0, c = 0, d = 0] = address.split('.').map(Number)
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

function isBlockedV4(address: string): boolean {
  const value = ipv4ToInt(address)
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (value & mask) === (base & mask)
  })
}

function isBlockedV6(address: string): boolean {
  const lower = (address.toLowerCase().split('%')[0] ?? '').trim()

  if (lower === '::' || lower === '::1') return true
  // IPv4 映射地址 ::ffff:1.2.3.4
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isBlockedV4(mapped[1])
  // fc00::/7 唯一本地地址
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true
  // fe80::/10 链路本地
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
  // ff00::/8 组播
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true
  return false
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isBlockedV4(address)
  if (version === 6) return isBlockedV6(address)
  return true
}

/** 目标主机是否允许访问（防 SSRF：拒绝回环 / 内网 / 云元数据 / 保留地址） */
export async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new WikiUrlError('不允许访问本机地址', 'blocked')
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new WikiUrlError('不允许访问内网或保留地址', 'blocked')
    }
    return
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new WikiUrlError(`无法解析域名：${hostname}`)
  }

  if (!addresses.length) throw new WikiUrlError(`无法解析域名：${hostname}`)

  for (const item of addresses) {
    if (isBlockedAddress(item.address)) {
      throw new WikiUrlError('该域名解析到内网或保留地址，已拒绝', 'blocked')
    }
  }
}

/** 同站判断：忽略 www. 前缀，协议不做强制 */
export function isSameSite(a: URL, b: URL): boolean {
  const strip = (host: string) => host.toLowerCase().replace(/^www\./, '')
  return strip(a.hostname) === strip(b.hostname)
}

/** 把链接解析成绝对地址；非法或不可处理的协议返回 null */
export function resolveHref(href: string, base: URL): URL | null {
  const raw = href.trim()
  if (!raw) return null
  if (raw.startsWith('#')) return null

  try {
    const url = new URL(raw, base)
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
    return url
  } catch {
    return null
  }
}
