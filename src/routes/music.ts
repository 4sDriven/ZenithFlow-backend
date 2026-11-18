import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createQrKey, pollQrKey } from '../lib/netease/client.js'
import { fetchProfile } from '../lib/netease/api.js'
import { getJob, loadLatest, startGeneration } from '../lib/netease/service.js'
import { checkToken, saveAccount } from '../lib/netease/token.js'

const pollQuery = z.object({ key: z.string().trim().min(8).max(64) })

const QR_TTL_SECONDS = 300

export async function musicRoutes(app: FastifyInstance) {
  /** 登录状态：顺带用一次 profile 接口确认 token 真的能用 */
  app.get('/music/status', { preHandler: [app.requireAdmin] }, async (_request, reply) => {
    try {
      const check = await checkToken()
      const job = getJob()
      if (!check.ok) {
        return reply.send({
          ok: true,
          loggedIn: false,
          needLogin: true,
          reason: check.reason,
          nickname: check.account?.nickname ?? '',
          expireAt: check.account?.expireAt ?? null,
          job: { phase: job.phase, step: job.step, message: job.message },
        })
      }
      return reply.send({
        ok: true,
        loggedIn: true,
        needLogin: false,
        nickname: check.account.nickname,
        expireAt: check.account.expireAt,
        job: { phase: job.phase, step: job.step, message: job.message },
      })
    } catch (error) {
      app.log.error(error, 'music status failed')
      return reply.code(502).send({ ok: false, error: '网易云接口暂时不可用，请稍后重试' })
    }
  })

  /** 生成登录二维码（页面内直接画出来，不跳外链） */
  app.post('/music/login/qr', { preHandler: [app.requireAdmin] }, async (_request, reply) => {
    try {
      const qr = await createQrKey()
      return reply.send({ ok: true, key: qr.uniKey, qrUrl: qr.qrCodeUrl, expiresIn: QR_TTL_SECONDS })
    } catch (error) {
      app.log.error(error, 'netease qrcode create failed')
      return reply.code(502).send({ ok: false, error: '二维码生成失败，请稍后重试' })
    }
  })

  /** 轮询扫码结果；成功后落库（加密存储） */
  app.get('/music/login/poll', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const parsed = pollQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'key 不合法' })

    try {
      const result = await pollQrKey(parsed.data.key)
      if (result.accessToken) {
        const profile = await fetchProfile(result.accessToken)
        const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
        await saveAccount({
          token: result.accessToken,
          nickname: profile.nickname,
          uid: profile.uid,
          expireAt,
        })
        return reply.send({
          ok: true,
          status: 'success',
          message: `已登录：${profile.nickname}`,
          nickname: profile.nickname,
          expireAt,
        })
      }

      const status = result.status
      const label =
        status === 802 ? '已扫码，请在手机上确认'
        : status === 800 ? '二维码已过期'
        : '等待扫码'
      return reply.send({ ok: true, status: status === 802 ? 'scanned' : status === 800 ? 'expired' : 'waiting', rawStatus: status, message: label })
    } catch (error) {
      app.log.error(error, 'netease qrcode poll failed')
      return reply.code(502).send({ ok: false, error: '轮询登录状态失败' })
    }
  })

  /** 唯一按钮：生成今日歌单 */
  app.post('/music/generate', { preHandler: [app.requireAdmin] }, async (_request, reply) => {
    try {
      const outcome = await startGeneration()
      if (!outcome.started) {
        if (outcome.reason === 'login_required') {
          return reply.send({ ok: false, needLogin: true, error: '登录已过期，请先扫码登录' })
        }
        return reply.send({ ok: false, running: true, error: '正在生成中，请稍候' })
      }
      return reply.send({ ok: true, started: true })
    } catch (error) {
      app.log.error(error, 'music generate failed')
      return reply.code(500).send({ ok: false, error: error instanceof Error ? error.message : '生成失败' })
    }
  })

  app.get('/music/generate/status', { preHandler: [app.requireAdmin] }, async (_request, reply) => {
    return reply.send({ ok: true, job: getJob() })
  })

  app.get('/music/latest', { preHandler: [app.requireAdmin] }, async (_request, reply) => {
    try {
      return reply.send({ ok: true, result: await loadLatest() })
    } catch (error) {
      app.log.error(error, 'music latest failed')
      return reply.code(500).send({ ok: false, error: '读取上次结果失败' })
    }
  })
}
