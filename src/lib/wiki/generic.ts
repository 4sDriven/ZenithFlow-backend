import { load } from 'cheerio'
import { fetchHtml } from './fetch.js'
import { sanitizeWikiHtml, type SanitizeResult } from './sanitize.js'

/** 常见正文容器，从最可信到最兜底 */
const CONTENT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#mw-content-text',
  '.mw-parser-output',
  '.markdown-body',
  '.post-content',
  '.entry-content',
  '.article-content',
  '#content',
  '.content',
]

const DROP_SELECTORS = [
  'header',
  'footer',
  'nav',
  'aside',
  '.sidebar',
  '.side-bar',
  '.breadcrumb',
  '.breadcrumbs',
  '.advertisement',
  '.ads',
  '.ad',
  '.share',
  '.social',
  '.comments',
  '#comments',
]

export type GenericResult = {
  title: string
  finalUrl: URL
  sanitized: SanitizeResult
}

function notFound() {
  return new Error('该地址不是 MediaWiki 站点，且没有找到可读的正文区域')
}

/** 非 MediaWiki 站点的降级路径：已抓到的 HTML → 找正文容器 → 同一套清洗规则 */
export function readGenericFromHtml(html: string, finalUrl: URL): GenericResult {
  const $ = load(html)

  const pageTitle = (
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    finalUrl.hostname
  )
    .replace(/\s+/g, ' ')
    .trim()

  $(DROP_SELECTORS.join(',')).remove()

  let $content = $()
  for (const selector of CONTENT_SELECTORS) {
    const found = $(selector).first()
    if (found.length && found.text().trim().length > 200) {
      $content = found
      break
    }
  }

  if (!$content.length) $content = $('body')

  const sanitized = sanitizeWikiHtml($content.html() ?? '', { pageUrl: finalUrl })
  if (sanitized.stats.textLength < 40) throw notFound()

  const heading = $content.find('h1').first().text().trim()
  const title = heading || pageTitle || finalUrl.hostname

  return {
    title: title.slice(0, 200),
    finalUrl,
    sanitized,
  }
}

export async function readGenericPage(pageUrl: URL): Promise<GenericResult> {
  const { html, finalUrl, status } = await fetchHtml(pageUrl, {
    timeoutMs: 25_000,
    maxBytes: 8 * 1024 * 1024,
  })
  if (status >= 400) throw notFound()
  return readGenericFromHtml(html, finalUrl)
}
