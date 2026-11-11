import { scheduleRequest, fetchJson, fetchHtml, WikiFetchError } from './fetch.js'
import { TtlCache } from './cache.js'

export type SiteInfo = {
  /** api.php 的完整地址 */
  apiUrl: URL
  /** 站点根（用于构造页面地址） */
  origin: string
  server: string
  scriptPath: string
  articlePath: string
  mainPage: string
  siteName: string
  lang: string
  generator: string
}

export type WikiSection = {
  level: number
  title: string
  anchor: string
}

export type ParseResult = {
  site: SiteInfo
  title: string
  html: string
  sections: WikiSection[]
  /** 规范化后的页面地址 */
  pageUrl: string
}

type SiteInfoResponse = {
  query?: {
    general?: {
      mainpage?: string
      base?: string
      sitename?: string
      generator?: string
      articlepath?: string
      scriptpath?: string
      server?: string
      lang?: string
    }
  }
  error?: { code?: string; info?: string }
}

/** 站点探测结果缓存：一个 origin + 语言前缀只探测一次 */
const siteCache = new TtlCache<SiteInfo | null>(300, 60 * 60 * 1000)
const parseCache = new TtlCache<ParseResult>(200, 10 * 60 * 1000)

function probeTimeout() {
  return 3000
}

/** 根据页面地址生成候选 api.php（/zh/api.php、/api.php、/w/api.php） */
function apiCandidates(pageUrl: URL): URL[] {
  const segments = pageUrl.pathname.split('/').filter(Boolean)
  const seen = new Set<string>()
  const candidates: URL[] = []

  const push = (pathname: string) => {
    const url = new URL(pathname, pageUrl.origin)
    if (seen.has(url.href)) return
    seen.add(url.href)
    candidates.push(url)
  }

  // 多语言站（/zh/页面）的 API 在语言前缀下，优先试；
  // 维基百科这类站点走 /w/api.php，放在后面
  const first = segments[0]
  if (first) push(`/${first}/api.php`)
  push('/api.php')
  push('/w/api.php')

  return candidates
}

function siteCacheKey(pageUrl: URL): string {
  const first = pageUrl.pathname.split('/').filter(Boolean)[0] ?? ''
  return `${pageUrl.origin}/${first}`
}

async function probeSite(pageUrl: URL): Promise<SiteInfo | null> {
  for (const candidate of apiCandidates(pageUrl)) {
    const url = new URL(candidate)
    url.search = '?action=query&meta=siteinfo&format=json&formatversion=2&siprop=general'

    try {
      const { data, finalUrl } = await scheduleRequest(() =>
        fetchJson<SiteInfoResponse>(url, {
          timeoutMs: probeTimeout(),
          maxBytes: 256 * 1024,
        }),
      )
      const general = data.query?.general
      if (!general?.generator) continue

      return {
        apiUrl: finalUrl,
        origin: finalUrl.origin,
        server: general.server ?? finalUrl.origin,
        scriptPath: general.scriptpath ?? '',
        articlePath: general.articlepath ?? '/wiki/$1',
        mainPage: general.mainpage ?? 'Main Page',
        siteName: general.sitename ?? new URL(finalUrl).hostname,
        lang: general.lang ?? '',
        generator: general.generator,
      }
    } catch {
      // 候选路径不通，继续试下一个
    }
  }

  return null
}

/** 探测站点；结果（含“不是 MediaWiki”）都会缓存 */
export async function resolveSite(pageUrl: URL): Promise<SiteInfo | null> {
  const key = siteCacheKey(pageUrl)
  const cached = siteCache.get(key)
  if (cached !== undefined) return cached

  const site = await probeSite(pageUrl)
  siteCache.set(key, site)
  return site
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** 从页面地址提取条目名 */
export function titleFromUrl(site: SiteInfo, pageUrl: URL): string {
  const pathname = pageUrl.pathname
  const articlePath = site.articlePath || '/wiki/$1'
  const prefix = articlePath.replace(/\$1.*$/, '')

  if (prefix && pathname.startsWith(prefix)) {
    const rest = pathname.slice(prefix.length)
    if (rest) return decodeSegment(rest).replace(/[?#].*$/, '')
  }

  const segments = pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (!last) return site.mainPage

  return decodeSegment(last).replace(/[?#].*$/, '')
}

/** 由条目名构造规范化页面地址 */
export function pageUrlFromTitle(site: SiteInfo, title: string): string {
  const path = site.articlePath.replace('$1', encodeURIComponent(title.replace(/ /g, '_')))
  return new URL(path, site.origin).toString()
}

type RawSection = {
  toclevel?: number
  level?: string
  line?: string
  anchor?: string
}

type ParseResponse = {
  parse?: {
    title?: string
    text?: string
    sections?: RawSection[]
  }
  error?: { code?: string; info?: string }
}

export class WikiPageError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'forbidden' | 'upstream' = 'upstream',
  ) {
    super(message)
    this.name = 'WikiPageError'
  }
}

function parseSections(sections: RawSection[] | undefined): WikiSection[] {
  if (!Array.isArray(sections)) return []
  return sections.map((item) => ({
    level: Number(item.toclevel ?? item.level ?? 1) || 1,
    title: (item.line ?? '').trim(),
    anchor: item.anchor ?? '',
  }))
}

/** 通过 MediaWiki API 拉取正文 HTML */
export async function parseWikiPage(site: SiteInfo, title: string): Promise<ParseResult> {
  const cacheKey = `${site.apiUrl.origin}${site.apiUrl.pathname}|${site.lang}|${title}`
  const cached = parseCache.get(cacheKey)
  if (cached) return cached

  const url = new URL(site.apiUrl)
  url.search = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'text|displaytitle|sections',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    disableeditsection: '1',
    disablelimitreport: '1',
    disabletoc: '1',
  }).toString()

  let data: ParseResponse
  try {
    const result = await scheduleRequest(() =>
      fetchJson<ParseResponse>(url, { timeoutMs: 30_000, maxBytes: 12 * 1024 * 1024 }),
    )
    data = result.data
  } catch (error) {
    if (error instanceof WikiFetchError) {
      if (error.status === 403) throw new WikiPageError('该页面不允许访问', 'forbidden')
      if (error.code === 'timeout') throw new WikiPageError('上游解析超时，请稍后重试', 'upstream')
      throw new WikiPageError(error.message, 'upstream')
    }
    throw error
  }

  if (data.error) {
    const code = data.error.code ?? ''
    if (code === 'missingtitle' || code === 'invalidtitle' || code === 'nosuchpageid') {
      throw new WikiPageError('页面不存在', 'not_found')
    }
    if (code === 'readapidenied' || code === 'permissiondenied') {
      throw new WikiPageError('该页面需要登录才能查看，本模块不支持', 'forbidden')
    }
    throw new WikiPageError(data.error.info ?? '上游返回错误', 'upstream')
  }

  const parsed = data.parse
  if (!parsed?.text) throw new WikiPageError('上游没有返回正文', 'upstream')

  const resolvedTitle = (parsed.title ?? title).trim()
  const result: ParseResult = {
    site,
    title: resolvedTitle,
    html: parsed.text,
    sections: parseSections(parsed.sections),
    pageUrl: pageUrlFromTitle(site, resolvedTitle),
  }

  parseCache.set(cacheKey, result)
  return result
}

type SearchResponse = {
  query?: {
    search?: Array<{ title?: string; snippet?: string }>
  }
  error?: { code?: string; info?: string }
}

export type SearchHit = {
  title: string
  snippet: string
  url: string
}

/** 站内搜索（MediaWiki action=query&list=search） */
export async function searchWiki(site: SiteInfo, keyword: string): Promise<SearchHit[]> {
  const url = new URL(site.apiUrl)
  url.search = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: keyword,
    srlimit: '12',
    srprop: 'snippet',
    format: 'json',
    formatversion: '2',
  }).toString()

  const { data } = await scheduleRequest(() =>
    fetchJson<SearchResponse>(url, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 }),
  )

  if (data.error) throw new WikiPageError(data.error.info ?? '搜索失败', 'upstream')

  return (data.query?.search ?? [])
    .filter((item): item is { title: string; snippet?: string } => Boolean(item.title))
    .map((item) => ({
      title: item.title,
      snippet: (item.snippet ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim(),
      url: pageUrlFromTitle(site, item.title),
    }))
}

export function clearWikiCache() {
  siteCache.clear()
  parseCache.clear()
}

export { fetchHtml }
