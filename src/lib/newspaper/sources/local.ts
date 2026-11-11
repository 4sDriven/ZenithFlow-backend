import type { RawItem } from '../types.js'
import { fetchText, normalizeTitle, stripHtml } from '../http.js'

/** 19楼是 GB18030 编码，抓首页和帮帮团版块的热帖标题 */
function extractThreads(html: string): RawItem[] {
  const items: RawItem[] = []
  const re =
    /<a[^>]+href="([^"]*forum-\d+-thread-\d+-1-1\.html[^"]*)"[^>]*?(?:title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const href = (match[1] ?? '').trim()
    const title = stripHtml(match[2] ?? match[3] ?? '')
    if (!href || title.length < 6 || title.length > 80) continue
    if (/版规|公告|签到|活动|招聘|广告|租房|二手房|征婚|交友/.test(title)) continue
    items.push({
      title,
      summary: '',
      source: '19楼',
      url: href.startsWith('//') ? `https:${href}` : href,
      publishedAt: null,
      publishedLabel: null,
      heat: null,
      kind: 'folk',
      tags: ['杭州本地'],
    })
  }
  return items
}

export async function fetch19louHot(): Promise<RawItem[]> {
  const pages = ['https://www.19lou.com/', 'https://www.19lou.com/forum-79-1.html']
  const all: RawItem[] = []
  const seen = new Set<string>()

  for (const page of pages) {
    const html = await fetchText(page, {
      timeoutMs: 18_000,
      charset: 'gb18030',
      headers: { Referer: 'https://www.19lou.com/' },
    })
    for (const item of extractThreads(html)) {
      const key = normalizeTitle(item.title)
      if (!key || seen.has(key)) continue
      seen.add(key)
      all.push(item)
    }
    if (all.length >= 16) break
  }

  return all.slice(0, 16)
}
