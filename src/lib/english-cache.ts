import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { config } from '../config.js'

const USER_AGENT = 'Mozilla/5.0 (compatible; ZenithFlow/1.0)'

const inflight = new Map<string, Promise<void>>()

export function thumbFile(episodeId: number): string {
  return join(config.MEDIA_DIR, 'english', 'thumbs', `${episodeId}.jpg`)
}

export function audioFile(episodeId: number): string {
  return join(config.MEDIA_DIR, 'english', 'audio', `${episodeId}.mp3`)
}

export async function isCached(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

export function ensureCached(url: string, file: string): Promise<void> {
  const running = inflight.get(file)
  if (running) return running

  const task = (async () => {
    if (await isCached(file)) return
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`下载失败 ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, buf)
  })()

  inflight.set(file, task)
  return task.finally(() => {
    inflight.delete(file)
  })
}
