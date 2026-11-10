import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { englishAssignments, englishEpisodes } from '../db/schema.js'
import { ensureAlignment, ensureContent } from '../lib/english-service.js'

/**
 * 为「已排期但缺少 ASR 对齐」的课程补跑对齐。
 * 用法（在 backend 目录）：
 *   node dist/scripts/english-align-missing.js            # 全部缺失的排期课程
 *   node dist/scripts/english-align-missing.js --ids=46,50
 *   node dist/scripts/english-align-missing.js --limit=5
 */

function argValue(name: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

async function pickTargets(): Promise<{ id: number; title: string }[]> {
  const ids = argValue('ids')
    ?.split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0)

  if (ids?.length) {
    return db
      .select({ id: englishEpisodes.id, title: englishEpisodes.title })
      .from(englishEpisodes)
      .where(inArray(englishEpisodes.id, ids))
  }

  const limit = Number(argValue('limit') ?? 0)

  const rows = await db
    .selectDistinct({
      id: englishEpisodes.id,
      title: englishEpisodes.title,
    })
    .from(englishAssignments)
    .innerJoin(englishEpisodes, eq(englishAssignments.episodeId, englishEpisodes.id))
    .where(
      and(
        sql`jsonb_array_length(${englishEpisodes.transcript}) > 0`,
        sql`jsonb_array_length(${englishEpisodes.alignment}) = 0`,
      ),
    )
    .orderBy(englishEpisodes.id)

  return limit > 0 ? rows.slice(0, limit) : rows
}

async function episodeState(id: number) {
  const [row] = await db
    .select({
      turns: sql<number>`jsonb_array_length(${englishEpisodes.transcript})`,
      aligned: sql<number>`jsonb_array_length(${englishEpisodes.alignment})`,
      audioUrl: englishEpisodes.audioUrl,
    })
    .from(englishEpisodes)
    .where(eq(englishEpisodes.id, id))
    .limit(1)
  return row
}

async function main() {
  const targets = await pickTargets()
  console.log(`[align] targets=${targets.length}`)

  const ok: number[] = []
  const failed: { id: number; error: string }[] = []
  const skipped: { id: number; reason: string }[] = []

  for (const target of targets) {
    const started = Date.now()
    try {
      let state = await episodeState(target.id)
      if (!state) throw new Error('课程不存在')

      if (!state.audioUrl) {
        await ensureContent(target.id)
        state = await episodeState(target.id)
        if (!state?.audioUrl) throw new Error('抓不到音频，无法对齐')
      }

      await ensureAlignment(target.id)

      const done = await episodeState(target.id)
      if (!done || done.aligned === 0) throw new Error('对齐结果为空')

      ok.push(target.id)
      console.log(
        `[align] #${target.id} ${target.title} -> ${done.aligned}/${done.turns} 句 ${(Date.now() - started) / 1000}s`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed.push({ id: target.id, error: message })
      console.error(`[align] #${target.id} ${target.title} 失败：${message}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 800))
  }

  console.log(JSON.stringify({ ok: failed.length === 0, total: targets.length, done: ok, failed, skipped }))
}

main()
  .catch((err) => {
    console.error('[align] failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
