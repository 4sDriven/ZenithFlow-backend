import type { TranscriptTurn } from '../db/schema.js'
import type { AsrWord } from './asr.js'

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function buildCharStream(words: AsrWord[]): { stream: string; times: number[] } {
  const chars: string[] = []
  const times: number[] = []
  for (const word of words) {
    for (const ch of normalize(word.text)) {
      chars.push(ch)
      times.push(word.beginMs)
    }
  }
  return { stream: chars.join(''), times }
}

function longestCommonSubstring(probe: string, region: string): { length: number; start: number } {
  const m = probe.length
  const n = region.length
  if (m === 0 || n === 0) return { length: 0, start: 0 }

  let prev = new Array<number>(n + 1).fill(0)
  let best = 0
  let bestEnd = 0

  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0)
    const pi = probe[i - 1] ?? ''
    for (let j = 1; j <= n; j++) {
      if (pi === region[j - 1]) {
        const value = (prev[j - 1] ?? 0) + 1
        cur[j] = value
        if (value > best) {
          best = value
          bestEnd = j
        }
      }
    }
    prev = cur
  }

  return { length: best, start: bestEnd - best }
}

export function alignTurns(turns: TranscriptTurn[], words: AsrWord[], limit = 1500): number[] {
  const { stream, times } = buildCharStream(words)
  const total = stream.length
  const starts: (number | null)[] = []
  let cursor = 0

  for (const turn of turns) {
    const probe = normalize(turn.text).slice(0, 100)
    if (!probe || cursor >= total) {
      starts.push(null)
      continue
    }

    const regionEnd = Math.min(total, cursor + limit)
    const region = stream.slice(cursor, regionEnd)
    const { length, start } = longestCommonSubstring(probe, region)
    const threshold = Math.max(5, Math.floor(probe.length * 0.35))

    if (length >= threshold) {
      const pos = cursor + start
      starts.push(Number(((times[pos] ?? 0) / 1000).toFixed(2)))
      cursor = pos + length
    } else {
      starts.push(null)
    }
  }

  for (let i = 0; i < starts.length; i++) {
    if (starts[i] !== null) continue
    const prev = findPrevious(starts, i) ?? 0
    const next = findNext(starts, i)
    starts[i] = next === null ? prev : Number(((prev + next) / 2).toFixed(2))
  }

  return starts as number[]
}

function findPrevious(starts: (number | null)[], index: number): number | null {
  for (let i = index - 1; i >= 0; i--) {
    const value = starts[i]
    if (value !== null && value !== undefined) return value
  }
  return null
}

function findNext(starts: (number | null)[], index: number): number | null {
  for (let i = index + 1; i < starts.length; i++) {
    const value = starts[i]
    if (value !== null && value !== undefined) return value
  }
  return null
}
