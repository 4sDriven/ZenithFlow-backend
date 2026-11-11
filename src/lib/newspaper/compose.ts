import { config } from '../../config.js'
import type {
  NewspaperItem,
  NewspaperItemKind,
  NewspaperSection,
  RawItem,
  SectionMeta,
} from './types.js'
import { SECTION_KEYS, SECTION_META } from './types.js'
import { clip, normalizeTitle, stripHtml } from './http.js'

const BASE = config.DASHSCOPE_BASE_URL.replace(/\/$/, '')
const MODEL = 'qwen-plus'
const MAX_PROMPT_ITEMS = 55

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced?.[1] ?? text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
  return JSON.parse(candidate)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumberArray(value: unknown): number[] {
  return asArray(value)
    .map((entry) => (typeof entry === 'number' ? entry : Number(entry)))
    .filter((entry) => Number.isInteger(entry) && entry > 0)
}

function deriveKind(sources: RawItem[]): NewspaperItemKind {
  const kinds = [...new Set(sources.map((source) => source.kind))]
  if (kinds.length === 1) return kinds[0] ?? 'mixed'
  return 'mixed'
}

function numbersOf(input: string): string[] {
  return input.match(/\d+(?:\.\d+)?/g) ?? []
}

/** AI 很容易补“转发量/阅读量”之类的数字，素材里没有的就视为编造 */
function hasUnsupportedNumbers(summary: string, title: string, sources: RawItem[]): boolean {
  const supported = new Set(
    numbersOf([title, ...sources.map((source) => `${source.title} ${source.summary} ${source.heat ?? ''}`)].join(' ')),
  )
  return numbersOf(summary).some((value) => value.length >= 2 && !supported.has(value))
}

function stripCitationMarkers(input: string): string {
  return input.replace(/[（(]?\s*\[\d+\]\s*[）)]?/g, '').replace(/\s{2,}/g, ' ').trim()
}

function looksEnglish(input: string): boolean {
  const letters = (input.match(/[A-Za-z]/g) ?? []).length
  const cjk = (input.match(/[\u4e00-\u9fa5]/g) ?? []).length
  if (cjk === 0) return letters > 20
  return letters > 40 && cjk < letters / 4
}

function safeFallbackSummary(title: string, sources: RawItem[]): string {
  const detailed = sources.find((source) => source.summary && source.summary.length >= 20)
  if (detailed?.summary) return clip(detailed.summary, 300)
  const heat = sources.find((source) => source.heat)?.heat
  return `围绕「${title}」的讨论正在${heat ?? '网络'}上发酵，具体进展以原始讨论为准。`
}

function folkCandidate(raw: RawItem): NewspaperItem {
  return {
    title: clip(raw.title, 60),
    summary: raw.summary || `「${raw.title}」正在${raw.heat ?? '本地社区'}引发讨论。`,
    source: raw.source,
    url: raw.url,
    publishedAt: raw.publishedAt,
    publishedLabel: raw.publishedLabel,
    heat: raw.heat,
    kind: 'folk',
    tags: raw.tags,
  }
}

function ensureFolkItems(
  meta: SectionMeta,
  items: NewspaperItem[],
  rawItems: RawItem[],
  used: Set<number>,
): void {
  if (!['hangzhou', 'benxi', 'bili', 'china'].includes(meta.key)) return
  const target = meta.key === 'china' ? Math.max(1, Math.ceil(items.length / 2)) : 1
  let folkCount = items.filter((item) => item.kind === 'folk').length
  if (folkCount >= target) return

  const existingTitles = new Set(items.map((item) => normalizeTitle(item.title)))
  const existingUrls = new Set(items.map((item) => item.url).filter(Boolean) as string[])
  const candidates = rawItems
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw, index }) => {
      if (raw.kind !== 'folk') return false
      const key = normalizeTitle(raw.title)
      if (!key || existingTitles.has(key)) return false
      if (raw.url && existingUrls.has(raw.url)) return false
      return raw.title.length >= 4
    })
    .sort(
      (left, right) =>
        Number(used.has(left.index + 1)) - Number(used.has(right.index + 1)) ||
        right.raw.summary.length - left.raw.summary.length,
    )

  for (const candidate of candidates) {
    if (folkCount >= target) break
    const item = folkCandidate(candidate.raw)
    if (items.length < meta.maxItems) {
      items.push(item)
    } else {
      let replaceIndex = -1
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]?.kind !== 'folk') {
          replaceIndex = i
          break
        }
      }
      if (replaceIndex < 0) break
      items[replaceIndex] = item
    }
    used.add(candidate.index + 1)
    existingTitles.add(normalizeTitle(item.title))
    if (item.url) existingUrls.add(item.url)
    folkCount += 1
  }
}

function dedupeItems(items: NewspaperItem[]): NewspaperItem[] {
  const seenUrl = new Set<string>()
  const seenTitle = new Set<string>()
  const result: NewspaperItem[] = []
  for (const item of items) {
    const urlKey = item.url ? `u:${item.url}` : ''
    const titleKey = `t:${normalizeTitle(item.title)}`
    if ((urlKey && seenUrl.has(urlKey)) || seenTitle.has(titleKey)) continue
    if (urlKey) seenUrl.add(urlKey)
    seenTitle.add(titleKey)
    result.push(item)
  }
  return result
}

function kindLabel(kind: NewspaperItemKind): string {
  if (kind === 'official') return '官方'
  if (kind === 'folk') return '民间'
  return '综合/媒体'
}

function rawLine(item: RawItem, index: number): string {
  const bits = [
    `[${index + 1}]`,
    clip(stripHtml(item.title), 100),
    `来源：${clip(item.source, 24)}`,
    item.publishedLabel ? `时间：${item.publishedLabel}` : item.publishedAt ? `时间：${item.publishedAt.slice(0, 16).replace('T', ' ')}` : '',
    item.heat ? `热度：${item.heat}` : '',
    `类型：${kindLabel(item.kind)}`,
    item.summary ? `摘要：${clip(stripHtml(item.summary), 200)}` : '',
  ]
  return bits.filter(Boolean).join(' | ')
}

function buildPrompt(meta: SectionMeta, rawItems: RawItem[], date: string): string {
  const lines = rawItems.map(rawLine).join('\n')
  return `今天是 ${date}（Asia/Shanghai）。你在编一份给普通读者看的日报，负责「${meta.title}」版。

版块定位：${meta.subtitle}
选题要求：${meta.focus}

可使用的素材（只能引用下面的编号，不能自己编造事实、数字、引语或链接）：
${lines}

请输出严格 JSON，不要 markdown 代码块，不要多余解释：
{
  "intro": "本版一句话编辑按，20-50 字，可为空",
  "note": "素材不足或需要说明时写 10-80 字，没有就空字符串",
  "items": [
    {
      "rawIds": [1, 2],
      "title": "报纸标题，8-30 字，可以改写但不能夸大",
      "summary": "2-3 句，60-180 字，讲清发生了什么、进展、各方反应",
      "kind": "official | folk | mixed",
      "tags": ["最多两个短标签"]
    }
  ]
}

硬性要求：
1. 选 ${meta.minItems}-${meta.maxItems} 条，按重要性排序；素材不够就少写，不要硬凑。
2. 民间热搜、论坛、评论（类型=民间）优先，但事实以官方/正规媒体为准；不要整版都是会议和通稿。杭州、本溪、B站版至少选 1 条民间条目；中国版至少一半条目来自民间热搜/论坛/评论。
3. 同一条素材可以支撑一条，也可以把 2-3 条相关素材合并成一条（rawIds 写多个），但不要重复讲同一件事。
4. 未经证实的信息必须用“网传/暂未回应/讨论中”等措辞，不要下定性结论，不要编造当事人表态。
5. 如果某条素材只有标题、没有摘要，摘要只能复述标题本身，禁止补充任何细节、数字、时间、反应或评价；没有把握就不要选它。
6. 摘要里出现的数字、引语、具体人名和机构表态，必须能在素材原文里找到；不要写转发量、阅读量、播放量、弹幕数等素材里没有的数据。
7. 标题不要带“百度热搜/知乎热榜/微博热搜”等字样，热度会单独展示。
8. 如果素材里出现英文标题或摘要，翻译成简体中文，保留原意。
9. rawIds 必须是上面出现过的编号；如果没有任何可用素材，items 返回空数组，并在 note 里说明。`
}

async function callQwen(system: string, user: string): Promise<unknown> {
  const response = await fetch(`${BASE}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: 1600,
    }),
    signal: AbortSignal.timeout(90_000),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`模型调用失败 (${response.status}) ${text.slice(0, 160)}`)
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  return extractJson(content)
}

function fallbackSection(meta: SectionMeta, rawItems: RawItem[], note: string): NewspaperSection {
  const seen = new Set<string>()
  const items: NewspaperItem[] = []
  for (const raw of rawItems) {
    const key = raw.url ?? normalizeTitle(raw.title)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      title: clip(raw.title, 60),
      summary:
        raw.summary ||
        `来自${raw.source}的消息，细节请点击原文查看。`,
      source: raw.source,
      url: raw.url,
      publishedAt: raw.publishedAt,
      publishedLabel: raw.publishedLabel,
      heat: raw.heat,
      kind: raw.kind,
      tags: raw.tags,
    })
    if (items.length >= meta.maxItems) break
  }

  return {
    key: meta.key,
    title: meta.title,
    subtitle: meta.subtitle,
    intro: '',
    items,
    degraded: true,
    note,
  }
}

function validateSection(
  meta: SectionMeta,
  parsed: unknown,
  rawItems: RawItem[],
): NewspaperSection | null {
  const record = asRecord(parsed)
  if (!record) return null
  const itemsRaw = asArray(record.items)
  if (!itemsRaw.length) return null

  const used = new Set<number>()
  const items: NewspaperItem[] = []

  for (const entry of itemsRaw) {
    const item = asRecord(entry)
    if (!item) continue
    const rawIds = asNumberArray(item.rawIds).filter((id) => id >= 1 && id <= rawItems.length)
    if (!rawIds.length) continue
    if (rawIds.every((id) => used.has(id))) continue

    const sources: RawItem[] = rawIds
      .map((id) => rawItems[id - 1])
      .filter((raw): raw is RawItem => Boolean(raw))
    const first = sources[0]
    if (!first) continue

    const title = clip(stripHtml(asString(item.title) || first.title), 60)
    let summary = clip(stripCitationMarkers(stripHtml(asString(item.summary))), 320)
    if (title.length < 4) continue
    if (summary.length < 8) continue
    if (hasUnsupportedNumbers(summary, title, sources)) {
      summary = safeFallbackSummary(title, sources)
    }
    if (looksEnglish(summary)) {
      summary = `据${sources[0]?.source ?? '外媒'}报道：${title}。详细内容请点击原文查看。`
    }

    const url = sources.find((raw) => raw.url)?.url ?? null
    const heat = sources.find((raw) => raw.heat)?.heat ?? null
    const publishedAt = sources.find((raw) => raw.publishedAt)?.publishedAt ?? null
    const publishedLabel = sources.find((raw) => raw.publishedLabel)?.publishedLabel ?? null
    const sourceNames = [...new Set(sources.map((raw) => raw.source))]
    const tags = asArray(item.tags)
      .map((tag) => stripHtml(asString(tag)))
      .filter(Boolean)
      .slice(0, 2)

    items.push({
      title,
      summary,
      source: sourceNames.join(' / ') || first.source,
      url,
      publishedAt,
      publishedLabel,
      heat,
      kind: deriveKind(sources),
      tags,
    })
    rawIds.forEach((id) => used.add(id))
    if (items.length >= meta.maxItems) break
  }

  if (!items.length) return null

  ensureFolkItems(meta, items, rawItems, used)

  // 素材够但 AI 选得太少时，用未使用的素材补齐，保证每版不至于只剩一条
  if (items.length < meta.minItems) {
    for (const raw of rawItems) {
      const index = rawItems.indexOf(raw) + 1
      if (used.has(index)) continue
      items.push({
        title: clip(raw.title, 60),
        summary: raw.summary || `来自${raw.source}的消息，细节请点击原文查看。`,
        source: raw.source,
        url: raw.url,
        publishedAt: raw.publishedAt,
        publishedLabel: raw.publishedLabel,
        heat: raw.heat,
        kind: raw.kind,
        tags: raw.tags,
      })
      if (items.length >= meta.minItems) break
    }
  }

  const finalItems = dedupeItems(items).slice(0, meta.maxItems)
  const aiNote = clip(stripHtml(asString(record.note)), 120) || null
  const noFolkNote =
    meta.key === 'benxi' && finalItems.every((item) => item.kind !== 'folk')
      ? '本版暂未抓到本溪本地民间热议，以官方和媒体信息为主。'
      : null

  return {
    key: meta.key,
    title: meta.title,
    subtitle: meta.subtitle,
    intro: clip(stripCitationMarkers(stripHtml(asString(record.intro))), 80),
    items: finalItems,
    degraded: false,
    note: aiNote
      ? clip(stripCitationMarkers(aiNote), 120)
      : noFolkNote,
  }
}

const SYSTEM_PROMPT =
  '你是 ZenithFlow 日报的资深编辑。你只根据给定素材写稿，绝不编造事实、数字、引语、链接或当事人表态。你擅长把官方通报和民间讨论放在一起，但会明确区分两者。'

function selectForPrompt(items: RawItem[], max: number): RawItem[] {
  if (items.length <= max) return items

  // 民间热点优先，但不能整版都是热搜；给官方/媒体留出位置
  const folk = items.filter((item) => item.kind === 'folk')
  const rest = items.filter((item) => item.kind !== 'folk')
  const folkQuota = Math.min(folk.length, Math.ceil(max * 0.6))
  const selected = [...folk.slice(0, folkQuota), ...rest.slice(0, max - folkQuota)]

  if (selected.length < max) {
    const used = new Set(selected)
    for (const item of items) {
      if (used.has(item)) continue
      selected.push(item)
      if (selected.length >= max) break
    }
  }
  return selected
}

export async function composeSection(
  meta: SectionMeta,
  rawItems: RawItem[],
  date: string,
): Promise<NewspaperSection> {
  const usable = selectForPrompt(rawItems, MAX_PROMPT_ITEMS)
  if (!usable.length) {
    return fallbackSection(meta, [], '今天没有抓到可用素材。')
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = await callQwen(SYSTEM_PROMPT, buildPrompt(meta, usable, date))
      const section = validateSection(meta, parsed, usable)
      if (section) {
        // 中国版民间素材池比 prompt 里截取的大，补足民间条目后再去重
        if (meta.key === 'china') {
          ensureFolkItems(meta, section.items, rawItems, new Set())
          section.items = dedupeItems(section.items).slice(0, meta.maxItems)
        }
        return section
      }
    } catch (error) {
      if (attempt === 1) {
        const message = error instanceof Error ? error.message : String(error)
        return fallbackSection(
          meta,
          usable,
          `AI 编排失败，已降级为原始快讯：${message.slice(0, 80)}`,
        )
      }
    }
  }

  return fallbackSection(meta, usable, 'AI 返回内容不符合格式，已降级为原始快讯。')
}

export async function composeEdition(
  bySection: Record<(typeof SECTION_KEYS)[number], RawItem[]>,
  date: string,
): Promise<NewspaperSection[]> {
  const sections: NewspaperSection[] = []
  for (const key of SECTION_KEYS) {
    const meta = SECTION_META[key]
    const section = await composeSection(meta, bySection[key], date)
    sections.push(section)
  }
  return sections
}

/** 调试用：完全不调用模型，直接把原始素材按版块排出来 */
export function composeRawEdition(
  bySection: Record<(typeof SECTION_KEYS)[number], RawItem[]>,
): NewspaperSection[] {
  return SECTION_KEYS.map((key) =>
    fallbackSection(SECTION_META[key], bySection[key], '本次未调用 AI，直接用原始素材。'),
  )
}
