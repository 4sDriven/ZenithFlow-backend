import type { NeteaseArtist, NeteaseSong } from './api.js'
import { artistNames } from './api.js'
import { BAD_ALBUM } from './filters.js'

export type AlbumStat = {
  id: string
  name: string
  artist: string
  likedCount: number
}

export type ArtistStat = { name: string; count: number }

export type ProfileStats = {
  likedCount: number
  artists: ArtistStat[]
  albums: AlbumStat[]
}

export function computeStats(liked: NeteaseSong[]): ProfileStats {
  const artistCount = new Map<string, number>()
  const albumMap = new Map<string, AlbumStat>()

  for (const song of liked) {
    const names = (song.artists ?? []).map((artist: NeteaseArtist) => artist.name).filter(Boolean)
    for (const name of names) {
      artistCount.set(name, (artistCount.get(name) ?? 0) + 1)
    }
    const album = song.album
    if (!album?.id || !album.name) continue
    if (BAD_ALBUM.test(album.name)) continue
    const key = album.id
    const existing = albumMap.get(key)
    if (existing) {
      existing.likedCount += 1
    } else {
      albumMap.set(key, {
        id: key,
        name: album.name,
        artist: names[0] ?? '',
        likedCount: 1,
      })
    }
  }

  const artists = [...artistCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  const albums = [...albumMap.values()].sort((a, b) => b.likedCount - a.likedCount)

  return { likedCount: liked.length, artists, albums }
}

/** 给 LLM 的口味画像（纯文本，控制长度） */
export function describeProfile(stats: ProfileStats, options: { topArtists?: number; topAlbums?: number } = {}): string {
  const artistLines = stats.artists
    .slice(0, options.topArtists ?? 30)
    .map((artist) => `- ${artist.name}：${artist.count} 首`)
  const albumLines = stats.albums
    .slice(0, options.topAlbums ?? 40)
    .map((album) => `- 《${album.name}》（${album.artist}）`)
  const oneHit = stats.artists.filter((artist) => artist.count === 1).length

  return [
    `红心歌曲总数：${stats.likedCount} 首，涉及 ${stats.artists.length} 位艺人（其中 ${oneHit} 位只有 1 首）。`,
    '',
    '听得多（按红心曲目数）：',
    ...artistLines,
    '',
    '红心曲目所在的专辑：',
    ...albumLines,
  ].join('\n')
}

export function likedAlbumIdsForArtists(stats: ProfileStats, artistNames: string[]): AlbumStat[] {
  const allowed = new Set(artistNames)
  return stats.albums.filter((album) => allowed.has(album.artist))
}

export function songLabel(song: NeteaseSong): string {
  return `${song.name} — ${artistNames(song)}`
}
