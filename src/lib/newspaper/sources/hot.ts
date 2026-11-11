import type { RawItem } from '../types.js'
import { clip, decodeEntities, fetchJson, normalizeTitle, parseCnTime, stripHtml } from '../http.js'

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

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

function hotItem(params: {
  title: string
  summary?: string
  source: string
  url: string | null
  heat: string
  kind?: RawItem['kind']
  publishedAt?: string | null
  publishedLabel?: string | null
}): RawItem {
  return {
    title: clip(stripHtml(params.title), 120),
    summary: clip(stripHtml(params.summary ?? ''), 240),
    source: params.source,
    url: params.url,
    publishedAt: params.publishedAt ?? null,
    publishedLabel: params.publishedLabel ?? null,
    heat: params.heat,
    kind: params.kind ?? 'folk',
    tags: ['热搜'],
  }
}

function dedupe(items: RawItem[]): RawItem[] {
  const seen = new Set<string>()
  const result: RawItem[] = []
  for (const item of items) {
    const key = item.url ? `u:${item.url}` : `t:${normalizeTitle(item.title)}`
    const titleKey = normalizeTitle(item.title)
    if (!titleKey || seen.has(key) || seen.has(`t:${titleKey}`)) continue
    seen.add(key)
    seen.add(`t:${titleKey}`)
    result.push(item)
  }
  return result
}

/** 百度热搜：接口里 cards/content 嵌套层级不固定，递归收集 word + url */
export async function fetchBaiduHot(): Promise<RawItem[]> {
  const data = await fetchJson<Json>('https://top.baidu.com/api/board?platform=wise&tab=realtime')
  const found: Json[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    const record = asRecord(value)
    if (!record) return
    if (typeof record.word === 'string' && typeof record.url === 'string') found.push(record)
    for (const child of Object.values(record)) walk(child)
  }
  walk(data.data)

  return found
    .filter((item) => item.isTop !== true)
    .map((item, index) =>
      hotItem({
        title: text(item.word),
        source: '百度热搜',
        url: text(item.url) || null,
        heat: `百度热搜第 ${num(item.index) ?? index + 1}`,
      }),
    )
    .filter((item) => item.title.length > 0)
}

export async function fetchZhihuHot(): Promise<RawItem[]> {
  const data = await fetchJson<Json>('https://api.zhihu.com/topstory/hot-list', {
    headers: { Referer: 'https://www.zhihu.com/hot' },
  })
  const list = asArray(data.data)
  const items: RawItem[] = []
  list.forEach((entry, index) => {
    const target = asRecord(asRecord(entry)?.target)
    if (!target) return
    const title = text(target.title)
    if (!title) return
    const apiUrl = text(target.url)
    const questionId = apiUrl.match(/questions\/(\d+)/)?.[1]
    const url = questionId ? `https://www.zhihu.com/question/${questionId}` : null
    const created = num(target.created)
    items.push(
      hotItem({
        title,
        summary: text(target.excerpt),
        source: '知乎热榜',
        url,
        heat: `知乎热榜第 ${index + 1}`,
        publishedAt: created ? new Date(created * 1000).toISOString() : null,
        publishedLabel: null,
      }),
    )
  })
  return items
}

export async function fetchDouyinHot(): Promise<RawItem[]> {
  const data = await fetchJson<Json>(
    'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383',
    { headers: { Referer: 'https://www.douyin.com/' } },
  )
  const list = asArray(asRecord(data.data)?.word_list)
  return list
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) return null
      const word = text(record.word)
      if (!word) return null
      const sentenceId = text(record.sentence_id)
      const hotValue = num(record.hot_value)
      return hotItem({
        title: word,
        summary: hotValue ? `抖音热度 ${hotValue.toLocaleString('zh-CN')}` : '',
        source: '抖音热榜',
        url: sentenceId ? `https://www.douyin.com/hot/${sentenceId}` : null,
        heat: `抖音热榜第 ${num(record.position) ?? index + 1}`,
      })
    })
    .filter((item): item is RawItem => item !== null)
}

export async function fetchTiebaHot(): Promise<RawItem[]> {
  const data = await fetchJson<Json>('https://tieba.baidu.com/hottopic/browse/topicList', {
    headers: { Referer: 'https://tieba.baidu.com/' },
  })
  const list = asArray(asRecord(asRecord(data.data)?.bang_topic)?.topic_list)
  return list
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) return null
      const title = text(record.topic_name)
      if (!title) return null
      const url = decodeEntities(text(record.topic_url))
      return hotItem({
        title,
        summary: text(record.topic_desc) || text(record.abstract),
        source: '贴吧热议',
        url: url || null,
        heat: `贴吧热议第 ${num(record.idx_num) ?? 0}`,
        publishedAt: num(record.create_time)
          ? new Date(Number(record.create_time) * 1000).toISOString()
          : null,
      })
    })
    .filter((item): item is RawItem => item !== null)
}

/** 微博热搜直连 403，用 NewsNow 公共聚合做补充；失败就跳过 */
export async function fetchWeiboHot(): Promise<RawItem[]> {
  const data = await fetchJson<Json>('https://newsnow.busiyi.world/api/s?id=weibo', {
    timeoutMs: 12_000,
  })
  if (text(data.status) === 'failed') throw new Error('聚合源返回失败')
  const list = asArray(data.items)
  return list
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) return null
      const title = text(record.title)
      if (!title) return null
      const url = text(record.mobileUrl) || text(record.url)
      const rank = url.match(/band_rank=(\d+)/)?.[1]
      return hotItem({
        title,
        source: '微博热搜',
        url: url || null,
        heat: `微博热搜第 ${rank ? Number(rank) : index + 1}`,
      })
    })
    .filter((item): item is RawItem => item !== null)
}

export async function fetchBiliHotwords(): Promise<RawItem[]> {
  const data = await fetchJson<Json>('https://s.search.bilibili.com/main/hotword')
  const list = asArray(data.list)
  return list
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) return null
      const keyword = text(record.keyword) || text(record.show_name)
      if (!keyword) return null
      return hotItem({
        title: keyword,
        source: 'B站热搜',
        url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
        heat: `B站热搜第 ${num(record.pos) ?? index + 1}`,
        kind: 'folk',
      })
    })
    .filter((item): item is RawItem => item !== null)
}

export type HotPool = {
  items: RawItem[]
  stats: Record<string, number>
  errors: { source: string; message: string }[]
}

export async function fetchHotPool(): Promise<HotPool> {
  const jobs: { name: string; run: () => Promise<RawItem[]> }[] = [
    { name: 'hot.baidu', run: fetchBaiduHot },
    { name: 'hot.zhihu', run: fetchZhihuHot },
    { name: 'hot.douyin', run: fetchDouyinHot },
    { name: 'hot.tieba', run: fetchTiebaHot },
    { name: 'hot.weibo', run: fetchWeiboHot },
    { name: 'hot.bili', run: fetchBiliHotwords },
  ]

  const stats: Record<string, number> = {}
  const errors: { source: string; message: string }[] = []
  const all: RawItem[] = []

  for (const job of jobs) {
    try {
      const items = await job.run()
      stats[job.name] = items.length
      all.push(...items)
    } catch (error) {
      stats[job.name] = 0
      errors.push({
        source: job.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 同一个话题可能在多个榜单出现，保留第一次（百度/知乎等顺序）并补上其它榜单的热度
  const merged = new Map<string, RawItem>()
  for (const item of all) {
    const key = normalizeTitle(item.title)
    if (!key) continue
    const existing = merged.get(key)
    if (existing) {
      if (!existing.summary && item.summary) existing.summary = item.summary
      if (item.heat && !existing.heat?.includes(item.source)) {
        existing.heat = `${existing.heat} · ${item.heat}`
      }
      continue
    }
    merged.set(key, { ...item })
  }

  return { items: dedupe([...merged.values()]), stats, errors }
}

export { dedupe as dedupeRawItems }
