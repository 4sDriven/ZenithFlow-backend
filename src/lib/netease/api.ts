import { NeteaseError, neteaseRequest } from './client.js'

export type NeteaseArtist = { id?: string; name: string }

export type NeteaseSong = {
  id: string
  originalId?: string | number | null
  name: string
  /** 毫秒；专辑列表与搜索结果都会带，专辑 detail 接口没有 */
  duration?: number | null
  artists?: NeteaseArtist[]
  album?: { id?: string; name?: string | null } | null
}

export type Profile = { uid: string; nickname: string; avatarUrl?: string | null }

export type PlaylistBrief = {
  id: string
  originalId?: string | number | null
  name: string
  trackCount?: number | null
}

const PAGE_DELAY_MS = 220

export function sleep(ms = PAGE_DELAY_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function artistNames(song: NeteaseSong): string {
  return (song.artists ?? []).map((artist) => artist.name).filter(Boolean).join(', ')
}

function recordsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const bag = data as Record<string, unknown>
    for (const key of ['records', 'songs', 'list', 'data']) {
      if (Array.isArray(bag[key])) return bag[key] as T[]
    }
  }
  return []
}

export async function fetchProfile(token: string): Promise<Profile> {
  const res = await neteaseRequest<{
    originalId?: number | string
    id?: string
    nickname?: string
    avatarUrl?: string
  }>('/openapi/music/basic/user/profile/get/v2', 'GET', {}, token)
  const data = res.data ?? {}
  return {
    uid: String(data.originalId ?? data.id ?? ''),
    nickname: data.nickname ?? '',
    avatarUrl: data.avatarUrl ?? null,
  }
}

export async function listCreatedPlaylists(token: string, limit = 100): Promise<PlaylistBrief[]> {
  const all: PlaylistBrief[] = []
  for (let offset = 0; offset < 500; offset += limit) {
    const res = await neteaseRequest<unknown>(
      '/openapi/music/basic/playlist/created/get/v2',
      'GET',
      { limit, offset },
      token,
    )
    const page = recordsOf<PlaylistBrief>(res.data)
    all.push(...page)
    if (page.length < limit) break
    await sleep()
  }
  return all
}

/** 「我喜欢的音乐」在创建列表里名字以「喜欢的音乐」结尾 */
export async function findLikedPlaylist(token: string): Promise<PlaylistBrief> {
  const list = await listCreatedPlaylists(token)
  const liked = list.find((item) => (item.name ?? '').includes('喜欢的音乐'))
  if (!liked) throw new NeteaseError('未找到「我喜欢的音乐」歌单')
  return liked
}

export async function getPlaylistTracks(
  token: string,
  playlistId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<NeteaseSong[]> {
  const res = await neteaseRequest<unknown>(
    '/openapi/music/basic/playlist/song/list/get/v3',
    'GET',
    { playlistId, limit: options.limit ?? 100, offset: options.offset ?? 0 },
    token,
  )
  return recordsOf<NeteaseSong>(res.data)
}

export async function getAllPlaylistTracks(
  token: string,
  playlistId: string,
  max = 600,
): Promise<NeteaseSong[]> {
  const all: NeteaseSong[] = []
  for (let offset = 0; offset < max; offset += 100) {
    const page = await getPlaylistTracks(token, playlistId, { limit: 100, offset })
    all.push(...page)
    if (page.length < 100) break
    await sleep()
  }
  return all
}

export async function fetchPlaylistDetail(
  token: string,
  playlistId: string,
): Promise<{ id: string; originalId: string | number | null; name: string; trackCount: number }> {
  const res = await neteaseRequest<{
    id?: string
    originalId?: number | string
    name?: string
    trackCount?: number
  }>('/openapi/music/basic/playlist/detail/get/v2', 'GET', { playlistId }, token)
  const data = res.data ?? {}
  return {
    id: data.id ?? playlistId,
    originalId: data.originalId ?? null,
    name: data.name ?? '',
    trackCount: data.trackCount ?? 0,
  }
}

export async function searchSongs(
  token: string,
  keyword: string,
  limit = 20,
  offset = 0,
): Promise<NeteaseSong[]> {
  // keyword / limit / offset 三个参数缺一不可，缺 offset 会返回 400 空 body
  const res = await neteaseRequest<unknown>(
    '/openapi/music/basic/search/song/get/v3',
    'GET',
    { keyword, limit, offset },
    token,
  )
  return recordsOf<NeteaseSong>(res.data)
}

export async function albumSongs(token: string, albumId: string): Promise<NeteaseSong[]> {
  const res = await neteaseRequest<unknown>(
    '/openapi/music/basic/album/song/list/get/v2',
    'GET',
    { albumId, limit: 100, offset: 0 },
    token,
  )
  return recordsOf<NeteaseSong>(res.data)
}

export async function listenRanking(token: string): Promise<NeteaseSong[]> {
  // 听歌排行：总榜只返回 100 条
  const res = await neteaseRequest<unknown>(
    '/openapi/music/basic/query/song/record/get',
    'POST',
    { type: 0, offset: 0, limit: 300 },
    token,
  )
  return recordsOf<{ song?: NeteaseSong }>(res.data)
    .map((item) => item?.song)
    .filter((song): song is NeteaseSong => Boolean(song?.id))
}

export async function recentPlays(token: string): Promise<NeteaseSong[]> {
  const res = await neteaseRequest<unknown>(
    '/openapi/music/basic/song/play/record/list',
    'GET',
    { limit: 300 },
    token,
  )
  return recordsOf<NeteaseSong>(res.data)
}

export async function createPlaylist(
  token: string,
  name: string,
): Promise<{ id: string; originalId: string }> {
  const res = await neteaseRequest<{ id: string; originalId: number | string }>(
    '/openapi/music/basic/playlist/create',
    'GET',
    { playlistName: name },
    token,
  )
  if (!res.data?.id) throw new NeteaseError('创建歌单失败')
  return { id: res.data.id, originalId: String(res.data.originalId ?? '') }
}

export async function addSongsToPlaylist(
  token: string,
  playlistId: string,
  songIds: string[],
): Promise<void> {
  for (let index = 0; index < songIds.length; index += 25) {
    const batch = songIds.slice(index, index + 25)
    await neteaseRequest('/openapi/music/basic/playlist/song/batch/like', 'POST', {
      playlistId,
      songIdList: batch,
    }, token)
    await sleep(500)
  }
}

export async function removeSongsFromPlaylist(
  token: string,
  playlistId: string,
  songIds: string[],
): Promise<void> {
  for (let index = 0; index < songIds.length; index += 50) {
    const batch = songIds.slice(index, index + 50)
    await neteaseRequest('/openapi/music/basic/playlist/song/batch/delete', 'POST', {
      playlistId,
      songIdList: batch,
    }, token)
    await sleep(400)
  }
}

/** 重排歌单顺序（批量加歌是往头部追加，写完调这个把顺序摆正） */
export async function reorderPlaylist(
  token: string,
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  await neteaseRequest('/openapi/music/basic/playlist/track/order/update', 'POST', {
    playlistId,
    trackIds,
  }, token)
}

export async function updatePlaylistDesc(
  token: string,
  playlistId: string,
  desc: string,
): Promise<void> {
  await neteaseRequest('/openapi/music/basic/playlist/desc/update', 'POST', { playlistId, desc }, token)
}

export async function updatePlaylistName(
  token: string,
  playlistId: string,
  name: string,
): Promise<void> {
  await neteaseRequest('/openapi/music/basic/playlist/name/update', 'POST', { playlistId, name }, token)
}
