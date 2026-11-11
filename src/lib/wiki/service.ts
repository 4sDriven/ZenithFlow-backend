import { TtlCache } from './cache.js'
import { fetchHtml, WikiFetchError } from './fetch.js'
import { readGenericFromHtml } from './generic.js'
import {
  parseWikiPage,
  resolveSite,
  titleFromUrl,
  WikiPageError,
  type WikiSection,
} from './mediawiki.js'
import { sanitizeWikiHtml, type SanitizeStats } from './sanitize.js'
import { assertPublicHost, normalizeInputUrl, WikiUrlError } from './url.js'

export type WikiErrorCode =
  | 'invalid_url'
  | 'blocked'
  | 'not_found'
  | 'forbidden'
  | 'timeout'
  | 'too_large'
  | 'upstream'

export class WikiError extends Error {
  constructor(
    message: string,
    readonly code: WikiErrorCode,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WikiError'
  }
}

export type WikiPageView = {
  ok: true
  title: string
  kind: 'mediawiki' | 'generic'
  siteName: string
  /** 当前渲染的规范化地址 */
  pageUrl: string
  /** 用户输入的地址 */
  requestedUrl: string
  html: string
  toc: WikiSection[]
  stats: SanitizeStats
  fetchedAt: string
  cached: boolean
}

const viewCache = new TtlCache<Omit<WikiPageView, 'cached'>>(200, 10 * 60 * 1000)

const MEDIAWIKI_HINT =
  /<meta[^>]+name=["']generator["'][^>]+content=["']MediaWiki/i

function looksLikeMediaWiki(html: string): boolean {
  return (
    MEDIAWIKI_HINT.test(html) ||
    html.includes('mw-parser-output') ||
    /"wgScriptPath"\s*:/.test(html)
  )
}

function mapError(error: unknown): WikiError {
  if (error instanceof WikiError) return error

  if (error instanceof WikiUrlError) {
    return new WikiError(error.message, error.code === 'blocked' ? 'blocked' : 'invalid_url', error.code === 'blocked' ? 403 : 400)
  }

  if (error instanceof WikiFetchError) {
    if (error.code === 'timeout') return new WikiError('上游响应超时，请稍后重试', 'timeout', 504)
    if (error.code === 'too_large') return new WikiError('页面体积超出限制', 'too_large', 413)
    if (error.code === 'blocked') return new WikiError(error.message, 'blocked', 403)
    if (error.status === 404) return new WikiError('页面不存在', 'not_found', 404)
    if (error.status === 403) return new WikiError('该页面不允许访问', 'forbidden', 403)
    if (error.status === 429) return new WikiError('上游限流，请稍后再试', 'upstream', 429)
    return new WikiError(error.message, 'upstream', 502)
  }

  if (error instanceof WikiPageError) {
    if (error.code === 'not_found') return new WikiError('页面不存在', 'not_found', 404)
    if (error.code === 'forbidden') return new WikiError(error.message, 'forbidden', 403)
    return new WikiError(error.message, 'upstream', 502)
  }

  if (error instanceof Error) {
    return new WikiError(error.message, 'upstream', 502)
  }

  return new WikiError('未知错误', 'upstream', 502)
}

/**
 * 读取一个 wiki 页面并清洗成纯文字版。
 * 先抓一次 HTML 判断站点类型：MediaWiki → 走 API 拿正文；其他站点 → 直接在这份 HTML 上做正文提取。
 */
export async function readWikiPage(input: string): Promise<WikiPageView> {
  try {
    const pageUrl = normalizeInputUrl(input)
    await assertPublicHost(pageUrl)

    const cacheKey = pageUrl.href
    const cached = viewCache.get(cacheKey)
    if (cached) return { ...cached, cached: true }

    const { html, finalUrl } = await fetchHtml(pageUrl, {
      timeoutMs: 30_000,
      maxBytes: 8 * 1024 * 1024,
    })

    let view: Omit<WikiPageView, 'cached'>

    if (looksLikeMediaWiki(html)) {
      const site = await resolveSite(finalUrl)
      if (!site) throw new WikiError('没有找到该站点的 MediaWiki 接口', 'upstream', 502)

      const title = titleFromUrl(site, finalUrl)
      const parsed = await parseWikiPage(site, title)
      const parsedUrl = new URL(parsed.pageUrl)
      const sanitized = sanitizeWikiHtml(parsed.html, { pageUrl: parsedUrl })

      if (sanitized.stats.textLength < 10 && sanitized.stats.images === 0) {
        throw new WikiError('该页面没有可显示的正文（可能是列表页或特殊页面）', 'not_found', 404)
      }

      view = {
        ok: true,
        title: parsed.title,
        kind: 'mediawiki',
        siteName: site.siteName,
        pageUrl: parsed.pageUrl,
        requestedUrl: pageUrl.href,
        html: sanitized.html,
        toc: parsed.sections.filter((section) => section.level <= 3 && section.title),
        stats: sanitized.stats,
        fetchedAt: new Date().toISOString(),
      }
    } else {
      const generic = readGenericFromHtml(html, finalUrl)
      view = {
        ok: true,
        title: generic.title,
        kind: 'generic',
        siteName: finalUrl.hostname,
        pageUrl: finalUrl.href,
        requestedUrl: pageUrl.href,
        html: generic.sanitized.html,
        toc: [],
        stats: generic.sanitized.stats,
        fetchedAt: new Date().toISOString(),
      }
    }

    viewCache.set(cacheKey, view)
    return { ...view, cached: false }
  } catch (error) {
    throw mapError(error)
  }
}

export function clearViewCache() {
  viewCache.clear()
}
