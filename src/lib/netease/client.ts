import { createSign } from 'node:crypto'
import { config } from '../../config.js'

/**
 * 网易云开放平台客户端。
 *
 * 签名规则（实测）：
 *   1. 取 accessToken / appId / bizContent / device / signType / timestamp 六个参数
 *   2. 按 key 字母序拼成 `k=v&k=v`（业务参数只放 bizContent，不能额外拼 URL query）
 *   3. sign = base64(RSA-SHA256(应用私钥, 原文))
 *   4. 六个参数 + sign 全部放 query
 *
 * 注意：accessToken 即使为空字符串也必须参与签名并出现在 query 里，否则报 1402。
 */

const BASE_URL = 'https://openncm.music.163.com'
const APP_ID = config.NETEASE_APP_ID
const PRIVATE_KEY = Buffer.from(config.NETEASE_APP_KEY_B64, 'base64').toString('utf8')

const DEVICE = JSON.stringify({
  deviceType: 'openapi',
  os: 'ncmcli',
  appVer: '0.1.7',
  channel: 'ncmcli',
  model: 'Linux_x64_cli',
  brand: 'ncmcli',
  osVer: '4.18.0-240.10.1.el8_3.x86_64',
  clientIp: config.NETEASE_CLIENT_IP,
  deviceId: config.NETEASE_DEVICE_ID,
})

export const NETEASE_APP_ID = APP_ID

/** 业务错误码：1408 = token 失效（官方文案是「账户已封禁或注销」），2509 = 缺 accessToken */
export class NeteaseError extends Error {
  code: number

  constructor(message: string, code = 0) {
    super(message)
    this.name = 'NeteaseError'
    this.code = code
  }

  get isAuthError(): boolean {
    return this.code === 1408 || this.code === 2509 || this.code === 301
  }
}

type Params = Record<string, unknown>

function buildQuery(biz: Params, accessToken: string): string {
  const timestamp = String(Date.now())
  const bizContent = JSON.stringify(biz)
  const payload: Record<string, string> = {
    accessToken,
    appId: APP_ID,
    bizContent,
    device: DEVICE,
    signType: 'RSA_SHA256',
    timestamp,
  }
  const plain = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key] ?? ''}`)
    .join('&')
  const sign = createSign('SHA256').update(plain).sign(PRIVATE_KEY, 'base64')

  const search = new URLSearchParams({
    appId: APP_ID,
    signType: 'RSA_SHA256',
    timestamp,
    device: DEVICE,
    bizContent,
    accessToken,
    sign,
  })
  return search.toString()
}

function assertKey() {
  if (!PRIVATE_KEY || !PRIVATE_KEY.includes('BEGIN')) {
    throw new NeteaseError('未配置 NETEASE_APP_KEY_B64（应用私钥）')
  }
}

export type NeteaseEnvelope<T> = {
  code: number
  subCode?: number | null
  message?: string | null
  msg?: string | null
  data: T
}

type RequestOptions = {
  /** 业务码白名单：命中时不抛错，交给调用方处理（如轮询的 801 / 800） */
  allowCodes?: number[]
  retries?: number
  timeoutMs?: number
}

export async function neteaseRequest<T>(
  path: string,
  method: 'GET' | 'POST',
  biz: Params,
  accessToken: string,
  options: RequestOptions = {},
): Promise<NeteaseEnvelope<T>> {
  assertKey()
  const query = buildQuery(biz, accessToken)
  const retries = options.retries ?? 3
  const timeoutMs = options.timeoutMs ?? 15_000
  let lastError: unknown = null

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}${path}?${query}`, {
        method,
        headers: { 'User-Agent': 'ncm-0.1.7', Referer: 'https://music.163.com' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      let body: NeteaseEnvelope<T>
      try {
        body = JSON.parse(text) as NeteaseEnvelope<T>
      } catch {
        throw new NeteaseError(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
      }

      if (body.code === 200) return body
      if (options.allowCodes?.includes(body.code)) return body

      throw new NeteaseError(body.message || body.msg || `接口错误 ${body.code}`, body.code)
    } catch (error) {
      lastError = error
      // 业务错误不重试，只有网络类异常才重试
      if (error instanceof NeteaseError) throw error
      if (attempt === retries - 1) break
      await new Promise((resolve) => setTimeout(resolve, 600 + attempt * 500))
    }
  }

  throw new NeteaseError(
    `网易云接口网络异常：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/** 匿名 token：扫码登录的「前置身份」，有效期 24h，进程内缓存 */
let anonymousToken: { token: string; expireAt: number } | null = null

export async function getAnonymousToken(): Promise<string> {
  if (anonymousToken && anonymousToken.expireAt - Date.now() > 60_000) {
    return anonymousToken.token
  }
  const res = await neteaseRequest<{ accessToken: string; expireTime: number }>(
    '/openapi/music/basic/oauth2/login/anonymous',
    'POST',
    { clientId: APP_ID },
    '',
  )
  const token = res.data?.accessToken
  if (!token) throw new NeteaseError('匿名登录失败：未返回 accessToken')
  // expireTime 单位是秒
  const ttl = (res.data?.expireTime ?? 86_400) * 1000
  anonymousToken = { token, expireAt: Date.now() + ttl }
  return token
}

export function resetAnonymousToken() {
  anonymousToken = null
}

export type QrKey = { qrCodeUrl: string; uniKey: string }

export async function createQrKey(): Promise<QrKey> {
  const token = await getAnonymousToken()
  const res = await neteaseRequest<QrKey>(
    '/openapi/music/basic/user/oauth2/qrcodekey/get/v2',
    'GET',
    { type: 2, expiredKey: '300' },
    token,
  )
  if (!res.data?.uniKey) throw new NeteaseError('二维码生成失败')
  return res.data
}

export type QrPollResult = {
  status: number
  message: string
  accessToken: string | null
}

export async function pollQrKey(uniKey: string): Promise<QrPollResult> {
  const token = await getAnonymousToken()
  const res = await neteaseRequest<{ status?: number; msg?: string; accessToken?: string | null }>(
    '/openapi/music/basic/oauth2/device/login/qrcode/get',
    'GET',
    { key: uniKey, clientId: APP_ID },
    token,
    { allowCodes: [400, 800, 801, 802, 803] },
  )
  if (res.code !== 200) {
    // 400「device has login success」/ 过期等：统一折算成「二维码失效」，由前端刷新
    return { status: res.code === 400 ? 800 : res.code, message: res.message || '', accessToken: null }
  }
  return {
    status: res.data?.status ?? 0,
    message: res.data?.msg ?? '',
    accessToken: res.data?.accessToken ?? null,
  }
}
