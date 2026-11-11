import { desc, eq, lt } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { newspaperEditions, type NewspaperSection } from '../../db/schema.js'
import { collectRawMaterial } from './collect.js'
import { composeEdition, composeRawEdition } from './compose.js'
import type { NewspaperEditionRow } from '../../db/schema.js'

const STALE_GENERATING_MS = 30 * 60 * 1000

let running = false

export function isNewspaperGenerating(): boolean {
  return running
}

export function todayShanghai(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export type NewspaperEditionView = {
  date: string
  status: 'ready' | 'generating' | 'failed'
  generatedAt: string | null
  itemCount: number
  sourceStats: Record<string, number>
  sections: NewspaperSection[]
  error: string | null
}

function toView(row: NewspaperEditionRow): NewspaperEditionView {
  return {
    date: row.editionDate,
    status: row.status,
    generatedAt: row.generatedAt ? row.generatedAt.toISOString() : null,
    itemCount: row.itemCount,
    sourceStats: row.sourceStats,
    sections: row.sections,
    error: row.error,
  }
}

type NewspaperView = {
  ok: true
  date: string
  edition: NewspaperEditionView | null
  generating: boolean
  stale: boolean
  error: string | null
}

export async function getNewspaperView(): Promise<NewspaperView> {
  const date = todayShanghai()
  const [todayRow] = await db
    .select()
    .from(newspaperEditions)
    .where(eq(newspaperEditions.editionDate, date))
    .limit(1)

  const [latestReady] = await db
    .select()
    .from(newspaperEditions)
    .where(eq(newspaperEditions.status, 'ready'))
    .orderBy(desc(newspaperEditions.editionDate))
    .limit(1)

  const generatingRow = todayRow?.status === 'generating'
  const staleGenerating =
    generatingRow && Date.now() - todayRow.updatedAt.getTime() > STALE_GENERATING_MS

  const editionRow =
    todayRow?.status === 'ready' ? todayRow : !staleGenerating ? latestReady : latestReady

  const error =
    todayRow?.status === 'failed'
      ? todayRow.error || '今日报纸生成失败'
      : todayRow?.status === 'ready' && todayRow.error
        ? todayRow.error
        : staleGenerating
          ? '上次生成中断，可点击重新生成'
          : null

  return {
    ok: true,
    date,
    edition: editionRow ? toView(editionRow) : null,
    generating: running || (generatingRow && !staleGenerating),
    stale: Boolean(editionRow && editionRow.editionDate !== date),
    error,
  }
}

export type GenerateResult = {
  date: string
  itemCount: number
  degradedSections: string[]
  stats: Record<string, number>
  errors: { source: string; message: string }[]
  durationMs: number
}

export async function generateNewspaper(options: { useAi?: boolean; trigger?: string } = {}): Promise<GenerateResult> {
  if (running) throw new Error('报纸正在生成中，请稍后再试')
  running = true
  const startedAt = Date.now()
  const date = todayShanghai()

  let previous: NewspaperEditionRow | undefined
  try {
    const rows = await db
      .select()
      .from(newspaperEditions)
      .where(eq(newspaperEditions.editionDate, date))
      .limit(1)
    previous = rows[0]

    await db
      .insert(newspaperEditions)
      .values({
        editionDate: date,
        status: 'generating',
        error: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: newspaperEditions.editionDate,
        set: { status: 'generating', error: null, updatedAt: new Date() },
      })

    const raw = await collectRawMaterial()
    const sections: NewspaperSection[] =
      options.useAi === false
        ? composeRawEdition(raw.bySection)
        : await composeEdition(raw.bySection, date)

    const itemCount = sections.reduce((total, section) => total + section.items.length, 0)
    const degradedSections = sections.filter((section) => section.degraded).map((section) => section.key)

    await db
      .update(newspaperEditions)
      .set({
        status: 'ready',
        sections,
        itemCount,
        sourceStats: raw.stats,
        error: null,
        generatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(newspaperEditions.editionDate, date))

    await db.delete(newspaperEditions).where(lt(newspaperEditions.editionDate, date))

    console.log(
      JSON.stringify({
        ok: true,
        trigger: options.trigger ?? 'manual',
        date,
        itemCount,
        degradedSections,
        elapsedMs: Date.now() - startedAt,
      }),
    )

    return {
      date,
      itemCount,
      degradedSections,
      stats: raw.stats,
      errors: raw.errors,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[newspaper] generate failed:', message)
    try {
      if (previous?.status === 'ready') {
        await db
          .update(newspaperEditions)
          .set({
            status: 'ready',
            sections: previous.sections,
            itemCount: previous.itemCount,
            sourceStats: previous.sourceStats,
            generatedAt: previous.generatedAt,
            error: `本次重新生成失败：${message.slice(0, 160)}`,
            updatedAt: new Date(),
          })
          .where(eq(newspaperEditions.editionDate, date))
      } else {
        await db
          .update(newspaperEditions)
          .set({ status: 'failed', error: message.slice(0, 500), updatedAt: new Date() })
          .where(eq(newspaperEditions.editionDate, date))
      }
    } catch (updateError) {
      console.error('[newspaper] failed to record error:', updateError)
    }
    throw error
  } finally {
    running = false
  }
}
