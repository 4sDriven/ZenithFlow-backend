import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { users } from '../db/schema.js'
import {
  ensureAlignment,
  ensureAssignment,
  ensureSeries,
  refreshAllSeries,
  tomorrowStr,
} from '../lib/english-service.js'

async function main() {
  await ensureSeries()
  const refresh = await refreshAllSeries(40)

  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))
  const date = tomorrowStr()
  const assigned: { userId: number; assignmentId: number | null }[] = []

  for (const user of admins) {
    const assignment = await ensureAssignment(user.id, date)
    if (assignment) {
      try {
        await ensureAlignment(assignment.episodeId)
      } catch (err) {
        console.error('[english-daily] align failed:', err)
      }
    }
    assigned.push({ userId: user.id, assignmentId: assignment?.id ?? null })
  }

  console.log(JSON.stringify({ ok: true, date, refresh, assigned }))
  await pool.end()
}

main().catch(async (err) => {
  console.error('[english-daily] failed:', err)
  try {
    await pool.end()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
