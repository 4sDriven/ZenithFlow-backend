import { eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { musicAccounts } from '../../db/schema.js'
import { decryptSecret, encryptSecret } from '../secret-box.js'
import { fetchProfile } from './api.js'
import { NeteaseError } from './client.js'

const SINGLETON = 'default'

export type AccountState = {
  token: string
  nickname: string
  uid: string
  expireAt: Date | null
}

export type TokenCheck =
  | { ok: true; account: AccountState }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid'; account: AccountState | null }

export async function loadAccount(): Promise<AccountState | null> {
  const [row] = await db
    .select()
    .from(musicAccounts)
    .where(eq(musicAccounts.singletonKey, SINGLETON))
    .limit(1)
  if (!row) return null
  try {
    return {
      token: decryptSecret(row.accessTokenEnc),
      nickname: row.nickname,
      uid: row.neteaseUid ?? '',
      expireAt: row.expireAt,
    }
  } catch {
    return null
  }
}

export async function saveAccount(input: {
  token: string
  nickname: string
  uid: string
  expireAt: Date | null
}): Promise<AccountState> {
  const values = {
    singletonKey: SINGLETON,
    nickname: input.nickname,
    neteaseUid: input.uid || null,
    accessTokenEnc: encryptSecret(input.token),
    expireAt: input.expireAt,
    updatedAt: new Date(),
  }
  await db
    .insert(musicAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: musicAccounts.singletonKey,
      set: values,
    })
  return { token: input.token, nickname: input.nickname, uid: input.uid, expireAt: input.expireAt }
}

/**
 * 校验当前 token：
 * - 没有记录 → missing
 * - 过期时间已到 → 仍然尝试一次接口（时钟/续期误差），失败则 expired
 * - 接口报 1408 / 2509 → invalid
 * 校验会顺带刷新昵称。
 */
export async function checkToken(): Promise<TokenCheck> {
  const account = await loadAccount()
  if (!account) return { ok: false, reason: 'missing', account: null }

  const expiresAt = account.expireAt ? account.expireAt.getTime() : null
  const expired = expiresAt !== null && expiresAt <= Date.now()

  try {
    const profile = await fetchProfile(account.token)
    const fresh = await saveAccount({
      token: account.token,
      nickname: profile.nickname || account.nickname,
      uid: profile.uid || account.uid,
      expireAt: account.expireAt,
    })
    return { ok: true, account: fresh }
  } catch (error) {
    const authError = error instanceof NeteaseError && error.isAuthError
    if (authError) {
      return { ok: false, reason: expired ? 'expired' : 'invalid', account }
    }
    // 网络异常：token 没过期就继续用，避免误判成需要重新登录
    if (!expired) return { ok: true, account }
    throw error
  }
}
