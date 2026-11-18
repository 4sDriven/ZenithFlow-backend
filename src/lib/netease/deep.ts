import { albumSongs, artistNames, sleep, type NeteaseSong } from './api.js'
import { isBadTrackName } from './filters.js'
import { likedAlbumIdsForArtists, type ProfileStats } from './profile.js'
import type { TrackCandidate } from './types.js'

/**
 * 同专辑深度曲目。
 *
 * 这是整套推荐里最贴近用户口味的来源（Vicarious 就是这么被选中的）：
 * 只从「红心歌曲所在的专辑」里取曲，排除已红心 / 已听过 / 最近推荐过，
 * 并过滤 Live、Remaster、Demo、Interlude 这类干扰项。
 */

const PER_ALBUM = 1
const PER_ARTIST = 4
const MAX_ALBUMS = 40

export type DeepOptions = {
  token: string
  liked: NeteaseSong[]
  stats: ProfileStats
  exclude: Set<string>
  limit: number
}

export async function collectDeepTracks(options: DeepOptions): Promise<TrackCandidate[]> {
  const { token, liked, stats, exclude, limit } = options
  const likedIds = new Set(liked.map((song) => song.id).filter(Boolean))

  const topArtistNames = stats.artists.slice(0, 10).map((artist) => artist.name)
  const albums = likedAlbumIdsForArtists(stats, topArtistNames).slice(0, MAX_ALBUMS)

  const picked: TrackCandidate[] = []
  const usedIds = new Set<string>()
  const perArtist = new Map<string, number>()

  for (const album of albums) {
    if (picked.length >= limit) break
    const artistUsed = perArtist.get(album.artist) ?? 0
    if (artistUsed >= PER_ARTIST) continue

    let tracks: NeteaseSong[] = []
    try {
      tracks = await albumSongs(token, album.id)
    } catch {
      continue
    }
    await sleep()

    let taken = 0
    const skipOpener = tracks.length >= 5
    for (const [index, song] of tracks.entries()) {
      if (taken >= PER_ALBUM) break
      if (picked.length >= limit) break
      if (!song.id || usedIds.has(song.id)) continue
      if (likedIds.has(song.id) || exclude.has(song.id)) continue
      // 专辑第一首经常是 intro / 序曲，且没有 duration 字段可判断，直接跳过
      if (skipOpener && index === 0) continue
      if (isBadTrackName(song.name)) continue
      // 90 秒以下基本都是 interlude，时长字段只有专辑列表有
      if (song.duration != null && song.duration > 0 && song.duration < 90_000) continue
      if (perArtist.get(album.artist) !== undefined && (perArtist.get(album.artist) ?? 0) >= PER_ARTIST) break
      // 跳过与专辑同名的单曲（通常是主打，用户多半听过了）
      if ((song.name ?? '').trim().toLowerCase() === album.name.trim().toLowerCase()) continue

      usedIds.add(song.id)
      perArtist.set(album.artist, (perArtist.get(album.artist) ?? 0) + 1)
      taken += 1
      picked.push({
        id: song.id,
        originalId: song.originalId != null ? String(song.originalId) : null,
        name: song.name,
        artists: artistNames(song) || album.artist,
        album: album.name,
        source: 'deep',
        reason: `你红心过《${album.name}》里的曲目，这首是同一张专辑里你还没收的那部分`,
      })
    }
  }

  return picked
}
