import type { NewspaperSectionKey, RawItem, RawMaterial } from './types.js'
import { SECTION_KEYS } from './types.js'
import { normalizeTitle } from './http.js'
import { fetchHotPool } from './sources/hot.js'
import {
  fetchBbcWorld,
  fetchBingNews,
  fetchChinanews,
  fetchNewsNowPool,
  search360,
} from './sources/news.js'
import { fetch19louHot } from './sources/local.js'
import { fetchBiliGossip } from './sources/bili.js'
import { fetchSteam } from './sources/steam.js'

type Query = { q: string; maxAgeHours?: number }

const NEWS_QUERIES: Record<NewspaperSectionKey, Query[]> = {
  hangzhou: [
    { q: '杭州', maxAgeHours: 168 },
    { q: '杭州 突发', maxAgeHours: 168 },
    { q: '杭州 民生', maxAgeHours: 168 },
    { q: '杭州 小区 维权', maxAgeHours: 168 },
  ],
  benxi: [
    { q: '本溪', maxAgeHours: 240 },
    { q: '本溪 民生', maxAgeHours: 240 },
    { q: '本溪 供暖', maxAgeHours: 240 },
    { q: '本溪 交通 出行', maxAgeHours: 240 },
    { q: '本溪 贴吧 网友', maxAgeHours: 240 },
  ],
  bili: [],
  steam: [
    { q: 'Steam 游戏', maxAgeHours: 168 },
    { q: 'Steam 新游', maxAgeHours: 168 },
    { q: 'Steam 差评 争议', maxAgeHours: 168 },
  ],
  china: [
    { q: '中国 新闻', maxAgeHours: 72 },
    { q: '中国 社会 热点', maxAgeHours: 72 },
    { q: '中国经济 政策', maxAgeHours: 72 },
  ],
  world: [
    { q: '国际新闻', maxAgeHours: 72 },
    { q: '国际 局势', maxAgeHours: 72 },
    { q: '世界 热点', maxAgeHours: 72 },
  ],
}

const BING_QUERIES: Partial<Record<NewspaperSectionKey, Query[]>> = {
  hangzhou: [{ q: '杭州 新闻', maxAgeHours: 168 }],
  benxi: [{ q: '本溪 新闻', maxAgeHours: 240 }],
  china: [{ q: '中国 新闻', maxAgeHours: 96 }],
  world: [{ q: 'world news', maxAgeHours: 96 }],
  steam: [{ q: 'Steam 游戏', maxAgeHours: 168 }],
}

const LOCAL_KEYWORDS: Partial<Record<NewspaperSectionKey, string[]>> = {
  hangzhou: ['杭州', '浙江', '西湖', '钱塘', '萧山', '余杭', '临平', '滨江', '拱墅'],
  benxi: ['本溪', '桓仁', '平山', '明山', '溪湖', '南芬', '辽宁'],
  bili: ['B站', 'bilibili', 'UP主', '主播', '粉丝', '站姐', '塌房'],
  steam: ['Steam', 'steam', '游戏', '新游', '独立游戏', '主机', '电竞'],
}

function hasOverlap(a: string, b: string): boolean {
  const left = normalizeTitle(a)
  const right = normalizeTitle(b)
  if (!left || !right) return false
  if (left.includes(right) || right.includes(left)) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  const size = Math.min(6, Math.max(3, Math.floor(shorter.length / 3)))
  for (let i = 0; i + size <= shorter.length; i++) {
    if (longer.includes(shorter.slice(i, i + size))) return true
  }
  return false
}

function addItems(target: RawItem[], items: RawItem[], cap = 70): void {
  const seenUrl = new Set(target.map((item) => item.url).filter(Boolean) as string[])
  const seenTitle = new Set(target.map((item) => normalizeTitle(item.title)))

  for (const item of items) {
    const titleKey = normalizeTitle(item.title)
    if (!titleKey) continue
    if (item.url && seenUrl.has(item.url)) continue
    if (seenTitle.has(titleKey)) continue
    target.push({ ...item })
    if (item.url) seenUrl.add(item.url)
    seenTitle.add(titleKey)
    if (target.length >= cap) break
  }
}

function hotItemsFor(section: NewspaperSectionKey, hotItems: RawItem[]): RawItem[] {
  if (section === 'china') return hotItems
  const keywords = LOCAL_KEYWORDS[section]
  if (!keywords?.length) return []
  return hotItems.filter((item) => keywords.some((keyword) => item.title.includes(keyword)))
}

async function safeStat<T>(
  name: string,
  run: () => Promise<T>,
  stats: Record<string, number>,
  errors: { source: string; message: string }[],
): Promise<T | null> {
  try {
    const value = await run()
    return value
  } catch (error) {
    stats[name] = 0
    errors.push({
      source: name,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export async function collectRawMaterial(): Promise<RawMaterial> {
  const stats: Record<string, number> = {}
  const errors: { source: string; message: string }[] = []

  const [hotPool, bili, steam, chinanews, bbc, newsnowChina, newsnowWorld, local19lou] =
    await Promise.all([
      safeStat('hot.pool', fetchHotPool, stats, errors),
      safeStat('bili', fetchBiliGossip, stats, errors),
      safeStat('steam', fetchSteam, stats, errors),
      safeStat('rss.chinanews', fetchChinanews, stats, errors),
      safeStat('rss.bbc', fetchBbcWorld, stats, errors),
      safeStat('newsnow.china', () => fetchNewsNowPool('china'), stats, errors),
      safeStat('newsnow.world', () => fetchNewsNowPool('world'), stats, errors),
      safeStat('local.19lou', fetch19louHot, stats, errors),
    ])

  if (hotPool) {
    Object.assign(stats, hotPool.stats)
    errors.push(...hotPool.errors)
    stats['hot.pool'] = hotPool.items.length
  }
  if (bili) {
    Object.assign(stats, bili.stats)
    errors.push(...bili.errors)
    stats.bili = bili.items.length
  }
  if (steam) {
    Object.assign(stats, steam.stats)
    errors.push(...steam.errors)
    stats.steam = steam.items.length
  }
  if (newsnowChina) {
    Object.assign(stats, newsnowChina.stats)
    errors.push(...newsnowChina.errors)
    stats['newsnow.china'] = newsnowChina.items.length
  }
  if (newsnowWorld) {
    Object.assign(stats, newsnowWorld.stats)
    errors.push(...newsnowWorld.errors)
    stats['newsnow.world'] = newsnowWorld.items.length
  }
  if (chinanews) stats['rss.chinanews'] = chinanews.length
  if (bbc) stats['rss.bbc'] = bbc.length
  if (local19lou) stats['local.19lou'] = local19lou.length

  const hotItems = hotPool?.items ?? []

  // 热搜条目大多没有摘要：先补事实和原文链接，再分发到各版块
  const enrichTargets = hotItems.filter((item) => !item.summary).slice(0, 8)
  for (const item of enrichTargets) {
    try {
      const results = await search360(item.title, 96, 'focus')
      const match = results.find((candidate) => hasOverlap(candidate.title, item.title))
      if (!match) continue
      item.summary = match.summary || item.summary
      item.url = match.url ?? item.url
      item.source = `${item.source} / ${match.source}`
      item.publishedAt = match.publishedAt ?? item.publishedAt
      item.publishedLabel = match.publishedLabel ?? item.publishedLabel
      item.kind = match.kind === 'official' ? 'mixed' : match.kind
      stats['hot.enriched'] = (stats['hot.enriched'] ?? 0) + 1
    } catch {
      /* 单条补充失败不影响整期 */
    }
  }

  const bySection = Object.fromEntries(
    SECTION_KEYS.map((key) => [key, [] as RawItem[]]),
  ) as Record<NewspaperSectionKey, RawItem[]>

  for (const key of SECTION_KEYS) {
    // 民间热搜先放，避免被后面的新闻/聚合源挤掉
    const matchedHot = hotItemsFor(key, hotItems)
    if (matchedHot.length) {
      stats[`hot.match.${key}`] = matchedHot.length
      addItems(bySection[key], matchedHot.slice(0, 35), 90)
    }

    const queries = NEWS_QUERIES[key]
    for (const query of queries) {
      const name = `news360.${key}.${query.q}`
      const items = await safeStat(
        name,
        () => search360(query.q, query.maxAgeHours ?? 96),
        stats,
        errors,
      )
      if (!items) continue
      stats[name] = items.length
      addItems(bySection[key], items, 90)
    }

    for (const query of BING_QUERIES[key] ?? []) {
      const name = `bing.${key}.${query.q}`
      const items = await safeStat(
        name,
        () => fetchBingNews(query.q, query.maxAgeHours ?? 96),
        stats,
        errors,
      )
      if (!items) continue
      stats[name] = items.length
      addItems(bySection[key], items, 90)
    }
  }

  // 官方/媒体源放在热搜之后，保证民间条目一定进池
  if (chinanews) addItems(bySection.china, chinanews, 90)
  if (newsnowChina) addItems(bySection.china, newsnowChina.items, 90)
  if (bbc) addItems(bySection.world, bbc, 90)
  if (newsnowWorld) addItems(bySection.world, newsnowWorld.items, 90)

  // 本地民间：19楼只服务杭州
  if (local19lou) addItems(bySection.hangzhou, local19lou, 90)

  // B站：热搜 + 评论 + 热门/争议搜索
  if (hotItems.length) {
    addItems(
      bySection.bili,
      hotItems.filter((item) => item.source === 'B站热搜'),
      90,
    )
  }
  if (bili) {
    const comments = bili.items.filter((item) => item.tags.includes('粉丝评论'))
    const others = bili.items.filter((item) => !item.tags.includes('粉丝评论'))
    addItems(bySection.bili, comments, 90)
    addItems(bySection.bili, others, 90)
  }
  if (steam) addItems(bySection.steam, steam.items, 90)

  for (const key of SECTION_KEYS) {
    stats[`section.${key}`] = bySection[key].length
  }

  return {
    bySection,
    stats,
    errors,
    collectedAt: new Date().toISOString(),
  }
}
