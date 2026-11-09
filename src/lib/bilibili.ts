import { createHash } from 'node:crypto'

const BASE = 'https://api.bilibili.com'
/** 扫码登录走 passport 域名 */
const PASSPORT_BASE = 'https://passport.bilibili.com'
/** App 版接口：网页版 UP 空间接口对本机 IP 会 412 / -352，投稿列表只能走 App */
const APP_BASE = 'https://app.bilibili.com'
const REFERER = 'https://www.bilibili.com/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
/** B 站安卓客户端公开的 appkey / appsecret（非账号凭据） */
const APP_KEY = '1d8b6e7d45233436'
const APP_SECRET = '560c52ccd288fed045859ed18bffd973'
const APP_USER_AGENT =
  'Mozilla/5.0 BiliDroid/7.30.0 (bbcallen@gmail.com) os/android model/Pixel mobi_app/android build/7300000 channel/master innerVer/7300000 osVer/12 network/2'

/** B 站主评论接口单次最多返回 30 条 */
export const COMMENT_PAGE_SIZE = 30
/** 子评论接口单次最多返回 20 条 */
export const SUB_REPLY_PAGE_SIZE = 10
/** 关系图接口按 20 条/页拉取，减少请求次数 */
const THREAD_PAGE_SIZE = 20
const THREAD_DEFAULT_LIMIT = 200
const THREAD_MAX_LIMIT = 800
const THREAD_TTL = 2 * 60 * 1000
/** 最多缓存多少个楼中楼，避免常驻内存无限增长 */
const THREAD_CACHE_LIMIT = 40

/** 「最新」排序游标只能顺序前进，单次最多补走的页数 */
const MAX_LATEST_WALK = 20
const LATEST_CHAIN_TTL = 5 * 60 * 1000

const VIDEO_TTL = 10 * 60 * 1000
const COMMENT_TTL = 60 * 1000
const SUB_REPLY_TTL = 2 * 60 * 1000
/** B 站的 all_count 含子回复，页数需要探测，缓存久一点 */
const PAGE_COUNT_TTL = 6 * 60 * 60 * 1000
const PROBE_TTL = 5 * 60 * 1000
const CACHE_LIMIT = 300

export class BiliError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'BiliError'
    this.status = status
  }
}

export type BiliComment = {
  rpid: string
  mid: string
  uname: string
  message: string
  pictureCount: number
  like: number
  ctime: number
  replyCount: number
  isUp: boolean
  /** 子评论回复其他子评论时的目标用户；直接回复主评论时为 null */
  replyTo: { mid: string; uname: string } | null
}

/** 关系图节点：在普通评论字段上补出父子关系 */
export type ThreadComment = BiliComment & {
  parentRpid: string
  rootRpid: string
}

export type BiliThread = {
  rootRpid: string
  targetRpid: string
  /** 包含主评论和已拉取的子评论 */
  nodes: ThreadComment[]
  /** 楼中楼子评论总数（不含主评论） */
  total: number
  /** 是否因为 limit 截断，还有更靠后的评论没拉 */
  truncated: boolean
}

export type BiliVideo = {
  bvid: string
  aid: number
  title: string
  ownerMid: string
  ownerName: string
  cover: string
  pubdate: number
  duration: number
  commentCount: number
}

export type CommentPage = {
  comments: BiliComment[]
  page: number
  size: number
  total: number
  totalPages: number
  /** totalPages 是否是探测到的精确值（否则是根据回复占比估算） */
  pagesExact: boolean
  hasMore: boolean
}

type CacheEntry = { expiresAt: number; value: unknown }
const memoryCache = new Map<string, CacheEntry>()

function cacheGet<T>(key: string): T | undefined {
  const entry = memoryCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key)
    return undefined
  }
  return entry.value as T
}

function cacheSet<T>(key: string, value: T, ttlMs: number) {
  if (memoryCache.size >= CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value
    if (oldest !== undefined) memoryCache.delete(oldest)
  }
  memoryCache.set(key, { expiresAt: Date.now() + ttlMs, value })
}

type ApiEnvelope<T> = {
  code: number
  message: string
  data: T
}

type CookieState = { value: string; expiresAt: number }
let cookieState: CookieState | null = null

async function getCookie(force = false): Promise<string> {
  if (!force && cookieState && cookieState.expiresAt > Date.now()) {
    return cookieState.value
  }

  const res = await fetch(`${BASE}/x/frontend/finger/spi`, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new BiliError(502, `获取 B 站访问凭据失败（HTTP ${res.status}）`)

  const body = (await res.json()) as {
    code: number
    data?: { b_3?: string; b_4?: string }
  }
  const b3 = body.data?.b_3
  const b4 = body.data?.b_4
  if (body.code !== 0 || !b3) throw new BiliError(502, '获取 B 站访问凭据失败')

  const value = b4 ? `buvid3=${b3}; buvid4=${b4}` : `buvid3=${b3}`
  cookieState = { value, expiresAt: Date.now() + 60 * 60 * 1000 }
  return value
}

function codeToStatus(code: number): number {
  if (code === -404) return 404
  if (code === -400) return 400
  if (code === -403) return 403
  if (code === -101) return 401
  return 502
}

function codeToMessage(code: number, message: string): string {
  if (code === -404) return '视频不存在或评论已关闭'
  if (code === -403) return 'B 站拒绝访问，请稍后再试'
  if (code === -101) return 'B 站账号未登录或登录已过期'
  if (code === -400) return message || 'B 站接口参数异常'
  return `B 站接口异常（${message || code}）`
}

/** 写操作（点赞/评论）错误码 → HTTP 状态 */
function writeCodeToStatus(code: number): number {
  if (code === -101 || code === -102 || code === -111) return 401
  if (code === -400) return 400
  if (code === -404 || code === 12006) return 404
  if (code === -509) return 429
  if (code === 12002 || code === 12052) return 409
  if (code === 12003 || code === 12004 || code === 12035 || code === 12045) return 403
  return 502
}

function writeCodeToMessage(code: number, message: string): string {
  switch (code) {
    case -101:
      return 'B 站登录已失效，请重新扫码绑定'
    case -102:
      return 'B 站账号已被封停，无法操作'
    case -111:
      return 'B 站登录凭据校验失败，请重新扫码绑定'
    case -400:
      return 'B 站接口参数异常，请稍后再试'
    case -404:
      return '目标评论或视频不存在'
    case -509:
      return '操作过于频繁，请稍后再试'
    case 12002:
    case 12052:
      return '评论区已关闭'
    case 12003:
      return 'UP 主已禁止回复'
    case 12004:
      return '该评论禁止点赞'
    case 12006:
      return '评论不存在或已被删除'
    case 12009:
      return '评论区类型不合法'
    case 12011:
      return '点赞操作不合法'
    case 12015:
      return 'B 站要求完成验证码，请先到 B 站网页/App 完成验证'
    case 12016:
      return '内容包含敏感信息，已被 B 站拦截'
    case 12025:
      return '评论内容过长（最多 1000 字）'
    case 12035:
      return '你已被 UP 主列入评论黑名单'
    case 12045:
      return '该视频需要购买后才能发表评论'
    case 12051:
      return '重复评论或操作过快，请稍后再试'
    default:
      return `B 站评论操作失败（${message || code}）`
  }
}

/** B 站对短时间内的密集请求很敏感，所有出站请求串行并保持 200ms 间隔 */
const MIN_REQUEST_INTERVAL = 200
let requestChain: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestChain.then(async () => {
    const wait = MIN_REQUEST_INTERVAL - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    try {
      return await fn()
    } finally {
      lastRequestAt = Date.now()
    }
  })
  requestChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** WBI 签名的混淆表（B 站前端固定） */
const WBI_MIXIN_KEY_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let wbiCache: { mixinKey: string; expiresAt: number } | null = null

function wbiEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

async function getWbiMixinKey(force = false): Promise<string> {
  if (!force && wbiCache && wbiCache.expiresAt > Date.now()) return wbiCache.mixinKey

  const res = await scheduleRequest(() =>
    fetch(`${BASE}/x/web-interface/nav`, {
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
      signal: AbortSignal.timeout(10000),
    }),
  )
  if (!res.ok) throw new BiliError(502, `获取 B 站签名参数失败（HTTP ${res.status}）`)

  const body = (await res.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const imgUrl = body.data?.wbi_img?.img_url ?? ''
  const subUrl = body.data?.wbi_img?.sub_url ?? ''
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0] ?? ''
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0] ?? ''
  if (!imgKey || !subKey) throw new BiliError(502, '获取 B 站签名参数失败')

  const raw = imgKey + subKey
  const mixinKey = WBI_MIXIN_KEY_TAB.map((index) => raw.charAt(index)).join('').slice(0, 32)
  wbiCache = { mixinKey, expiresAt: Date.now() + 60 * 60 * 1000 }
  return mixinKey
}

async function signWbiUrl(url: URL): Promise<void> {
  const mixinKey = await getWbiMixinKey()
  url.searchParams.set('wts', String(Math.floor(Date.now() / 1000)))

  const query = [...url.searchParams.keys()]
    .sort()
    .map((key) => `${key}=${wbiEncode(url.searchParams.get(key) ?? '')}`)
    .join('&')

  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  url.searchParams.set('w_rid', wRid)
}

async function requestJson<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  options: { cookie?: boolean; cookieValue?: string; signed?: boolean } = {},
): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Referer: REFERER,
        Accept: 'application/json, text/plain, */*',
      }
      // 评论接口带上 buvid 反而会返回降级数据（只有 3 条），只有视频信息接口需要
      if (options.cookieValue) headers.Cookie = options.cookieValue
      else if (options.cookie) headers.Cookie = await getCookie(attempt > 0)
      if (options.signed) await signWbiUrl(url)

      const res = await scheduleRequest(() =>
        fetch(url, {
          headers,
          signal: AbortSignal.timeout(12000),
        }),
      )

      // 412 是 B 站的 IP/凭据风控，退避后换一份 buvid 再试一次
      if (res.status === 412) {
        if (attempt === 0) {
          await sleep(800)
          continue
        }
        throw new BiliError(503, 'B 站临时限流，请稍后再试')
      }
      if (!res.ok) throw new BiliError(502, `B 站接口返回异常（HTTP ${res.status}）`)

      const body = (await res.json()) as ApiEnvelope<T>
      if (body.code !== 0) {
        if ((body.code === -412 || body.code === -352) && attempt === 0) {
          await sleep(800)
          continue
        }
        if (body.code === -412 || body.code === -352) {
          throw new BiliError(503, 'B 站临时限流，请稍后再试')
        }
        throw new BiliError(codeToStatus(body.code), codeToMessage(body.code, body.message))
      }
      return body.data
    } catch (err) {
      lastError = err
      if (err instanceof BiliError) throw err
      if (attempt === 0) continue
    }
  }

  if (lastError instanceof BiliError) throw lastError
  throw new BiliError(502, '无法连接 B 站接口，请稍后再试')
}

/**
 * 需要登录态的写接口：POST 表单 + 账号 Cookie + csrf。
 * 只在 412 / -412 / -352 这类「请求未执行」的风控响应上重试一次，
 * 网络超时等不确定结果不重试，避免重复发评论。
 */
async function requestFormJson<T>(
  path: string,
  params: Record<string, string | number>,
  cookieHeader: string,
): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) body.set(key, String(value))

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response
    try {
      res = await scheduleRequest(() =>
        fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            Referer: REFERER,
            Origin: 'https://www.bilibili.com',
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieHeader,
          },
          body: body.toString(),
          signal: AbortSignal.timeout(12000),
        }),
      )
    } catch {
      throw new BiliError(502, '无法连接 B 站接口，请稍后再试')
    }

    if (res.status === 412) {
      if (attempt === 0) {
        await sleep(800)
        continue
      }
      throw new BiliError(503, 'B 站临时限流，请稍后再试')
    }
    if (!res.ok) throw new BiliError(502, `B 站接口返回异常（HTTP ${res.status}）`)

    const data = (await res.json()) as ApiEnvelope<T>
    if (data.code === 0) return data.data
    if ((data.code === -412 || data.code === -352) && attempt === 0) {
      await sleep(800)
      continue
    }
    if (data.code === -412 || data.code === -352) {
      throw new BiliError(503, 'B 站临时限流，请稍后再试')
    }
    throw new BiliError(
      writeCodeToStatus(data.code),
      writeCodeToMessage(data.code, data.message),
    )
  }

  throw new BiliError(503, 'B 站临时限流，请稍后再试')
}

export type CommentLikeAction = 0 | 1

/** 点赞 / 取消点赞一条评论 */
export async function likeBiliComment(
  cookieHeader: string,
  csrf: string,
  aid: number,
  rpid: string,
  action: CommentLikeAction,
): Promise<void> {
  await requestFormJson(
    '/x/v2/reply/action',
    { oid: aid, type: 1, rpid, action, csrf },
    cookieHeader,
  )
}

export type BiliCreatedComment = {
  rpid: string
  /** B 站返回的完整评论对象；部分情况下为空，前端可自行拼一条本地回显 */
  comment: BiliComment | null
}

/** 发表评论 / 回复评论（root、parent 都为 0 时是顶层评论） */
export async function createBiliComment(
  video: BiliVideo,
  cookieHeader: string,
  csrf: string,
  message: string,
  root = '0',
  parent = '0',
): Promise<BiliCreatedComment> {
  const params: Record<string, string | number> = {
    oid: video.aid,
    type: 1,
    message,
    plat: 1,
    csrf,
  }
  if (root !== '0') params.root = root
  if (parent !== '0') params.parent = parent

  const data = await requestFormJson<{
    rpid?: number | string
    rpid_str?: string
    reply?: RawReply | null
  }>('/x/v2/reply/add', params, cookieHeader)

  const rpid = String(data.rpid_str ?? data.rpid ?? '')
  return {
    rpid,
    comment: data.reply ? normalizeComment(data.reply, video.ownerMid) : null,
  }
}

function appCodeToMessage(code: number, message: string): string {
  if (code === -404) return 'UP 主不存在或已被封禁'
  if (code === -403) return 'B 站拒绝访问，请稍后再试'
  return `B 站接口异常（${message || code}）`
}

/** App 版接口：查询串按 key 排序后拼 appsecret 做 md5 签名 */
async function requestAppJson<T>(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const query = Object.entries({
        ...params,
        appkey: APP_KEY,
        ts: String(Math.floor(Date.now() / 1000)),
      })
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join('&')
      const sign = createHash('md5').update(query + APP_SECRET).digest('hex')
      const url = `${APP_BASE}${path}?${query}&sign=${sign}`

      const res = await scheduleRequest(() =>
        fetch(url, {
          headers: {
            'User-Agent': APP_USER_AGENT,
            Accept: 'application/json, text/plain, */*',
          },
          signal: AbortSignal.timeout(12000),
        }),
      )

      if (res.status === 412) {
        if (attempt === 0) {
          await sleep(800)
          continue
        }
        throw new BiliError(503, 'B 站临时限流，请稍后再试')
      }
      if (!res.ok) throw new BiliError(502, `B 站接口返回异常（HTTP ${res.status}）`)

      const body = (await res.json()) as ApiEnvelope<T>
      if (body.code !== 0) {
        if ((body.code === -412 || body.code === -352) && attempt === 0) {
          await sleep(800)
          continue
        }
        if (body.code === -412 || body.code === -352) {
          throw new BiliError(503, 'B 站临时限流，请稍后再试')
        }
        throw new BiliError(codeToStatus(body.code), appCodeToMessage(body.code, body.message))
      }
      return body.data
    } catch (err) {
      lastError = err
      if (err instanceof BiliError) throw err
      if (attempt === 0) continue
    }
  }

  if (lastError instanceof BiliError) throw lastError
  throw new BiliError(502, '无法连接 B 站接口，请稍后再试')
}

/** B 站视频地址、BV 号、av 号都能解析；b23.tv 短链会跟随跳转 */
async function parseVideoInput(raw: string): Promise<{ bvid?: string; aid?: number }> {
  const input = raw.trim()
  let text = input

  if (/^https?:\/\//i.test(input) && /b23\.tv|bili2233\.cn/i.test(input)) {
    try {
      const res = await fetch(input, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000),
      })
      if (res.url) text = res.url
    } catch {
      throw new BiliError(400, '短链解析失败，请直接填写 BV 号')
    }
  }

  const bvMatch = text.match(/(BV[0-9A-Za-z]{10})/)
  if (bvMatch?.[1]) return { bvid: bvMatch[1] }

  const avMatch = text.match(/av(\d+)/i)
  if (avMatch?.[1]) return { aid: Number(avMatch[1]) }

  if (/^\d{1,19}$/.test(text)) return { aid: Number(text) }

  throw new BiliError(400, '无法识别输入，请填写 B 站视频链接、BV 号或 av 号')
}

type ViewData = {
  bvid: string
  aid: number
  title: string
  pic: string
  pubdate: number
  duration: number
  owner?: { mid?: number | string; name?: string }
  stat?: { reply?: number }
}

export async function resolveVideo(input: string): Promise<BiliVideo> {
  const ref = await parseVideoInput(input)
  const cacheKey = ref.bvid ? `video:bv:${ref.bvid}` : `video:av:${ref.aid}`
  const cached = cacheGet<BiliVideo>(cacheKey)
  if (cached) return cached

  const data = await requestJson<ViewData>(
    '/x/web-interface/view',
    ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid },
    { cookie: true },
  )

  const video: BiliVideo = {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    ownerMid: String(data.owner?.mid ?? ''),
    ownerName: data.owner?.name ?? '',
    cover: data.pic ?? '',
    pubdate: data.pubdate ?? 0,
    duration: data.duration ?? 0,
    commentCount: data.stat?.reply ?? 0,
  }

  cacheSet(cacheKey, video, VIDEO_TTL)
  cacheSet(`video:aid:${video.aid}`, video, VIDEO_TTL)
  return video
}

type RawReply = {
  rpid?: number | string
  mid?: number | string
  like?: number
  ctime?: number
  rcount?: number
  parent?: number | string
  root?: number | string
  member?: { mid?: number | string; uname?: string }
  content?: {
    message?: string
    pictures?: unknown[]
    members?: Array<{ mid?: number | string; uname?: string }>
  }
}

function normalizeComment(raw: RawReply, ownerMid: string): BiliComment {
  const mid = String(raw.member?.mid ?? raw.mid ?? '')
  const rawMessage = raw.content?.message ?? ''
  const parent = Number(raw.parent ?? 0)
  const root = Number(raw.root ?? 0)
  const members = raw.content?.members ?? []

  let message = rawMessage
  let replyTo: { mid: string; uname: string } | null = null

  // 只有「回复其他子评论」才会带 members 和「回复 @xxx :」前缀；
  // 直接回复主评论（parent === root）B 站本身也不显示回复对象。
  if (parent !== 0 && root !== 0 && parent !== root) {
    const match = rawMessage.match(/^回复\s*@([^:：]{1,40})\s*[:：]\s*/)
    const target = members[0]
    if (target?.uname) {
      replyTo = { mid: String(target.mid ?? ''), uname: target.uname }
      if (match) message = rawMessage.slice(match[0].length)
    } else if (match?.[1]) {
      replyTo = { mid: '', uname: match[1].trim() }
      message = rawMessage.slice(match[0].length)
    }
  }

  return {
    rpid: String(raw.rpid ?? ''),
    mid,
    uname: raw.member?.uname ?? '',
    message,
    pictureCount: raw.content?.pictures?.length ?? 0,
    like: raw.like ?? 0,
    ctime: raw.ctime ?? 0,
    replyCount: raw.rcount ?? 0,
    isUp: Boolean(mid) && mid === ownerMid,
    replyTo,
  }
}

/** 热门排序的 offset 是 protobuf：{ 1: 1, 4: { 1: page } } */
function hotPageOffset(page: number): string {
  const varint = (value: number): Buffer => {
    const bytes: number[] = []
    let rest = value
    while (true) {
      const byte = rest & 0x7f
      rest >>>= 7
      bytes.push(rest ? byte | 0x80 : byte)
      if (!rest) break
    }
    return Buffer.from(bytes)
  }

  const inner = Buffer.concat([Buffer.from([0x08]), varint(page)])
  const body = Buffer.concat([
    Buffer.from([0x08, 0x01, 0x22]),
    varint(inner.length),
    inner,
  ])
  return body.toString('base64')
}

type ReplyPageData = {
  replies?: RawReply[] | null
  root?: RawReply | null
  page?: { count?: number; size?: number; num?: number } | null
  cursor?: {
    is_end?: boolean
    all_count?: number
    pagination_reply?: { next_offset?: string }
  } | null
}

export type CommentSort = 'hot' | 'latest'

type LatestChain = {
  /** offsets[i] 是抓取第 i+1 页要用的游标 */
  offsets: string[]
  fetchedPage: number
  isEnd: boolean
  allCount: number
  updatedAt: number
}

const latestChains = new Map<number, LatestChain>()

function emptyChain(): LatestChain {
  return { offsets: [''], fetchedPage: 0, isEnd: false, allCount: 0, updatedAt: Date.now() }
}

async function fetchLatestOffset(aid: number, page: number): Promise<string> {
  let chain = latestChains.get(aid)
  const now = Date.now()
  if (!chain || now - chain.updatedAt > LATEST_CHAIN_TTL || page < chain.fetchedPage) {
    chain = emptyChain()
    latestChains.set(aid, chain)
  }

  // 已经缓存过的页，直接用现成游标
  if (page <= chain.offsets.length) {
    chain.updatedAt = now
    return chain.offsets[page - 1] ?? ''
  }

  if (page - chain.fetchedPage > MAX_LATEST_WALK) {
    throw new BiliError(400, `「最新」排序只能顺序翻页，单次最多前进 ${MAX_LATEST_WALK} 页`)
  }

  while (chain.fetchedPage < page - 1 && !chain.isEnd) {
    const offset = chain.offsets[chain.fetchedPage] ?? ''
    const data = await requestJson<ReplyPageData>(
      '/x/v2/reply/wbi/main',
      {
        oid: aid,
        type: 1,
        mode: 2,
        pagination_str: JSON.stringify({ offset }),
        plat: 1,
        web_location: 1315875,
        ps: COMMENT_PAGE_SIZE,
      },
      { signed: true },
    )

    const next = data.cursor?.pagination_reply?.next_offset
    chain.fetchedPage += 1
    chain.allCount = data.cursor?.all_count ?? chain.allCount
    if (next) chain.offsets[chain.fetchedPage] = next
    else chain.isEnd = true
    chain.updatedAt = Date.now()
  }

  if (chain.isEnd && page > chain.fetchedPage) {
    throw new BiliError(404, '已经是最新评论的最后一页')
  }

  return chain.offsets[page - 1] ?? ''
}

type PageCountState = { pages: number; exact: boolean; total: number; updatedAt: number }

/**
 * B 站的 all_count 含楼中楼，不能直接当一级评论数用（否则会多出一堆空页）。
 * 这里用当前页的平均子回复数估算一级评论页数，等真正翻到最后一页（is_end）再收敛为精确值。
 */
function estimateTotalPages(total: number, replies: RawReply[]): number {
  if (total <= 0) return 0
  const avg =
    replies.length > 0
      ? replies.reduce((sum, reply) => sum + (reply.rcount ?? 0), 0) / replies.length
      : 0
  const topLevel = total / (1 + avg)
  return Math.max(1, Math.ceil(topLevel / COMMENT_PAGE_SIZE))
}

/** 探测热门排序的某一页是否有内容 */
async function pageHasReplies(video: BiliVideo, page: number): Promise<boolean> {
  const key = `probe:${video.aid}:${page}`
  const cached = cacheGet<boolean>(key)
  if (cached !== undefined) return cached

  const data = await requestJson<ReplyPageData>(
    '/x/v2/reply/wbi/main',
    {
      oid: video.aid,
      type: 1,
      mode: 3,
      pagination_str: JSON.stringify({ offset: hotPageOffset(page) }),
      plat: 1,
      web_location: 1315875,
      ps: COMMENT_PAGE_SIZE,
    },
    { signed: true },
  )
  const ok = (data.replies?.length ?? 0) > 0
  cacheSet(key, ok, PROBE_TTL)
  return ok
}

/**
 * all_count 含楼中楼，直接算页数会多出一堆空页。
 * 热门 offset 可以直接构造，这里二分探测真正能翻到第几页；探测失败时退回估算值。
 */
async function resolveTotalPages(
  video: BiliVideo,
  total: number,
  replies: RawReply[],
): Promise<{ pages: number; exact: boolean }> {
  if (total <= 0) return { pages: 0, exact: true }

  const key = `pages:${video.aid}`
  const cached = cacheGet<PageCountState>(key)
  if (cached) return { pages: cached.pages, exact: cached.exact }

  const upper = Math.max(1, Math.ceil(total / COMMENT_PAGE_SIZE))
  if (upper === 1) {
    cacheSet(
      key,
      { pages: 1, exact: true, total, updatedAt: Date.now() },
      PAGE_COUNT_TTL,
    )
    return { pages: 1, exact: true }
  }

  try {
    let pages = upper
    if (!(await pageHasReplies(video, upper))) {
      let lo = 1
      let hi = upper
      while (lo + 1 < hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (await pageHasReplies(video, mid)) lo = mid
        else hi = mid
      }
      pages = lo
    }
    cacheSet(
      key,
      { pages, exact: true, total, updatedAt: Date.now() },
      PAGE_COUNT_TTL,
    )
    return { pages, exact: true }
  } catch {
    const pages = estimateTotalPages(total, replies)
    cacheSet(
      key,
      { pages, exact: false, total, updatedAt: Date.now() },
      5 * 60 * 1000,
    )
    return { pages, exact: false }
  }
}

export async function fetchComments(
  video: BiliVideo,
  page: number,
  sort: CommentSort,
): Promise<CommentPage> {
  const pageStateKey = `pages:${video.aid}`
  const pageState = cacheGet<PageCountState>(pageStateKey)

  // 已经有页数缓存时，先把超出范围的页码夹回来，避免白跑一次请求
  let requestPage = page
  if (pageState && pageState.pages > 0) {
    requestPage = Math.min(page, pageState.pages)
  }

  const cacheKey = `comments:${video.aid}:${sort}:${requestPage}:${video.ownerMid}`
  const cached = cacheGet<CommentPage>(cacheKey)
  if (cached) return cached

  const loadPage = async (target: number): Promise<ReplyPageData> => {
    const offset =
      sort === 'hot' ? hotPageOffset(target) : await fetchLatestOffset(video.aid, target)
    return requestJson<ReplyPageData>(
      '/x/v2/reply/wbi/main',
      {
        oid: video.aid,
        type: 1,
        mode: sort === 'hot' ? 3 : 2,
        pagination_str: JSON.stringify({ offset }),
        plat: 1,
        web_location: 1315875,
        ps: COMMENT_PAGE_SIZE,
      },
      { signed: true },
    )
  }

  let data = await loadPage(requestPage)
  let total = data.cursor?.all_count ?? data.page?.count ?? 0
  const resolved = pageState
    ? { pages: pageState.pages, exact: pageState.exact }
    : await resolveTotalPages(video, total, data.replies ?? [])
  let totalPages = resolved.pages
  let pagesExact = resolved.exact

  // 页码超出实际可翻范围时向前回退，最多退 3 页
  let actualPage = requestPage
  let guard = 0
  while (guard < 3 && actualPage > 1 && (data.replies?.length ?? 0) === 0) {
    actualPage -= 1
    data = await loadPage(actualPage)
    guard += 1
  }

  if ((data.replies?.length ?? 0) > 0 && data.cursor?.is_end) {
    // 摸到真正的最后一页，页数从此精确
    totalPages = actualPage
    pagesExact = true
  } else if (!pagesExact && actualPage >= totalPages) {
    totalPages = actualPage + 1
  }

  total = data.cursor?.all_count ?? total

  const comments = (data.replies ?? []).map((reply) =>
    normalizeComment(reply, video.ownerMid),
  )

  const result: CommentPage = {
    comments,
    page: actualPage,
    size: COMMENT_PAGE_SIZE,
    total,
    totalPages,
    pagesExact,
    hasMore: actualPage < totalPages && comments.length > 0,
  }

  if (sort === 'latest') {
    const chain = latestChains.get(video.aid)
    if (chain) {
      const next = data.cursor?.pagination_reply?.next_offset
      chain.fetchedPage = Math.max(chain.fetchedPage, actualPage)
      chain.allCount = total
      chain.updatedAt = Date.now()
      if (next) chain.offsets[actualPage] = next
      else chain.isEnd = true
    }
  }

  cacheSet(pageStateKey, { pages: totalPages, exact: pagesExact, total, updatedAt: Date.now() }, PAGE_COUNT_TTL)
  cacheSet(cacheKey, result, COMMENT_TTL)
  return result
}

export type CommentBatch = {
  comments: BiliComment[]
  /** 本次请求的游标：B 站页码 + 页内偏移（从 0 起） */
  cursor: string
  /** 下一次请求的游标；已到末尾时为 null */
  nextCursor: string | null
  limit: number
  total: number
  totalPages: number
  pagesExact: boolean
  hasMore: boolean
}

export type CommentCursor = { page: number; offset: number }

/**
 * 无限滚动用的批量评论：B 站单页最多 30 条，这里按游标聚合多页。
 * 游标是「B 站页码 + 页内偏移」，不假设每页都有 30 条，
 * 因此遇到被过滤变短的页也不会重复或跳评论。
 * 首屏 100 条、之后每次 50 条由前端决定。
 */
export async function fetchCommentBatch(
  video: BiliVideo,
  cursor: CommentCursor,
  limit: number,
  sort: CommentSort,
): Promise<CommentBatch> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200)
  const cursorText = `${Math.max(1, Math.floor(cursor.page) || 1)}:${Math.max(
    0,
    Math.floor(cursor.offset) || 0,
  )}`

  let page = Math.max(1, Math.floor(cursor.page) || 1)
  let offset = Math.max(0, Math.floor(cursor.offset) || 0)
  const comments: BiliComment[] = []
  const seen = new Set<string>()
  let total = 0
  let totalPages = 0
  let pagesExact = false
  let hasMore = false
  let guard = 0

  while (comments.length < safeLimit && guard < 40) {
    guard += 1
    const data = await fetchComments(video, page, sort)
    if (guard === 1) {
      total = data.total
      totalPages = data.totalPages
      pagesExact = data.pagesExact
    }

    if (page > totalPages) {
      hasMore = false
      break
    }

    const pageComments = data.comments
    if (offset >= pageComments.length) {
      if (page >= totalPages) {
        hasMore = false
        break
      }
      page += 1
      offset = 0
      continue
    }

    const slice = pageComments.slice(offset, offset + (safeLimit - comments.length))
    for (const comment of slice) {
      if (comment.rpid && seen.has(comment.rpid)) continue
      if (comment.rpid) seen.add(comment.rpid)
      comments.push(comment)
    }
    offset += slice.length

    // 本页还没读完：下一次从当前页的 offset 继续
    if (offset < pageComments.length) {
      hasMore = true
      break
    }

    // 本页刚好读完
    if (page >= totalPages) {
      hasMore = false
      break
    }

    page += 1
    offset = 0
    hasMore = true
  }

  const nextCursor = hasMore && comments.length > 0 ? `${page}:${offset}` : null

  return {
    comments,
    cursor: cursorText,
    nextCursor,
    limit: safeLimit,
    total,
    totalPages,
    pagesExact,
    hasMore: nextCursor !== null,
  }
}

export async function fetchSubReplies(
  video: BiliVideo,
  root: string,
  page: number,
): Promise<CommentPage> {
  const cacheKey = `sub:${video.aid}:${root}:${page}:${video.ownerMid}`
  const cached = cacheGet<CommentPage>(cacheKey)
  if (cached) return cached

  const data = await requestJson<ReplyPageData>('/x/v2/reply/reply', {
    oid: video.aid,
    type: 1,
    root,
    pn: page,
    ps: SUB_REPLY_PAGE_SIZE,
    sort: 2,
    nohot: 0,
  })

  const replies = data.replies ?? []
  const total = data.page?.count ?? 0
  const totalPages = Math.ceil(total / SUB_REPLY_PAGE_SIZE)
  const comments = replies.map((reply) => normalizeComment(reply, video.ownerMid))

  const result: CommentPage = {
    comments,
    page,
    size: SUB_REPLY_PAGE_SIZE,
    total,
    totalPages,
    pagesExact: true,
    hasMore: page < totalPages && comments.length > 0,
  }

  cacheSet(cacheKey, result, SUB_REPLY_TTL)
  return result
}

type ThreadState = {
  root: ThreadComment | null
  replies: ThreadComment[]
  total: number
  fetchedPages: number
  isEnd: boolean
  updatedAt: number
}

const threadCache = new Map<string, ThreadState>()
/** 同一楼中楼的并发请求排队，避免重复翻页 */
const threadLocks = new Map<string, Promise<void>>()

function toThreadComment(
  raw: RawReply,
  ownerMid: string,
  fallbackRoot: string,
): ThreadComment {
  const root =
    raw.root === undefined || raw.root === null ? fallbackRoot : String(raw.root)
  const parent =
    raw.parent === undefined || raw.parent === null ? root : String(raw.parent)

  return {
    ...normalizeComment(raw, ownerMid),
    parentRpid: parent === '0' ? root : parent,
    rootRpid: root || fallbackRoot,
  }
}

function placeholderRoot(root: string): ThreadComment {
  return {
    rpid: root,
    mid: '',
    uname: '',
    message: '主评论',
    pictureCount: 0,
    like: 0,
    ctime: 0,
    replyCount: 0,
    isUp: false,
    replyTo: null,
    parentRpid: '0',
    rootRpid: root,
  }
}

function withThreadLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = threadLocks.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  threadLocks.set(key, settled)
  void settled.then(() => {
    if (threadLocks.get(key) === settled) threadLocks.delete(key)
  })
  return run
}

function pruneThreadCache() {
  while (threadCache.size > THREAD_CACHE_LIMIT) {
    const oldest = threadCache.keys().next().value
    if (oldest === undefined) break
    threadCache.delete(oldest)
  }
}

/**
 * 拉取一个主评论下的完整楼中楼，并补出 parent/root 关系。
 * 只拉子评论；前端用这些父子关系即时切换焦点，不需要反复请求。
 */
export async function fetchThread(
  video: BiliVideo,
  root: string,
  target: string,
  limit = THREAD_DEFAULT_LIMIT,
): Promise<BiliThread> {
  const clampedLimit = Math.max(
    THREAD_PAGE_SIZE,
    Math.min(THREAD_MAX_LIMIT, Math.trunc(limit) || THREAD_DEFAULT_LIMIT),
  )
  const key = `thread:${video.aid}:${root}:${video.ownerMid}`

  return withThreadLock(key, async () => {
    let state = threadCache.get(key)
    if (state && Date.now() - state.updatedAt > THREAD_TTL) {
      threadCache.delete(key)
      state = undefined
    }
    if (!state) {
      state = {
        root: null,
        replies: [],
        total: 0,
        fetchedPages: 0,
        isEnd: false,
        updatedAt: Date.now(),
      }
    }

    const maxPages = Math.ceil(clampedLimit / THREAD_PAGE_SIZE)

    while (
      !state.isEnd &&
      state.fetchedPages < maxPages &&
      state.replies.length < clampedLimit
    ) {
      const page = state.fetchedPages + 1
      const data = await requestJson<ReplyPageData>('/x/v2/reply/reply', {
        oid: video.aid,
        type: 1,
        root,
        pn: page,
        ps: THREAD_PAGE_SIZE,
        sort: 2,
        nohot: 0,
      })

      if (data.root) {
        const rootNode = toThreadComment(data.root, video.ownerMid, root)
        rootNode.parentRpid = '0'
        rootNode.rootRpid = root
        if (!state.root || !state.root.uname) state.root = rootNode
      }

      const replies = data.replies ?? []
      const pageCount = data.page?.count ?? 0
      if (pageCount > 0) state.total = Math.max(state.total, pageCount)

      const seen = new Set(state.replies.map((item) => item.rpid))
      for (const raw of replies) {
        const node = toThreadComment(raw, video.ownerMid, root)
        if (!node.rpid || node.rpid === root || seen.has(node.rpid)) continue
        seen.add(node.rpid)
        state.replies.push(node)
      }

      state.fetchedPages = page
      if (pageCount === 0) {
        state.total = Math.max(state.total, state.replies.length)
      }

      if (replies.length === 0) {
        state.isEnd = true
        break
      }
      if (state.total > 0 && state.replies.length >= state.total) {
        state.isEnd = true
        break
      }
      if (replies.length < THREAD_PAGE_SIZE) {
        state.isEnd = true
        break
      }
    }

    if (state.total > 0 && state.replies.length >= state.total) {
      state.isEnd = true
    }

    state.updatedAt = Date.now()
    threadCache.set(key, state)
    pruneThreadCache()

    const rootNode = state.root ?? placeholderRoot(root)
    const targetNode =
      target === root
        ? rootNode
        : state.replies.find((item) => item.rpid === target)

    if (!targetNode) {
      if (!state.isEnd) {
        const hint =
          clampedLimit >= THREAD_MAX_LIMIT
            ? `该楼中楼过大，最多加载 ${THREAD_MAX_LIMIT} 条，未找到该评论`
            : `该评论位于更靠后的位置，当前只加载了前 ${state.replies.length} 条，请继续加载`
        throw new BiliError(404, hint)
      }
      throw new BiliError(404, '评论不存在或已删除')
    }

    const total = Math.max(state.total, state.replies.length)
    return {
      rootRpid: root,
      targetRpid: target,
      nodes: [rootNode, ...state.replies],
      total,
      truncated: !state.isEnd && state.replies.length < total,
    }
  })
}

/** 发表/回复评论后清掉该视频的评论缓存，下一次加载能看到新内容 */
export function invalidateBiliCommentCache(aid: number) {
  const prefixes = [`comments:${aid}:`, `sub:${aid}:`, `probe:${aid}:`]
  for (const key of memoryCache.keys()) {
    if (key === `pages:${aid}` || prefixes.some((prefix) => key.startsWith(prefix))) {
      memoryCache.delete(key)
    }
  }
  for (const key of threadCache.keys()) {
    if (key.startsWith(`thread:${aid}:`)) threadCache.delete(key)
  }
  latestChains.delete(aid)
}

export type TitlePart = { text: string; hl: boolean }

export type BiliSearchVideo = {
  bvid: string
  aid: number
  title: string
  titleParts: TitlePart[]
  author: string
  mid: string
  play: number
  review: number
  like: number
  pubdate: number
  duration: string
  typename: string
  tags: string[]
  heatScore: number
  heatLevel: number
  heatLabel: string
  likeRate: number
}

export type BiliSearchResult = {
  keyword: string
  page: number
  size: number
  total: number
  totalPages: number
  videos: BiliSearchVideo[]
}

type RawSearchItem = {
  bvid?: string
  aid?: number | string
  id?: number | string
  title?: string
  author?: string
  mid?: number | string
  play?: number
  review?: number
  like?: number
  pubdate?: number
  senddate?: number
  duration?: string
  typename?: string
  tag?: string
}

type SearchApiData = {
  numResults?: number
  numPages?: number
  pagesize?: number
  result?: RawSearchItem[] | null
}

const SEARCH_TTL = 60 * 1000
const SEARCH_PAGE_SIZE = 20
const SEARCH_MAX_PAGE = 50

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
}

/** B 站标题里的关键词用 <em class="keyword"> 包着，这里转成可安全渲染的片段 */
function parseTitle(raw: string): { title: string; titleParts: TitlePart[] } {
  const parts: TitlePart[] = []
  const pattern = /<em class="keyword">([\s\S]*?)<\/em>/g
  let last = 0
  let match = pattern.exec(raw)

  while (match) {
    if (match.index > last) {
      parts.push({ text: decodeEntities(raw.slice(last, match.index)), hl: false })
    }
    parts.push({ text: decodeEntities(match[1] ?? ''), hl: true })
    last = match.index + match[0].length
    match = pattern.exec(raw)
  }

  if (last < raw.length) {
    parts.push({ text: decodeEntities(raw.slice(last)), hl: false })
  }

  const cleaned = parts.filter((part) => part.text.length > 0)
  return { title: cleaned.map((part) => part.text).join(''), titleParts: cleaned }
}

/** 点赞率的小样本平滑：向 1.5% 收缩，避免 6 播放 10 点赞变成 166% */
const HEAT_PRIOR_RATE = 0.015
const HEAT_PRIOR_PLAY = 800
const HEAT_LABELS = ['冷', '温', '热', '烫', '爆']

function computeHeat(play: number, like: number) {
  const safePlay = Math.max(0, play)
  const safeLike = Math.max(0, like)
  const smoothedRate =
    (safeLike + HEAT_PRIOR_RATE * HEAT_PRIOR_PLAY) / (safePlay + HEAT_PRIOR_PLAY)

  // 播放量跨 5 个数量级，用对数映射：1 千 → 0，1 千万 → 1
  const reach = Math.min(1, Math.max(0, (Math.log10(safePlay + 1) - 3) / 4))
  // 点赞率 8% 记满
  const engage = Math.min(1, Math.max(0, smoothedRate / 0.08))
  const score = 0.7 * reach + 0.3 * engage

  const level = score < 0.2 ? 0 : score < 0.4 ? 1 : score < 0.6 ? 2 : score < 0.8 ? 3 : 4
  const likeRate = safePlay > 0 ? safeLike / safePlay : 0

  return {
    heatScore: Number(score.toFixed(3)),
    heatLevel: level,
    heatLabel: HEAT_LABELS[level] ?? '冷',
    likeRate: Number(likeRate.toFixed(5)),
  }
}

function normalizeSearchItem(item: RawSearchItem): BiliSearchVideo | null {
  const bvid = (item.bvid ?? '').trim()
  if (!bvid) return null

  const { title, titleParts } = parseTitle(item.title ?? '')
  const tags = (item.tag ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  const play = item.play ?? 0
  const like = item.like ?? 0

  return {
    bvid,
    aid: Number(item.aid ?? item.id ?? 0),
    title,
    titleParts,
    author: item.author ?? '',
    mid: String(item.mid ?? ''),
    play,
    review: item.review ?? 0,
    like,
    pubdate: item.pubdate ?? item.senddate ?? 0,
    duration: item.duration ?? '',
    typename: item.typename ?? '',
    tags,
    ...computeHeat(play, like),
  }
}

export async function searchVideos(
  keyword: string,
  page: number,
): Promise<BiliSearchResult> {
  const cacheKey = `search:${keyword}:${page}`
  const cached = cacheGet<BiliSearchResult>(cacheKey)
  if (cached) return cached

  const data = await requestJson<SearchApiData>(
    '/x/web-interface/wbi/search/type',
    {
      search_type: 'video',
      keyword,
      page,
      page_size: SEARCH_PAGE_SIZE,
      order: 'totalrank',
    },
    { signed: true },
  )

  const videos = (data.result ?? [])
    .map(normalizeSearchItem)
    .filter((item): item is BiliSearchVideo => item !== null)

  const total = Math.min(data.numResults ?? 0, 1000)
  const totalPages = Math.max(
    1,
    Math.min(data.numPages ?? Math.ceil(total / SEARCH_PAGE_SIZE), SEARCH_MAX_PAGE),
  )

  const result: BiliSearchResult = {
    keyword,
    page,
    size: SEARCH_PAGE_SIZE,
    total,
    totalPages,
    videos,
  }

  cacheSet(cacheKey, result, SEARCH_TTL)
  return result
}

export type BiliUpUser = {
  mid: string
  uname: string
  usign: string
  fans: number
  videos: number
  level: number
  /** 官方认证描述，空字符串表示无认证 */
  official: string
}

export type BiliUpSearchResult = {
  keyword: string
  page: number
  size: number
  total: number
  totalPages: number
  users: BiliUpUser[]
}

export type BiliUpVideo = {
  bvid: string
  aid: number
  title: string
  play: number
  danmaku: number
  pubdate: number
  duration: string
  typename: string
}

export type UpVideoOrder = 'pubdate' | 'click'

export type BiliUpVideosResult = {
  mid: string
  user: BiliUpUser
  order: UpVideoOrder
  page: number
  size: number
  total: number
  totalPages: number
  /** B 站游客最多只能翻到第 10 页（200 个投稿） */
  limited: boolean
  videos: BiliUpVideo[]
}

type RawUpSearchItem = {
  mid?: number | string
  uname?: string
  usign?: string
  fans?: number
  videos?: number
  level?: number
  official_verify?: { type?: number; desc?: string } | null
}

type UpSearchApiData = {
  numResults?: number
  numPages?: number
  result?: RawUpSearchItem[] | null
}

type RawUpArchiveItem = {
  bvid?: string
  param?: number | string
  title?: string
  play?: number
  danmaku?: number
  ctime?: number
  duration?: number
  tname?: string
}

type UpArchiveApiData = {
  count?: number
  item?: RawUpArchiveItem[] | null
}

type UpCardApiData = {
  card?: {
    mid?: number | string
    name?: string
    sign?: string
    fans?: number
    level_info?: { current_level?: number } | null
    official_verify?: { type?: number; desc?: string } | null
  } | null
}

const UP_SEARCH_TTL = 60 * 1000
const UP_VIDEOS_TTL = 60 * 1000
const UP_INFO_TTL = 10 * 60 * 1000
const UP_PAGE_SIZE = 20
const UP_SEARCH_MAX_PAGE = 50
/** App 投稿接口从第 11 页起返回 -412，游客最多看 200 个投稿 */
const UP_VIDEO_MAX_PAGE = 10
const UP_VIDEO_LIMIT = UP_PAGE_SIZE * UP_VIDEO_MAX_PAGE

function normalizeOfficial(
  verify: { type?: number; desc?: string } | null | undefined,
): string {
  if (!verify || verify.type === -1) return ''
  return (verify.desc ?? '').trim()
}

function normalizeUpSearchItem(item: RawUpSearchItem): BiliUpUser | null {
  const mid = String(item.mid ?? '').trim()
  if (!mid) return null

  return {
    mid,
    uname: item.uname ?? '',
    usign: (item.usign ?? '').trim(),
    fans: item.fans ?? 0,
    videos: item.videos ?? 0,
    level: item.level ?? 0,
    official: normalizeOfficial(item.official_verify),
  }
}

/** UP 主搜索：网页版接口对本机可用 */
export async function searchUps(keyword: string, page: number): Promise<BiliUpSearchResult> {
  const cacheKey = `upsearch:${keyword}:${page}`
  const cached = cacheGet<BiliUpSearchResult>(cacheKey)
  if (cached) return cached

  const data = await requestJson<UpSearchApiData>(
    '/x/web-interface/wbi/search/type',
    {
      search_type: 'bili_user',
      keyword,
      page,
      page_size: UP_PAGE_SIZE,
    },
    { signed: true },
  )

  const users = (data.result ?? [])
    .map(normalizeUpSearchItem)
    .filter((item): item is BiliUpUser => item !== null)

  const total = Math.min(data.numResults ?? 0, 1000)
  const totalPages = Math.max(
    1,
    Math.min(data.numPages ?? Math.ceil(total / UP_PAGE_SIZE), UP_SEARCH_MAX_PAGE),
  )

  const result: BiliUpSearchResult = {
    keyword,
    page,
    size: UP_PAGE_SIZE,
    total,
    totalPages,
    users,
  }

  cacheSet(cacheKey, result, UP_SEARCH_TTL)
  return result
}

async function fetchUpInfo(mid: string): Promise<BiliUpUser> {
  const cacheKey = `upinfo:${mid}`
  const cached = cacheGet<BiliUpUser>(cacheKey)
  if (cached) return cached

  const data = await requestAppJson<UpCardApiData>('/x/v2/space', {
    vmid: mid,
    mobi_app: 'android',
    platform: 'android',
    build: '7300000',
  })

  const card = data.card ?? {}
  const user: BiliUpUser = {
    mid: String(card.mid ?? mid),
    uname: card.name ?? '',
    usign: (card.sign ?? '').trim(),
    fans: card.fans ?? 0,
    videos: 0,
    level: card.level_info?.current_level ?? 0,
    official: normalizeOfficial(card.official_verify),
  }

  cacheSet(cacheKey, user, UP_INFO_TTL)
  return user
}

function formatDuration(raw: number | undefined): string {
  const total = Math.max(0, Math.floor(raw ?? 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

function normalizeUpArchiveItem(item: RawUpArchiveItem): BiliUpVideo | null {
  const bvid = (item.bvid ?? '').trim()
  if (!bvid) return null

  return {
    bvid,
    aid: Number(item.param ?? 0),
    title: item.title ?? '',
    play: item.play ?? 0,
    danmaku: item.danmaku ?? 0,
    pubdate: item.ctime ?? 0,
    duration: formatDuration(item.duration),
    typename: item.tname ?? '',
  }
}

/** UP 主投稿：App 接口，最多 10 页 / 200 条 */
export async function fetchUpVideos(
  mid: string,
  page: number,
  order: UpVideoOrder,
): Promise<BiliUpVideosResult> {
  const safePage = Math.min(Math.max(1, page), UP_VIDEO_MAX_PAGE)
  const cacheKey = `upvideos:${mid}:${order}:${safePage}`
  const cached = cacheGet<BiliUpVideosResult>(cacheKey)
  if (cached) return cached

  const [user, data] = await Promise.all([
    fetchUpInfo(mid),
    requestAppJson<UpArchiveApiData>('/x/v2/space/archive', {
      vmid: mid,
      pn: safePage,
      ps: UP_PAGE_SIZE,
      order,
      mobi_app: 'android',
      platform: 'android',
      build: '7300000',
    }),
  ])

  const videos = (data.item ?? [])
    .map(normalizeUpArchiveItem)
    .filter((item): item is BiliUpVideo => item !== null)

  const total = data.count ?? 0
  const totalPages = Math.max(1, Math.min(Math.ceil(total / UP_PAGE_SIZE), UP_VIDEO_MAX_PAGE))
  user.videos = total

  const result: BiliUpVideosResult = {
    mid,
    user,
    order,
    page: safePage,
    size: UP_PAGE_SIZE,
    total,
    totalPages,
    limited: total > UP_VIDEO_LIMIT,
    videos,
  }

  cacheSet(cacheKey, result, UP_VIDEOS_TTL)
  return result
}

export type BiliQrCode = {
  key: string
  url: string
  expiresIn: number
}

export type BiliLoginAccount = {
  mid: string
  uname: string
  expiresAt: number | null
}

export type BiliQrStatus = 'waiting' | 'scanned' | 'expired' | 'success'

export type BiliQrPollResult = {
  status: BiliQrStatus
  message: string
  account?: BiliLoginAccount
  cookies?: Record<string, string>
  refreshToken?: string
  expiresAt?: number | null
}

type QrGenerateData = { url?: string; qrcode_key?: string }
type QrPollData = {
  url?: string
  refresh_token?: string
  timestamp?: number
  code?: number
  message?: string
}

const LOGIN_COOKIE_KEYS = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4',
]

/** 解析 Set-Cookie，只取第一段 name=value */
function parseSetCookie(header: string): { name: string; value: string } | null {
  const pair = header.split(';')[0] ?? ''
  const index = pair.indexOf('=')
  if (index <= 0) return null
  return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() }
}

/** 从登录成功返回的 URL 中取 Cookie，保留 %2C 等原始编码 */
function parseUrlCookies(url: string): Record<string, string> {
  const result: Record<string, string> = {}
  const query = url.split('?')[1] ?? ''
  for (const part of query.split('&')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    result[part.slice(0, index)] = part.slice(index + 1)
  }
  return result
}

function collectLoginCookies(url: string | undefined, setCookies: string[]): Record<string, string> {
  const cookies = url ? parseUrlCookies(url) : {}
  for (const header of setCookies) {
    const parsed = parseSetCookie(header)
    if (parsed) cookies[parsed.name] = parsed.value
  }

  const picked: Record<string, string> = {}
  for (const key of LOGIN_COOKIE_KEYS) {
    const value = cookies[key]
    if (value) picked[key] = value
  }
  return picked
}

export function buildBiliCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/** SESSDATA 里带过期时间戳（<value>,<timestamp>,<sig>），解析出来用于提示 */
function parseSessdataExpiry(sessdata: string | undefined): number | null {
  if (!sessdata) return null
  try {
    const parts = decodeURIComponent(sessdata).split(',')
    const stamp = parts.map((part) => part.trim()).find((part) => /^\d{9,12}$/.test(part))
    return stamp ? Number(stamp) * 1000 : null
  } catch {
    return null
  }
}

export async function generateBiliQrCode(): Promise<BiliQrCode> {
  const res = await fetch(`${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new BiliError(502, `获取 B 站二维码失败（HTTP ${res.status}）`)

  const body = (await res.json()) as ApiEnvelope<QrGenerateData>
  if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) {
    throw new BiliError(502, body.message || '获取 B 站二维码失败，请稍后再试')
  }

  return {
    key: body.data.qrcode_key,
    url: body.data.url,
    expiresIn: 180,
  }
}

export async function pollBiliQrCode(key: string): Promise<BiliQrPollResult> {
  const url = new URL(`${PASSPORT_BASE}/x/passport-login/web/qrcode/poll`)
  url.searchParams.set('qrcode_key', key)
  url.searchParams.set('source', 'main-fe-header')

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new BiliError(502, `轮询 B 站二维码失败（HTTP ${res.status}）`)

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const body = (await res.json()) as ApiEnvelope<QrPollData>
  if (body.code !== 0) throw new BiliError(502, body.message || '轮询 B 站二维码失败')

  const data = body.data ?? {}
  if (data.code === 86101) return { status: 'waiting', message: '等待扫码' }
  if (data.code === 86090) return { status: 'scanned', message: '已扫码，请在手机上确认' }
  if (data.code === 86038) return { status: 'expired', message: '二维码已失效' }
  if (data.code !== 0) {
    return { status: 'expired', message: data.message || '二维码已失效，请刷新' }
  }

  const cookies = collectLoginCookies(data.url, setCookies)
  if (!cookies.SESSDATA) {
    throw new BiliError(502, 'B 站登录成功但未拿到登录凭据，请重新扫码')
  }

  return {
    status: 'success',
    message: '登录成功',
    cookies,
    refreshToken: data.refresh_token || '',
    expiresAt: parseSessdataExpiry(cookies.SESSDATA),
  }
}

export async function fetchBiliNav(cookieHeader: string): Promise<BiliLoginAccount> {
  const data = await requestJson<{
    isLogin?: boolean
    mid?: number | string
    uname?: string
  }>('/x/web-interface/nav', {}, { cookieValue: cookieHeader })

  if (!data.isLogin || !data.mid) {
    throw new BiliError(401, 'B 站登录状态无效，请重新扫码')
  }

  return { mid: String(data.mid), uname: data.uname ?? '', expiresAt: null }
}
