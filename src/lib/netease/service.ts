import { desc, lt, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { musicPlaylists, musicTracks } from '../../db/schema.js'
import {
  addSongsToPlaylist,
  createPlaylist,
  fetchPlaylistDetail,
  findLikedPlaylist,
  getAllPlaylistTracks,
  getPlaylistTracks,
  listCreatedPlaylists,
  listenRanking,
  recentPlays,
  removeSongsFromPlaylist,
  sleep,
  updatePlaylistDesc,
  updatePlaylistName,
  type NeteaseSong,
} from './api.js'
import { collectDeepTracks } from './deep.js'
import { discoverTracks } from './discover.js'
import { computeStats } from './profile.js'
import { checkToken } from './token.js'
import type { GenerationJob, GenerationResult, GenerationTrack, TrackCandidate } from './types.js'

const PLAYLIST_NAME = 'AI 今日推荐'
const TARGET_TOTAL = 45
const DEEP_SHARE = 0.6
const DEDUPE_DAYS = 7

let job: GenerationJob = {
  phase: 'idle',
  step: 'idle',
  message: '',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
}

export function getJob(): GenerationJob {
  return job
}

function update(step: string, message: string) {
  job = { ...job, step, message }
}

function songIds(songs: NeteaseSong[]): Set<string> {
  return new Set(songs.map((song) => song.id).filter(Boolean))
}

async function recentlyRecommended(): Promise<Set<string>> {
  const since = new Date(Date.now() - DEDUPE_DAYS * 24 * 60 * 60 * 1000)
  // 先清掉超过 N 天的历史，剩下就是需要排除的
  await db.delete(musicTracks).where(lt(musicTracks.createdAt, since))
  const rows = await db.select({ songId: musicTracks.songId }).from(musicTracks)
  return new Set(rows.map((row) => row.songId))
}

async function loadPlaylistRow() {
  const [row] = await db.select().from(musicPlaylists).orderBy(musicPlaylists.id).limit(1)
  return row ?? null
}

async function ensurePlaylist(token: string) {
  const existing = await loadPlaylistRow()
  if (existing) {
    try {
      await fetchPlaylistDetail(token, existing.neteasePlaylistId)
      return existing
    } catch {
      // 用户手动删掉了歌单：重新建一个并接管
    }
  }

  // 首次运行：若账号里已有 AI 生成的歌单就接管，避免留下孤儿歌单
  if (!existing) {
    try {
      const created = await listCreatedPlaylists(token)
      const adopt = created.find((item) => /^AI\s*(推荐|今日推荐)/.test(item.name ?? ''))
      if (adopt) {
        const [row] = await db
          .insert(musicPlaylists)
          .values({
            neteasePlaylistId: adopt.id,
            originalId: adopt.originalId != null ? String(adopt.originalId) : null,
            name: adopt.name,
          })
          .returning()
        if (row) return row
      }
    } catch (error) {
      console.warn('[music] 查找已有 AI 歌单失败', error)
    }
  }

  const created = await createPlaylist(token, PLAYLIST_NAME)
  await sleep(500)
  if (existing) {
    await db
      .update(musicPlaylists)
      .set({ neteasePlaylistId: created.id, originalId: created.originalId, name: PLAYLIST_NAME })
      .where(eq(musicPlaylists.id, existing.id))
    return { ...existing, neteasePlaylistId: created.id, originalId: created.originalId, name: PLAYLIST_NAME }
  }

  const [row] = await db
    .insert(musicPlaylists)
    .values({ neteasePlaylistId: created.id, originalId: created.originalId, name: PLAYLIST_NAME })
    .returning()
  if (!row) throw new Error('创建歌单记录失败')
  return row
}

async function clearPlaylist(token: string, playlistId: string) {
  const existing: string[] = []
  for (let offset = 0; offset < 600; offset += 100) {
    const page = await getPlaylistTracks(token, playlistId, { limit: 100, offset })
    existing.push(...page.map((song) => song.id).filter(Boolean))
    if (page.length < 100) break
    await sleep()
  }
  if (existing.length) {
    await removeSongsFromPlaylist(token, playlistId, existing)
    await sleep(600)
  }
}

function dedupe(candidates: TrackCandidate[]): TrackCandidate[] {
  const seen = new Set<string>()
  const out: TrackCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate.id || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    out.push(candidate)
  }
  return out
}

export type StartOutcome =
  | { started: true }
  | { started: false; reason: 'running' | 'login_required' }

export async function startGeneration(): Promise<StartOutcome> {
  if (job.phase === 'running') return { started: false, reason: 'running' }

  const check = await checkToken()
  if (!check.ok) return { started: false, reason: 'login_required' }

  job = {
    phase: 'running',
    step: 'profile',
    message: '正在读取红心歌单…',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  }

  void runGeneration(check.account.token).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[music] 生成失败', error)
    job = { ...job, phase: 'failed', step: 'failed', message, error: message, finishedAt: Date.now() }
  })

  return { started: true }
}

async function runGeneration(token: string) {
  // 1. 红心画像
  const likedPlaylist = await findLikedPlaylist(token)
  const liked = await getAllPlaylistTracks(token, likedPlaylist.id)
  if (liked.length < 20) throw new Error('红心歌单太少了，先攒一些再生成')
  const stats = computeStats(liked)

  // 2. 已听过（听歌排行 / 最近播放），失败不阻塞
  update('heard', '正在排除你听过的歌…')
  const heard = new Set<string>()
  try {
    for (const song of await listenRanking(token)) heard.add(song.id)
  } catch (error) {
    console.warn('[music] 听歌排行读取失败', error)
  }
  try {
    for (const song of await recentPlays(token)) heard.add(song.id)
  } catch (error) {
    console.warn('[music] 最近播放读取失败', error)
  }

  const recommended = await recentlyRecommended()
  const likedIds = songIds(liked)
  const exclude = new Set<string>([...likedIds, ...heard, ...recommended])

  // 3. 深度曲目（多取一点，用于补齐新血不足）
  update('deep', `正在从 ${stats.albums.length} 张红心专辑里挖深度曲目…`)
  const deepAll = await collectDeepTracks({
    token,
    liked,
    stats,
    exclude: new Set(exclude),
    limit: TARGET_TOTAL,
  })
  for (const song of deepAll) exclude.add(song.id)

  const deepTarget = Math.round(TARGET_TOTAL * DEEP_SHARE)
  const deep = deepAll.slice(0, deepTarget)

  // 4. 同类新艺人
  update('discover', '正在让 AI 按你的口味挑选陌生艺人…')
  let fresh: TrackCandidate[] = []
  try {
    fresh = await discoverTracks(token, stats, exclude, TARGET_TOTAL - deep.length)
    for (const song of fresh) exclude.add(song.id)
  } catch (error) {
    console.warn('[music] 新艺人推荐失败，只用深度曲目补齐', error)
  }

  // 5. 补齐 + 去重
  const filler = deepAll.slice(deep.length)
  const combined = dedupe([...deep, ...fresh, ...filler]).slice(0, TARGET_TOTAL)
  if (combined.length < 10) throw new Error('可用曲目不足，稍后再试')

  // 6. 写入歌单
  update('write', '正在清空并写入今日歌单…')
  const playlistRow = await ensurePlaylist(token)

  // 接管来的旧歌单统一改名，之后固定叫「AI 今日推荐」
  let playlistName = playlistRow.name
  if (playlistName !== PLAYLIST_NAME) {
    try {
      await updatePlaylistName(token, playlistRow.neteasePlaylistId, PLAYLIST_NAME)
      playlistName = PLAYLIST_NAME
      await db
        .update(musicPlaylists)
        .set({ name: PLAYLIST_NAME })
        .where(eq(musicPlaylists.id, playlistRow.id))
      await sleep(400)
    } catch (error) {
      console.warn('[music] 歌单改名失败', error)
    }
  }

  await clearPlaylist(token, playlistRow.neteasePlaylistId)

  // 批量加歌是往头部追加，所以倒序写入，最终顺序与 combined 一致
  const ids = combined.map((song) => song.id)
  await addSongsToPlaylist(token, playlistRow.neteasePlaylistId, [...ids].reverse())

  const generationId = Date.now().toString(36)
  const deepCount = combined.filter((song) => song.source === 'deep').length
  const newCount = combined.length - deepCount

  update('finalize', '正在核对歌单…')
  await sleep(800)
  let detail: { originalId: string | number | null; trackCount: number } = {
    originalId: playlistRow.originalId,
    trackCount: combined.length,
  }
  try {
    const fetched = await fetchPlaylistDetail(token, playlistRow.neteasePlaylistId)
    detail = { originalId: fetched.originalId, trackCount: fetched.trackCount }
    if (fetched.trackCount !== combined.length) {
      console.warn(`[music] trackCount 不一致：期望 ${combined.length}，实际 ${fetched.trackCount}`)
    }
  } catch (error) {
    console.warn('[music] 歌单详情核对失败', error)
  }

  const subtitle = `ZenithFlow · ${new Date().toLocaleDateString('zh-CN')} · 深度 ${deepCount} / 新血 ${newCount}`
  try {
    await updatePlaylistDesc(token, playlistRow.neteasePlaylistId, subtitle)
  } catch (error) {
    console.warn('[music] 更新歌单简介失败', error)
  }

  // 7. 落库（用于展示与 N 天去重）
  await db.delete(musicTracks).where(eq(musicTracks.generationId, generationId))
  const tracks: GenerationTrack[] = combined.map((song, index) => ({ ...song, position: index + 1 }))
  await db.insert(musicTracks).values(
    tracks.map((song) => ({
      playlistRowId: playlistRow.id,
      generationId,
      songId: song.id,
      originalId: song.originalId,
      name: song.name,
      artists: song.artists,
      album: song.album,
      reason: song.reason,
      source: song.source,
      position: song.position,
    })),
  )
  await db
    .update(musicPlaylists)
    .set({ lastGeneratedAt: new Date() })
    .where(eq(musicPlaylists.id, playlistRow.id))

  const originalId = String(detail.originalId ?? playlistRow.originalId ?? '')
  const result: GenerationResult = {
    generationId,
    playlist: {
      id: playlistRow.neteasePlaylistId,
      originalId,
      name: playlistName || PLAYLIST_NAME,
      url: originalId ? `https://music.163.com/#/playlist?id=${originalId}` : null,
    },
    tracks,
    counts: { deep: deepCount, new: newCount, total: tracks.length },
    generatedAt: new Date().toISOString(),
  }

  job = {
    phase: 'done',
    step: 'done',
    message: `已生成 ${tracks.length} 首`,
    startedAt: job.startedAt,
    finishedAt: Date.now(),
    result,
    error: null,
  }
}

/** 最近一次生成的结果（进页面直接展示，不用重新生成） */
export async function loadLatest(): Promise<GenerationResult | null> {
  const [latestTrack] = await db
    .select()
    .from(musicTracks)
    .orderBy(desc(musicTracks.createdAt))
    .limit(1)
  if (!latestTrack) return null

  const [playlistRow] = await db
    .select()
    .from(musicPlaylists)
    .where(eq(musicPlaylists.id, latestTrack.playlistRowId))
    .limit(1)
  if (!playlistRow) return null

  const rows = await db
    .select()
    .from(musicTracks)
    .where(eq(musicTracks.generationId, latestTrack.generationId))
    .orderBy(musicTracks.position)

  const tracks: GenerationTrack[] = rows.map((row) => ({
    id: row.songId,
    originalId: row.originalId,
    name: row.name,
    artists: row.artists,
    album: row.album,
    reason: row.reason ?? '',
    source: row.source,
    position: row.position,
  }))
  if (!tracks.length) return null

  const deepCount = tracks.filter((track) => track.source === 'deep').length
  const originalId = String(playlistRow.originalId ?? '')
  return {
    generationId: latestTrack.generationId,
    playlist: {
      id: playlistRow.neteasePlaylistId,
      originalId,
      name: playlistRow.name,
      url: originalId ? `https://music.163.com/#/playlist?id=${originalId}` : null,
    },
    tracks,
    counts: { deep: deepCount, new: tracks.length - deepCount, total: tracks.length },
    generatedAt: (playlistRow.lastGeneratedAt ?? latestTrack.createdAt).toISOString(),
  }
}
