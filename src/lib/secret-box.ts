import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { config } from '../config.js'

const ALGORITHM = 'aes-256-gcm'
const KEY = scryptSync(config.BILI_TOKEN_SECRET, 'zenithflow-bili-token', 32)

/** 加密敏感字符串（B 站 Cookie / refresh_token），输出可直接入库 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, encrypted] = payload.split(':')
  if (version !== 'v1' || !iv || !tag || !encrypted) {
    throw new Error('invalid encrypted payload')
  }

  const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
