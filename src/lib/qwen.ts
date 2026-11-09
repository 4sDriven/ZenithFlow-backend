import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../config.js'

const execFileAsync = promisify(execFile)

export type QwenBalance = {
  availableAmount: string
  currency: string
}

export async function getQwenBalance(): Promise<QwenBalance> {
  const { stdout } = await execFileAsync(
    config.QIANWEN_CLI_PATH,
    ['billing', 'balance', 'summary', '--format', 'json'],
    {
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `/usr/local/nodejs/bin:${process.env.PATH ?? ''}`,
      },
    },
  )

  let parsed: { availableAmount?: unknown; currency?: unknown }
  try {
    parsed = JSON.parse(stdout) as typeof parsed
  } catch {
    throw new Error('余额返回内容无法解析')
  }

  if (typeof parsed.availableAmount !== 'string' || typeof parsed.currency !== 'string') {
    throw new Error('余额返回格式异常')
  }

  return { availableAmount: parsed.availableAmount, currency: parsed.currency }
}
