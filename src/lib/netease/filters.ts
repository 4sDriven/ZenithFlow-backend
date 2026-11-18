/** 曲目名里的干扰项：现场 / 重制 / Demo / 伴奏 / 过渡曲 */
export const BAD_TRACK =
  /(live|remaster|remix|demo|instrumental|karaoke|interview|intro|outro|interlude|序曲|前奏|间奏|尾声)/i

export function isBadTrackName(name: string | null | undefined): boolean {
  const value = (name ?? '').trim()
  if (!value) return true
  // 纯编号曲目（如「04」）基本是未命名片段
  if (/^\d{1,3}$/.test(value)) return true
  return BAD_TRACK.test(value)
}

/** 合辑 / 现场 / 精选集不适合用来挖「同专辑曲目」 */
export const BAD_ALBUM =
  /(live|bootleg|greatest|best of|best$|classic|collection|anthology|ballad|tribute|karaoke|remix|single|hits)/i
