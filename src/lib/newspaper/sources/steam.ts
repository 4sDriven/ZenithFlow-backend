import type { RawItem } from '../types.js'
import { clip, fetchJson, isFresh, stripHtml } from '../http.js'

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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function price(value: unknown): string {
  const cents = num(value)
  if (!cents) return '免费'
  return `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
}

type StoreItem = {
  id: number
  name: string
  discountPercent: number
  originalPrice: number
  finalPrice: number
  currency: string
}

function normalizeStoreItem(entry: unknown): StoreItem | null {
  const record = asRecord(entry)
  if (!record) return null
  const id = num(record.id)
  const name = text(record.name)
  if (!id || !name) return null
  return {
    id,
    name,
    discountPercent: num(record.discount_percent),
    originalPrice: num(record.original_price),
    finalPrice: num(record.final_price),
    currency: text(record.currency),
  }
}

function storeItemToRaw(item: StoreItem, heat: string, tag: string): RawItem {
  const priceText =
    item.discountPercent > 0
      ? `原价 ${price(item.originalPrice)}，现价 ${price(item.finalPrice)}（-${item.discountPercent}%）`
      : price(item.finalPrice)

  return {
    title: `《${item.name}》`,
    summary: `${tag}：${priceText}`,
    source: 'Steam',
    url: `https://store.steampowered.com/app/${item.id}/`,
    publishedAt: null,
    publishedLabel: null,
    heat,
    kind: 'mixed',
    tags: ['Steam', tag],
  }
}

type NewsItem = {
  gid: string
  title: string
  url: string
  contents: string
  date: number
  feedlabel: string
  appid: number
}

const TRACKED_APPS: { appid: number; name: string }[] = [
  { appid: 730, name: 'CS2' },
  { appid: 570, name: 'Dota 2' },
  { appid: 578080, name: 'PUBG' },
  { appid: 1245620, name: '艾尔登法环' },
  { appid: 2358720, name: '黑神话：悟空' },
  { appid: 1086940, name: '博德之门 3' },
  { appid: 1091500, name: '赛博朋克 2077' },
  { appid: 413150, name: '星露谷物语' },
]

async function fetchAppNews(appid: number, appName: string, count = 3): Promise<RawItem[]> {
  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=${count}&maxlength=400&l=schinese&cc=CN`
  const data = await fetchJson<Json>(url, { timeoutMs: 15_000 })
  const list = asArray(asRecord(data.appnews)?.newsitems)
  const items: RawItem[] = []

  for (const entry of list) {
    const record = asRecord(entry)
    if (!record) continue
    const title = text(record.title)
    const link = text(record.url)
    const date = num(record.date)
    if (!title || !link) continue
    const publishedAt = date ? new Date(date * 1000).toISOString() : null
    if (!isFresh(publishedAt, 24 * 14)) continue

    items.push({
      title: clip(stripHtml(title), 140),
      summary: clip(stripHtml(text(record.contents)), 280),
      source: `Steam 官方 · ${appName}`,
      url: link,
      publishedAt,
      publishedLabel: null,
      heat: null,
      kind: 'official',
      tags: ['Steam', '更新'],
    })
  }

  return items
}

export type SteamSourceResult = {
  items: RawItem[]
  stats: Record<string, number>
  errors: { source: string; message: string }[]
}

export async function fetchSteam(): Promise<SteamSourceResult> {
  const stats: Record<string, number> = {}
  const errors: { source: string; message: string }[] = []
  const items: RawItem[] = []

  try {
    const data = await fetchJson<Json>(
      'https://store.steampowered.com/api/featuredcategories?cc=cn&l=schinese',
      { timeoutMs: 18_000 },
    )
    const top = asArray(asRecord(data.top_sellers)?.items)
      .map(normalizeStoreItem)
      .filter((item): item is StoreItem => item !== null)
      .slice(0, 10)
    const fresh = asArray(asRecord(data.new_releases)?.items)
      .map(normalizeStoreItem)
      .filter((item): item is StoreItem => item !== null)
      .slice(0, 8)
    const specials = asArray(asRecord(data.specials)?.items)
      .map(normalizeStoreItem)
      .filter((item): item is StoreItem => item !== null)
      .slice(0, 8)

    top.forEach((item, index) => items.push(storeItemToRaw(item, `Steam 热销第 ${index + 1}`, '热销')))
    fresh.forEach((item, index) => items.push(storeItemToRaw(item, `Steam 新品第 ${index + 1}`, '新品')))
    specials.forEach((item, index) =>
      items.push(storeItemToRaw(item, `Steam 特惠第 ${index + 1}`, '特惠')),
    )

    stats['steam.store'] = top.length + fresh.length + specials.length

    // 给热销/新品前几条补中文简介，方便编辑写“这游戏是什么”
    const detailIds = [...new Set([...top.slice(0, 4), ...fresh.slice(0, 3)].map((item) => item.id))]
    for (const appid of detailIds) {
      try {
        const detail = await fetchJson<Json>(
          `https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=cn`,
          { timeoutMs: 15_000 },
        )
        const entry = asRecord(detail[String(appid)])
        const dataRecord = asRecord(entry?.data)
        if (!dataRecord) continue
        const name = text(dataRecord.name)
        const intro = text(dataRecord.short_description)
        if (!name || !intro) continue
        const target = items.find((item) => item.title === `《${name}》`)
        if (target && !target.summary.includes(intro.slice(0, 12))) {
          target.summary = clip(`${target.summary}；${intro}`, 280)
        }
      } catch {
        /* 单条详情失败不影响整版 */
      }
    }
    stats['steam.details'] = detailIds.length
  } catch (error) {
    stats['steam.store'] = 0
    errors.push({
      source: 'steam.store',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  for (const app of TRACKED_APPS) {
    try {
      const news = await fetchAppNews(app.appid, app.name)
      stats[`steam.news.${app.appid}`] = news.length
      items.push(...news)
    } catch (error) {
      stats[`steam.news.${app.appid}`] = 0
      errors.push({
        source: `steam.news.${app.appid}`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { items, stats, errors }
}
