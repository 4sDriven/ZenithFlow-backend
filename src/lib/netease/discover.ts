import { chatText } from '../text.js'
import { artistNames, searchSongs, sleep, type NeteaseSong } from './api.js'
import { isBadTrackName } from './filters.js'
import { describeProfile, type ProfileStats } from './profile.js'
import type { TrackCandidate } from './types.js'

/**
 * 同类新艺人发现。
 *
 * 关键点：LLM 只负责「推荐什么」（艺人 + 歌名 + 理由），
 * 歌是否存在、能否加进歌单，完全由搜索接口校验，避免编造。
 */

type LlmPick = { artist: string; title: string; why: string }

const ASK_COUNT = 34
const SEARCH_DELAY_MS = 320

function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced?.[1] ?? text
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
  return JSON.parse(candidate)
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s'"“”‘’.,，。!！?？:：;；()（）[\]【】&+/-]/g, '')
    .replace(/·/g, '')
}

function asPicks(value: unknown): LlmPick[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const bag = entry as Record<string, unknown>
      const artist = typeof bag.artist === 'string' ? bag.artist.trim() : ''
      const title = typeof bag.title === 'string' ? bag.title.trim() : ''
      const why = typeof bag.why === 'string' ? bag.why.trim() : ''
      if (!artist || !title) return null
      return { artist, title, why }
    })
    .filter((pick): pick is LlmPick => Boolean(pick))
}

async function askLlm(stats: ProfileStats): Promise<LlmPick[]> {
  const knownArtists = stats.artists.slice(0, 40).map((artist) => artist.name).join('、')
  const system =
    '你是资深金属/摇滚编辑，熟悉前卫金属、旋律死亡、鞭击、律动、工业、器乐吉他、经典前卫摇滚与华语摇滚的谱系。你只输出 JSON，不写任何解释性文字。'
  const user = [
    '根据下面这份网易云红心画像，推荐一些「用户还没听过、但大概率会喜欢」的曲子。',
    '',
    describeProfile(stats, { topArtists: 24, topAlbums: 24 }),
    '',
    '硬性要求：',
    `1. 输出 ${ASK_COUNT} 首，格式为 JSON 数组，元素形如 {"artist":"乐队名","title":"歌名","why":"一句中文推荐理由"}。`,
    `2. 不要选这些已经听很多的艺人：${knownArtists}。要往相邻的、同一脉络里的其他艺人推。`,
    '3. 这位听众的主轴是金属与器乐吉他，推荐必须围绕这些脉络：前卫金属 / 前卫摇滚、旋律死亡与哥特、鞭击与律动金属、器乐吉他、工业金属、经典硬摇滚或经典前卫摇滚。',
    '4. 不要推荐嘻哈、R&B、Trap、City Pop、爵士、华语流行这类画像里没有明显支撑的流派；画像里的电子与华语各占很小比例，最多各 1 首。',
    '5. 优先选有辨识度的专辑曲目，不要只挑最著名的单曲；同一艺人最多 1 首，同一流派最多 6 首。',
    '6. why 要具体，说清「像用户喜欢的哪支乐队 / 哪条脉络」，禁止「很好听」「经典之作」这类空话。',
    '7. 只输出 JSON 数组本身，不要 Markdown 代码块，不要注释。',
  ].join('\n')

  const content = await chatText({
    system,
    user,
    temperature: 0.5,
    maxTokens: 2600,
    timeoutMs: 90_000,
  })
  return asPicks(extractJsonArray(content)).slice(0, ASK_COUNT)
}

function matchSong(songs: NeteaseSong[], artist: string, title: string): NeteaseSong | null {
  const wantArtist = normalize(artist)
  const wantTitle = normalize(title)
  let fallback: NeteaseSong | null = null

  for (const song of songs) {
    if (!song.id) continue
    const names = (song.artists ?? []).map((entry) => normalize(entry.name))
    const artistOk = names.some((name) => name.includes(wantArtist) || wantArtist.includes(name))
    if (!artistOk) continue
    const gotTitle = normalize(song.name ?? '')
    const titleOk =
      gotTitle === wantTitle ||
      (wantTitle.length >= 4 && gotTitle.includes(wantTitle)) ||
      (gotTitle.length >= 4 && wantTitle.includes(gotTitle))
    if (!titleOk) continue
    // 同名结果里可能有 Live / Demo / Remaster 版本，优先要录音室原版
    if (isBadTrackName(song.name) || isBadTrackName(song.album?.name)) {
      if (!fallback) fallback = song
      continue
    }
    return song
  }
  return null
}

export async function discoverTracks(
  token: string,
  stats: ProfileStats,
  exclude: Set<string>,
  limit: number,
): Promise<TrackCandidate[]> {
  const picks = await askLlm(stats)
  const picked: TrackCandidate[] = []
  const usedIds = new Set<string>()
  const usedArtists = new Set<string>()

  for (const pick of picks) {
    if (picked.length >= limit) break
    const artistKey = normalize(pick.artist)
    if (usedArtists.has(artistKey)) continue

    let hit: NeteaseSong | null = null
    try {
      hit = matchSong(await searchSongs(token, `${pick.artist} ${pick.title}`, 10, 0), pick.artist, pick.title)
      if (!hit) {
        // 前十没命中时，改用艺人名再搜一批（只找同名录音室版）
        await sleep(SEARCH_DELAY_MS)
        hit = matchSong(await searchSongs(token, pick.artist, 30, 0), pick.artist, pick.title)
      }
    } catch {
      await sleep(SEARCH_DELAY_MS)
      continue
    }
    await sleep(SEARCH_DELAY_MS)

    if (!hit || !hit.id) continue
    if (exclude.has(hit.id) || usedIds.has(hit.id)) continue
    if ((hit.name ?? '').length === 0) continue
    // 搜索结果经常带 Live / Demo / Remaster 版本，跳过，避免推荐的是现场或小样
    if (isBadTrackName(hit.name) || isBadTrackName(hit.album?.name)) continue
    if (hit.duration != null && hit.duration > 0 && hit.duration < 90_000) continue

    usedIds.add(hit.id)
    usedArtists.add(artistKey)
    picked.push({
      id: hit.id,
      originalId: hit.originalId != null ? String(hit.originalId) : null,
      name: hit.name,
      artists: artistNames(hit) || pick.artist,
      album: hit.album?.name ?? null,
      reason: pick.why || `与你喜欢的艺人同属一条脉络`,
      source: 'new',
    })
  }

  return picked
}
