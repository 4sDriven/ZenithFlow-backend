import type { TranscriptTurn, VocabularyEntry } from '../db/schema.js'

const USER_AGENT = 'Mozilla/5.0 (compatible; ZenithFlow/1.0)'

export const DEFAULT_SERIES = [
  {
    slug: '6-minute-english',
    name: '6 Minute English',
    feedUrl: 'https://feeds.bbci.co.uk/learningenglish/english/features/6-minute-english/rss',
  },
  {
    slug: 'the-english-we-speak',
    name: 'The English We Speak',
    feedUrl: 'https://feeds.bbci.co.uk/learningenglish/english/features/the-english-we-speak/rss',
  },
] as const

export type FeedItem = {
  guid: string
  title: string
  pageUrl: string
  thumbnailUrl: string | null
  publishedAt: Date | null
}

export type EpisodeContent = {
  title: string
  thumbnailUrl: string | null
  audioUrl: string | null
  transcript: TranscriptTurn[]
  vocabulary: VocabularyEntry[]
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
}

function cleanInline(input: string): string {
  return decodeEntities(
    input
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`抓取失败 (${res.status})`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function publishedAtFromUrl(url: string): Date | null {
  const match = url.match(/ep-(\d{2})(\d{2})(\d{2})/)
  if (!match) return null
  const [, yy, mm, dd] = match
  const date = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), 0, 0, 0))
  return Number.isNaN(date.getTime()) ? null : date
}

function stripTitlePrefix(title: string): string {
  const idx = title.lastIndexOf(' / ')
  return (idx >= 0 ? title.slice(idx + 3) : title).trim()
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? ''
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
    if (!link) continue

    const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() || link
    const rawTitle = block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''
    const thumbnail = block.match(/<media:thumbnail[^>]*\burl="([^"]+)"/)?.[1] ?? null

    items.push({
      guid,
      title: stripTitlePrefix(decodeEntities(rawTitle).trim()),
      pageUrl: decodeEntities(link),
      thumbnailUrl: thumbnail,
      publishedAt: publishedAtFromUrl(link),
    })
  }

  return items
}

/**
 * 文稿正文之后紧跟的是「Next / Vocabulary」标题、相关推荐、页脚导航与内联脚本。
 * 旧实现只裁到 <footer>，导致最后一句会把整页剩余内容（含 BBCLECourseStructure
 * 之类的内联 JSON/JS）一起吞进去。这里按第一个「正文之外」的结构块截断。
 */
const TRANSCRIPT_BODY_END_RE =
  /<h[1-4][\s>]|<script[\s>]|<style[\s>]|<footer[\s>]|<div[^>]*class="[^"]*\bbbcle-footer|<p>\s*<strong[^>]*>\s*Next\s*<\/strong>\s*<\/p>/i

function trimTranscriptBody(seg: string): string {
  const end = seg.match(TRANSCRIPT_BODY_END_RE)
  return end && end.index !== undefined ? seg.slice(0, end.index) : seg
}

export function parseTranscript(html: string): TranscriptTurn[] {
  const marker = html.match(/<strong[^>]*>\s*TRANSCRIPT\s*<\/strong>/i)
  if (!marker || marker.index === undefined) return []

  let seg = trimTranscriptBody(html.slice(marker.index + marker[0].length))
  const footerIdx = seg.search(/<footer[\s>]/i)
  if (footerIdx >= 0) seg = seg.slice(0, footerIdx)

  const blocks: { speaker: string; matchStart: number; textStart: number }[] = []
  const re =
    /<strong[^>]*>\s*([^<]+?)\s*(?:<br\s*\/?>\s*<\/strong>|<\/strong>\s*<br\s*\/?>)\s*(?:<br\s*\/?>)?/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(seg)) !== null) {
    blocks.push({
      speaker: cleanInline(match[1] ?? ''),
      matchStart: match.index,
      textStart: re.lastIndex,
    })
  }

  const turns: TranscriptTurn[] = []
  for (let i = 0; i < blocks.length; i++) {
    const current = blocks[i]
    if (!current) continue
    if (!current.speaker || /^(transcript|vocabulary|note)$/i.test(current.speaker)) continue
    const next = blocks[i + 1]
    const end = next ? next.matchStart : seg.length
    const text = cleanInline(seg.slice(current.textStart, end))
    if (text) turns.push({ speaker: current.speaker, text })
  }

  return turns
}

export function parseVocabulary(html: string): VocabularyEntry[] {
  const section = html.match(/<h3>\s*Vocabulary\s*<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i)
  if (!section) return []

  const content = section[1] ?? ''
  const entries: VocabularyEntry[] = []
  const entryRe = /<strong>([^<]+)<\/strong>([\s\S]*?)(?=<strong>|$)/gi
  let match: RegExpExecArray | null

  while ((match = entryRe.exec(content)) !== null) {
    const word = cleanInline(match[1] ?? '')
    const meaning = cleanInline(match[2] ?? '')
    if (word && meaning) entries.push({ word, meaning })
  }

  return entries
}

export async function fetchFeed(feedUrl: string, limit = 40): Promise<FeedItem[]> {
  const xml = await fetchText(feedUrl)
  return parseFeed(xml).slice(0, limit)
}

export async function fetchEpisode(pageUrl: string): Promise<EpisodeContent> {
  const html = await fetchText(pageUrl, 30_000)

  const rawTitle =
    html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    pageUrl

  const thumbnailUrl = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null
  const audioUrl = html.match(/(https:\/\/downloads\.bbc\.co\.uk\/[^"']+\.mp3)/)?.[1] ?? null

  return {
    title: stripTitlePrefix(decodeEntities(rawTitle).trim()),
    thumbnailUrl,
    audioUrl,
    transcript: parseTranscript(html),
    vocabulary: parseVocabulary(html),
  }
}
