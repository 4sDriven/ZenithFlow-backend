import type { RawItem } from '../types.js'
import { clip, fetchJson, stripHtml } from '../http.js'
import { fetchCommentBatch, searchVideos, type BiliVideo } from '../../bilibili.js'

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

type PopularVideo = {
  bvid: string
  aid: number
  title: string
  ownerName: string
  ownerMid: string
  desc: string
  pubdate: number
  view: number
  like: number
  reply: number
  tname: string
}

async function fetchPopular(): Promise<PopularVideo[]> {
  const data = await fetchJson<Json>('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=30', {
    timeoutMs: 15_000,
    headers: { Referer: 'https://www.bilibili.com/' },
  })
  const list = asArray(asRecord(data.data)?.list)
  const result: PopularVideo[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    if (!record) continue
    const bvid = text(record.bvid)
    const title = text(record.title)
    if (!bvid || !title) continue
    const owner = asRecord(record.owner)
    const stat = asRecord(record.stat)
    result.push({
      bvid,
      aid: num(record.aid),
      title,
      ownerName: text(owner?.name),
      ownerMid: String(num(owner?.mid)),
      desc: text(record.desc),
      pubdate: num(record.pubdate),
      view: num(stat?.view),
      like: num(stat?.like),
      reply: num(stat?.reply),
      tname: text(record.tname),
    })
  }
  return result
}

function toItem(video: PopularVideo, heat: string | null, tags: string[]): RawItem {
  return {
    title: clip(stripHtml(video.title), 120),
    summary: clip(
      `UP主：${video.ownerName || '未知'}；播放 ${video.view.toLocaleString('zh-CN')}；评论 ${video.reply.toLocaleString('zh-CN')}${video.desc ? `；简介：${stripHtml(video.desc)}` : ''}`,
      260,
    ),
    source: 'B站',
    url: `https://www.bilibili.com/video/${video.bvid}`,
    publishedAt: video.pubdate ? new Date(video.pubdate * 1000).toISOString() : null,
    publishedLabel: null,
    heat,
    kind: 'folk',
    tags: ['视频', video.tname].filter(Boolean),
  }
}

const GOSSIP_KEYWORDS = [
  '塌房',
  '争议',
  '回应',
  '道歉',
  '粉丝 吵架',
  '拉踩',
  '控评',
  '翻车',
  '辟谣',
  'UP主 争议',
]

export type BiliSourceResult = {
  items: RawItem[]
  stats: Record<string, number>
  errors: { source: string; message: string }[]
}

export async function fetchBiliGossip(): Promise<BiliSourceResult> {
  const stats: Record<string, number> = {}
  const errors: { source: string; message: string }[] = []
  const items: RawItem[] = []
  const seen = new Set<string>()

  let popular: PopularVideo[] = []
  try {
    popular = await fetchPopular()
    stats['bili.popular'] = popular.length
    popular.slice(0, 30).forEach((video, index) => {
      if (seen.has(video.bvid)) return
      seen.add(video.bvid)
      items.push(toItem(video, `B站热门第 ${index + 1}`, ['热门']))
    })
  } catch (error) {
    stats['bili.popular'] = 0
    errors.push({
      source: 'bili.popular',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const freshCutoff = Date.now() - 72 * 3_600_000
  const candidates: PopularVideo[] = []

  for (const keyword of GOSSIP_KEYWORDS) {
    try {
      const result = await searchVideos(keyword, 1)
      let fresh = 0
      for (const video of result.videos) {
        const publishedAt = video.pubdate ? video.pubdate * 1000 : 0
        if (publishedAt && publishedAt < freshCutoff) continue
        fresh += 1
        if (seen.has(video.bvid)) continue
        seen.add(video.bvid)
        const mapped: PopularVideo = {
          bvid: video.bvid,
          aid: video.aid,
          title: video.title,
          ownerName: video.author,
          ownerMid: video.mid,
          desc: '',
          pubdate: video.pubdate,
          view: video.play,
          like: video.like,
          reply: video.review,
          tname: video.typename,
        }
        items.push(toItem(mapped, `B站搜索「${keyword}」· ${video.heatLabel}`, ['争议搜索']))
        candidates.push(mapped)
      }
      stats[`bili.search.${keyword}`] = fresh
    } catch (error) {
      stats[`bili.search.${keyword}`] = 0
      errors.push({
        source: `bili.search.${keyword}`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 给最像“瓜”的几条补评论区，看看粉丝在吵什么
  const targets = candidates
    .filter((video) => video.reply >= 20)
    .sort((a, b) => b.reply - a.reply)
    .slice(0, 3)

  for (const target of targets) {
    try {
      const video: BiliVideo = {
        bvid: target.bvid,
        aid: target.aid,
        title: target.title,
        ownerMid: target.ownerMid,
        ownerName: target.ownerName,
        cover: '',
        pubdate: target.pubdate,
        duration: 0,
        commentCount: target.reply,
      }
      const batch = await fetchCommentBatch(video, { page: 1, offset: 0 }, 30, 'hot')
      const comments = batch.comments
        .filter((comment) => comment.message.trim().length > 8)
        .sort((a, b) => b.like - a.like)
        .slice(0, 4)
      if (!comments.length) continue
      items.push({
        title: `评论区在聊：${clip(stripHtml(target.title), 60)}`,
        summary: clip(
          comments
            .map((comment) => `${comment.uname}（赞${comment.like}）：${stripHtml(comment.message)}`)
            .join(' / '),
          300,
        ),
        source: 'B站评论区',
        url: `https://www.bilibili.com/video/${target.bvid}`,
        publishedAt: target.pubdate ? new Date(target.pubdate * 1000).toISOString() : null,
        publishedLabel: null,
        heat: null,
        kind: 'folk',
        tags: ['粉丝评论'],
      })
      stats['bili.comments'] = (stats['bili.comments'] ?? 0) + 1
    } catch (error) {
      stats['bili.comments'] = stats['bili.comments'] ?? 0
      errors.push({
        source: 'bili.comments',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { items, stats, errors }
}
