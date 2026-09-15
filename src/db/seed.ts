import { eq } from 'drizzle-orm'
import { db, pool } from './client.js'
import { users } from './schema.js'
import { hashPassword } from '../lib/password.js'

const username = process.env.SEED_ADMIN_USERNAME ?? 'admin'
const password = process.env.SEED_ADMIN_PASSWORD ?? 'pinkfloyd'
const displayName = process.env.SEED_ADMIN_DISPLAY_NAME ?? 'Administrator'

async function main() {
  const [existing] = await db.select().from(users).where(eq(users.username, username)).limit(1)

  if (existing) {
    console.log(`[seed] user "${username}" already exists, skip`)
  } else {
    await db.insert(users).values({
      username,
      passwordHash: hashPassword(password),
      role: 'admin',
      displayName,
    })
    console.log(`[seed] created admin user "${username}"`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
