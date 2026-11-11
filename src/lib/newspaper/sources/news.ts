import type { RawItem } from '../types.js'
import {
  absoluteUrl,
  clip,
  decodeEntities,
  fetchText,
  hostOf,
  isFresh,
  normalizeTitle,
  parseCnTime,
  stripHtml,
  unwrapBingUrl,
} from '../http.js'

type Json = Record<string, unknown>

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function inferKind(source: string, url: string | null): RawItem['kind'] {
  const value = `${source} ${url ?? ''}`
  if (/政府|政务|发布|日报|晚报|新闻网|新华|央视|央广|人民网|公安|法院|检察院|卫健委|教育局/.test(value)) {
    return 'official'
  }
  if (/论坛|贴吧|微博|知乎|抖音|B站|bilibili|网友|业主/.test(value)) return 'folk'
  return 'mixed'
}

const CITIZEN_SOURCE_RE = /论坛|贴吧|微博|知乎|抖音|B站|网友|业主|19楼/

/** 360 资讯：HTML 结果块结构稳定，能拿到原文链接、来源与时间 */
export async function search360(
  query: string,
  maxAgeHours = 96,
  sort: 'time' | 'focus' = 'time',
): Promise<RawItem[]> {
  const rank = sort === 'time' ? 'pdate' : 'rank'
  const url = `https://news.so.com/ns?q=${encodeURIComponent(query)}&pn=1&rank=${rank}`
  const html = await fetchText(url, {
    timeoutMs: 18_000,
    headers: { Referer: 'https://news.so.com/' },
  })

  const chunks = html.split(/<li class="[^"]*res-list[^"]*"/).slice(1)
  const items: RawItem[] = []

  for (const chunk of chunks) {
    const block = chunk.split(/<li class="[^"]*res-list[^"]*"/)[0] ?? chunk
    const href =
      block.match(/data-url="([^"]+)"/)?.[1] ??
      block.match(/<a[^>]+href="([^"]+)"/)?.[1] ??
      ''
    const target = absoluteUrl(href, 'https://news.so.com')
    if (!target) continue

    const title = stripHtml(
      block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ??
        block.match(/title="([^"]+)"/)?.[1] ??
        '',
    )
    if (!title) continue

    const summary = stripHtml(
      block.match(/<p[^>]*class="[^"]*\bsummary\b[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '',
    )
    const source = stripHtml(
      block.match(/<cite[^>]*class="[^"]*sitename[^"]*"[^>]*>([\s\S]*?)<\/cite>/)?.[1] ??
        hostOf(target),
    )
    const timeLabel = stripHtml(
      block.match(/<span[^>]*class="[^"]*\btime\b[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '',
    )
    const publishedAt = parseCnTime(timeLabel)
    if (!isFresh(publishedAt, maxAgeHours)) continue

    items.push({
      title: clip(title, 120),
      summary: clip(summary, 260),
      source: source || '360 资讯',
      url: target,
      publishedAt,
      publishedLabel: timeLabel || null,
      heat: null,
      kind: CITIZEN_SOURCE_RE.test(source) ? 'folk' : inferKind(source, target),
      tags: [],
    })
  }

  return items
}

function parseRssDate(value: string): string | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function cleanCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
}

export type RssOptions = {
  source: string
  maxAgeHours?: number
  kind?: RawItem['kind']
  tags?: string[]
}

/** 通用 RSS/Atom 解析，够用即可，不引入 XML 依赖 */
export function parseRss(xml: string, options: RssOptions): RawItem[] {
  const items: RawItem[] = []
  const chunks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
  const atomChunks = chunks.length
    ? []
    : [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => [match[0], match[1]] as const)

  for (const match of [...chunks, ...atomChunks]) {
    const block = match[1] ?? ''
    const rawTitle = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
    const rawLink =
      block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ??
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ??
      ''
    const rawDesc =
      block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ??
      block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ??
      block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ??
      ''
    const rawDate =
      block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ??
      block.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1] ??
      block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1] ??
      ''

    const title = stripHtml(cleanCdata(rawTitle))
    const link = absoluteUrl(cleanCdata(rawLink))
    if (!title || !link) continue

    const publishedAt = parseRssDate(stripHtml(cleanCdata(rawDate)))
    if (!isFresh(publishedAt, options.maxAgeHours ?? 72)) continue

    const summary = clip(stripHtml(cleanCdata(rawDesc)), 260)
    items.push({
      title: clip(title, 140),
      summary,
      source: options.source,
      url: link,
      publishedAt,
      publishedLabel: null,
      heat: null,
      kind: options.kind ?? inferKind(options.source, link),
      tags: options.tags ?? [],
    })
  }

  return items
}

export async function fetchBingNews(query: string, maxAgeHours = 96): Promise<RawItem[]> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`
  const xml = await fetchText(url, { timeoutMs: 18_000, headers: { Referer: 'https://www.bing.com/news' } })
  const items: RawItem[] = []

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? ''
    const title = stripHtml(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    const href = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? ''
    const link = unwrapBingUrl(href)
    if (!title || !link) continue

    const summary = clip(
      stripHtml(block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ?? ''),
      260,
    )
    const publishedAt = parseRssDate(
      stripHtml(block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ?? ''),
    )
    if (!isFresh(publishedAt, maxAgeHours)) continue

    const source = stripHtml(
      block.match(/<News:Source[^>]*>([\s\S]*?)<\/News:Source>/i)?.[1] ?? hostOf(link),
    )

    items.push({
      title: clip(title, 140),
      summary,
      source: source || 'Bing 新闻',
      url: link,
      publishedAt,
      publishedLabel: null,
      heat: null,
      kind: CITIZEN_SOURCE_RE.test(source) ? 'folk' : inferKind(source, link),
      tags: [],
    })
  }

  return items
}

export async function fetchChinanews(): Promise<RawItem[]> {
  const xml = await fetchText('https://www.chinanews.com.cn/rss/scroll-news.xml', {
    timeoutMs: 18_000,
  })
  return parseRss(xml, {
    source: '中国新闻网',
    maxAgeHours: 96,
    kind: 'official',
    tags: ['中国'],
  })
}

export async function fetchBbcWorld(): Promise<RawItem[]> {
  const xml = await fetchText('https://feeds.bbci.co.uk/news/world/rss.xml', {
    timeoutMs: 18_000,
  })
  return parseRss(xml, {
    source: 'BBC World',
    maxAgeHours: 72,
    kind: 'mixed',
    tags: ['国际'],
  })
}

const NEWSNOW_FEEDS: { id: string; source: string; section: 'china' | 'world' }[] = [
  { id: 'thepaper', source: '澎湃新闻', section: 'china' },
  { id: 'cls', source: '财联社', section: 'china' },
  { id: 'wallstreetcn', source: '华尔街见闻', section: 'china' },
  { id: 'ithome', source: 'IT之家', section: 'china' },
]

export async function fetchNewsNow(id: string, source: string): Promise<RawItem[]> {
  const data = await fetchText(`https://newsnow.busiyi.world/api/s?id=${id}`, {
    timeoutMs: 12_000,
  })
  let parsed: Json
  try {
    parsed = JSON.parse(data) as Json
  } catch {
    throw new Error('返回内容不是合法 JSON')
  }
  const items = asArray(parsed.items)
  return items
    .map((entry): RawItem | null => {
      const record = asRecord(entry)
      if (!record) return null
      const title = text(record.title)
      const url = text(record.url) || text(record.mobileUrl)
      if (!title || !url) return null
      return {
        title: clip(stripHtml(title), 140),
        summary: '',
        source,
        url,
        publishedAt: null,
        publishedLabel: null,
        heat: null,
        kind: 'mixed' as const,
        tags: [],
      }
    })
    .filter((item): item is RawItem => item !== null)
}

export async function fetchNewsNowPool(section: 'china' | 'world'): Promise<{
  items: RawItem[]
  stats: Record<string, number>
  errors: { source: string; message: string }[]
}> {
  const stats: Record<string, number> = {}
  const errors: { source: string; message: string }[] = []
  const items: RawItem[] = []

  for (const feed of NEWSNOW_FEEDS.filter((entry) => entry.section === section)) {
    try {
      const result = await fetchNewsNow(feed.id, feed.source)
      stats[`newsnow.${feed.id}`] = result.length
      items.push(...result)
    } catch (error) {
      stats[`newsnow.${feed.id}`] = 0
      errors.push({
        source: `newsnow.${feed.id}`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { items, stats, errors }
}

export { normalizeTitle }
