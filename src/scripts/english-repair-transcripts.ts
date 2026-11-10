import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { englishEpisodes } from '../db/schema.js'
import { fetchEpisode } from '../lib/bbc.js'

/** 文稿最后一句被整页剩余内容污染的判定 */
const JUNK_RE = /BBCLECourseStructure|For a better experience please enable Javascript|Explore the BBC Home News/
const MAX_TURN_CHARS = 3000

async function main() {
  const rows = await db
    .select({
      id: englishEpisodes.id,
      pageUrl: englishEpisodes.pageUrl,
      transcript: englishEpisodes.transcript,
      alignment: englishEpisodes.alignment,
    })
    .from(englishEpisodes)

  const dirty = rows.filter((row) => {
    const last = row.transcript[row.transcript.length - 1]
    return !!last && (last.text.length > MAX_TURN_CHARS || JUNK_RE.test(last.text))
  })

  console.log(`[repair] dirty=${dirty.length}/${rows.length}`)

  const updated: number[] = []
  const failed: { id: number; error: string }[] = []

  for (const row of dirty) {
    try {
      const content = await fetchEpisode(row.pageUrl)
      const turns = content.transcript
      const last = turns[turns.length - 1]
      if (turns.length === 0 || !last || last.text.length > MAX_TURN_CHARS || JUNK_RE.test(last.text)) {
        throw new Error('重新解析后文稿仍异常')
      }

      const alignmentBroken =
        row.alignment.length > 0 && row.alignment.length !== turns.length
      if (alignmentBroken) {
        console.warn(
          `[repair] episode ${row.id} turn/alignment 不一致（${turns.length}/${row.alignment.length}），清空对齐待重跑`,
        )
      }

      await db
        .update(englishEpisodes)
        .set({
          title: content.title || undefined,
          audioUrl: content.audioUrl || undefined,
          thumbnailUrl: content.thumbnailUrl || undefined,
          transcript: turns,
          vocabulary: content.vocabulary.length ? content.vocabulary : undefined,
          alignment: alignmentBroken ? [] : undefined,
          status: 'ready',
          updatedAt: new Date(),
        })
        .where(eq(englishEpisodes.id, row.id))

      updated.push(row.id)
    } catch (err) {
      failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) })
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  console.log(JSON.stringify({ ok: failed.length === 0, dirty: dirty.length, updated, failed }))
}

main()
  .catch((err) => {
    console.error('[repair] failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
