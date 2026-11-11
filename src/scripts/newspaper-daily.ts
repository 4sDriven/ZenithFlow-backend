import { pool } from '../db/client.js'
import { collectRawMaterial } from '../lib/newspaper/collect.js'
import { generateNewspaper } from '../lib/newspaper/service.js'
import { SECTION_KEYS } from '../lib/newspaper/types.js'

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const useAi = !process.argv.includes('--no-ai')

  if (dryRun) {
    const raw = await collectRawMaterial()
    const samples = Object.fromEntries(
      SECTION_KEYS.map((key) => [
        key,
        {
          count: raw.bySection[key].length,
          sample: raw.bySection[key].slice(0, 4).map((item) => ({
            title: item.title,
            source: item.source,
            url: item.url,
            heat: item.heat,
            kind: item.kind,
          })),
        },
      ]),
    )
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          stats: raw.stats,
          errors: raw.errors,
          sections: samples,
        },
        null,
        2,
      ),
    )
    await pool.end()
    return
  }

  const result = await attemptGenerate(useAi)
  console.log(JSON.stringify({ ok: true, ...result }))
  await pool.end()
}

async function attemptGenerate(useAi: boolean) {
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await generateNewspaper({ useAi, trigger: 'timer' })
    } catch (error) {
      lastError = error
      console.error(`[newspaper-daily] attempt ${attempt} failed:`, error)
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 120_000))
    }
  }
  throw lastError
}

main().catch(async (error) => {
  console.error('[newspaper-daily] failed:', error)
  try {
    await pool.end()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
