import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { videoProjects, videoShots } from '../db/schema.js'
import {
  generateScript,
  queryVideoTask,
  submitTextToVideo,
  synthesizeSpeech,
} from '../lib/ai.js'
import {
  burnSubtitles,
  composeShot,
  concatShots,
  copyMedia,
  downloadToMedia,
  probeDuration,
} from '../lib/media.js'

const projectSchema = z.object({
  title: z.string().min(1).max(200),
  topic: z.string().min(1).max(2000),
  style: z.string().max(64).optional(),
  durationSec: z.coerce.number().int().min(5).max(120).default(15),
  videoModel: z.string().max(64).default('wan2.5-t2v-preview'),
  resolution: z.enum(['480P', '720P', '1080P']).default('720P'),
  voice: z.string().max(32).default('Cherry'),
  voiceTone: z.string().max(128).optional(),
})

const updateProjectSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  style: z.string().max(64).optional(),
  videoModel: z.string().max(64).optional(),
  resolution: z.enum(['480P', '720P', '1080P']).optional(),
  voice: z.string().max(32).optional(),
  voiceTone: z.string().max(128).optional(),
})

const scriptSchema = z.object({
  shotCount: z.coerce.number().int().min(1).max(12).default(3),
})

async function findProject(userId: number, id: number) {
  const [project] = await db
    .select()
    .from(videoProjects)
    .where(and(eq(videoProjects.id, id), eq(videoProjects.userId, userId)))
    .limit(1)
  return project
}

async function findShot(userId: number, id: number) {
  const [shot] = await db.select().from(videoShots).where(eq(videoShots.id, id)).limit(1)
  if (!shot) return undefined
  const project = await findProject(userId, shot.projectId)
  return project ? shot : undefined
}

async function renderProject(projectId: number) {
  try {
    const [project] = await db
      .select()
      .from(videoProjects)
      .where(eq(videoProjects.id, projectId))
      .limit(1)
    if (!project) return

    const shots = await db
      .select()
      .from(videoShots)
      .where(eq(videoShots.projectId, projectId))
      .orderBy(asc(videoShots.shotIndex))

    if (shots.length === 0) {
      throw new Error('还没有分镜')
    }

    const dir = `projects/${projectId}`
    const composedRels: string[] = []
    const cues: { start: number; end: number; text: string }[] = []
    let cursor = 0

    for (const shot of shots) {
      let videoRel = shot.localVideoPath ?? undefined
      if (!videoRel) {
        if (!shot.videoUrl) {
          throw new Error(`镜头 ${shot.shotIndex} 还没有生成视频`)
        }
        videoRel = `${dir}/shot-${shot.shotIndex}.mp4`
        await downloadToMedia(shot.videoUrl, videoRel)
        await db
          .update(videoShots)
          .set({ localVideoPath: videoRel, updatedAt: new Date() })
          .where(eq(videoShots.id, shot.id))
      }

      const narration = shot.narration?.trim()
      let audioRel = shot.localAudioPath ?? undefined
      if (narration && !audioRel) {
        try {
          const audioUrl = await synthesizeSpeech({
            text: narration,
            voice: project.voice,
            tone: project.voiceTone ?? undefined,
          })
          audioRel = `${dir}/shot-${shot.shotIndex}.mp3`
          await downloadToMedia(audioUrl, audioRel)
          await db
            .update(videoShots)
            .set({ audioUrl, localAudioPath: audioRel, updatedAt: new Date() })
            .where(eq(videoShots.id, shot.id))
        } catch {
          audioRel = undefined
        }
      }

      const composedRel = `${dir}/composed-${shot.shotIndex}.mp4`
      await composeShot({ videoRel, audioRel, outRel: composedRel })
      composedRels.push(composedRel)

      const duration = await probeDuration(composedRel)
      if (narration) {
        cues.push({
          start: cursor + 0.15,
          end: cursor + Math.max(duration - 0.15, 0.8),
          text: narration,
        })
      }
      cursor += duration
    }

    const mergedRel = `${dir}/merged.mp4`
    const first = composedRels[0]
    if (composedRels.length === 1 && first) {
      await copyMedia(first, mergedRel)
    } else {
      await concatShots(composedRels, mergedRel)
    }

    let finalRel = mergedRel
    if (cues.length > 0) {
      const subbedRel = `${dir}/final.mp4`
      await burnSubtitles({ videoRel: mergedRel, cues, outRel: subbedRel })
      finalRel = subbedRel
    }

    await db
      .update(videoProjects)
      .set({
        finalVideoPath: finalRel,
        renderStatus: 'done',
        renderError: null,
        status: 'done',
        updatedAt: new Date(),
      })
      .where(eq(videoProjects.id, projectId))
  } catch (e) {
    await db
      .update(videoProjects)
      .set({
        renderStatus: 'failed',
        renderError: e instanceof Error ? e.message : '合成失败',
        updatedAt: new Date(),
      })
      .where(eq(videoProjects.id, projectId))
  }
}

export async function videoRoutes(app: FastifyInstance) {
  app.get('/video/projects', { preHandler: [app.requireAuth] }, async (request) => {
    const list = await db
      .select()
      .from(videoProjects)
      .where(eq(videoProjects.userId, request.user.sub))
      .orderBy(desc(videoProjects.id))
    return { ok: true, projects: list }
  })

  app.post('/video/projects', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = projectSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }

    const [created] = await db
      .insert(videoProjects)
      .values({
        userId: request.user.sub,
        title: parsed.data.title,
        topic: parsed.data.topic,
        style: parsed.data.style,
        durationSec: parsed.data.durationSec,
        videoModel: parsed.data.videoModel,
        resolution: parsed.data.resolution,
        voice: parsed.data.voice,
        voiceTone: parsed.data.voiceTone,
      })
      .returning()

    if (!created) {
      return reply.code(500).send({ ok: false, error: '创建失败' })
    }

    return reply.code(201).send({ ok: true, project: created })
  })

  app.get('/video/projects/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const project = await findProject(request.user.sub, id)
    if (!project) {
      return reply.code(404).send({ ok: false, error: '项目不存在' })
    }

    const shots = await db
      .select()
      .from(videoShots)
      .where(eq(videoShots.projectId, id))
      .orderBy(asc(videoShots.shotIndex))

    return { ok: true, project, shots }
  })

  app.delete('/video/projects/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const [deleted] = await db
      .delete(videoProjects)
      .where(and(eq(videoProjects.id, id), eq(videoProjects.userId, request.user.sub)))
      .returning()

    if (!deleted) {
      return reply.code(404).send({ ok: false, error: '项目不存在' })
    }

    return { ok: true }
  })

  app.patch('/video/projects/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const project = await findProject(request.user.sub, id)
    if (!project) {
      return reply.code(404).send({ ok: false, error: '项目不存在' })
    }

    const parsed = updateProjectSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '参数不合法' })
    }

    const data = parsed.data
    const patch: Partial<typeof videoProjects.$inferInsert> = { updatedAt: new Date() }
    if (data.title !== undefined) patch.title = data.title
    if (data.style !== undefined) patch.style = data.style
    if (data.videoModel !== undefined) patch.videoModel = data.videoModel
    if (data.resolution !== undefined) patch.resolution = data.resolution
    if (data.voice !== undefined) patch.voice = data.voice
    if (data.voiceTone !== undefined) patch.voiceTone = data.voiceTone

    const [updated] = await db
      .update(videoProjects)
      .set(patch)
      .where(eq(videoProjects.id, id))
      .returning()

    return { ok: true, project: updated }
  })

  app.post(
    '/video/projects/:id/script',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const id = Number((request.params as { id: string }).id)
      const project = await findProject(request.user.sub, id)
      if (!project) {
        return reply.code(404).send({ ok: false, error: '项目不存在' })
      }

      const parsed = scriptSchema.safeParse(request.body ?? {})
      const shotCount = parsed.success ? parsed.data.shotCount : 3

      let script
      try {
        script = await generateScript({
          topic: project.topic,
          style: project.style ?? undefined,
          durationSec: project.durationSec,
          shotCount,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : '脚本生成失败'
        return reply.code(502).send({ ok: false, error: message })
      }

      const shots = script.shots.slice(0, shotCount)
      const per = Math.max(3, Math.round(project.durationSec / shots.length))

      await db.delete(videoShots).where(eq(videoShots.projectId, id))
      await db.insert(videoShots).values(
        shots.map((shot, i) => ({
          projectId: id,
          shotIndex: i + 1,
          description: shot.description,
          narration: shot.narration ?? '',
          durationSec: Math.min(Math.max(shot.duration || per, 3), 15),
        })),
      )

      await db
        .update(videoProjects)
        .set({ status: 'scripted', updatedAt: new Date() })
        .where(eq(videoProjects.id, id))

      const created = await db
        .select()
        .from(videoShots)
        .where(eq(videoShots.projectId, id))
        .orderBy(asc(videoShots.shotIndex))

      return { ok: true, title: script.title, shots: created }
    },
  )

  app.post(
    '/video/shots/:id/generate',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const id = Number((request.params as { id: string }).id)
      const shot = await findShot(request.user.sub, id)
      if (!shot) {
        return reply.code(404).send({ ok: false, error: '分镜不存在' })
      }
      const project = await findProject(request.user.sub, shot.projectId)
      if (!project) {
        return reply.code(404).send({ ok: false, error: '分镜不存在' })
      }

      try {
        const taskId = await submitTextToVideo({
          prompt: shot.description,
          model: project.videoModel,
          resolution: project.resolution,
          duration: shot.durationSec,
        })
        await db
          .update(videoShots)
          .set({ status: 'generating', taskId, error: null, updatedAt: new Date() })
          .where(eq(videoShots.id, id))
        return { ok: true, status: 'generating', taskId }
      } catch (e) {
        const message = e instanceof Error ? e.message : '提交失败'
        await db
          .update(videoShots)
          .set({ status: 'failed', error: message, updatedAt: new Date() })
          .where(eq(videoShots.id, id))
        return reply.code(502).send({ ok: false, error: message })
      }
    },
  )

  app.get('/video/shots/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const shot = await findShot(request.user.sub, id)
    if (!shot) {
      return reply.code(404).send({ ok: false, error: '分镜不存在' })
    }

    if (shot.status === 'generating' && shot.taskId) {
      try {
        const result = await queryVideoTask(shot.taskId)
        if (result.status === 'SUCCEEDED' && result.videoUrl) {
          await db
            .update(videoShots)
            .set({ status: 'done', videoUrl: result.videoUrl, updatedAt: new Date() })
            .where(eq(videoShots.id, id))
          shot.status = 'done'
          shot.videoUrl = result.videoUrl
        } else if (result.status === 'FAILED' || result.status === 'CANCELED') {
          const message = result.message ?? '生成失败'
          await db
            .update(videoShots)
            .set({ status: 'failed', error: message, updatedAt: new Date() })
            .where(eq(videoShots.id, id))
          shot.status = 'failed'
          shot.error = message
        }
      } catch {
        // ignore transient query errors; return current state
      }
    }

    return { ok: true, shot }
  })

  app.post('/video/shots/:id/audio', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const shot = await findShot(request.user.sub, id)
    if (!shot) {
      return reply.code(404).send({ ok: false, error: '分镜不存在' })
    }
    if (!shot.narration?.trim()) {
      return reply.code(400).send({ ok: false, error: '该镜头没有旁白' })
    }

    const project = await findProject(request.user.sub, shot.projectId)
    if (!project) {
      return reply.code(404).send({ ok: false, error: '分镜不存在' })
    }

    try {
      const audioUrl = await synthesizeSpeech({
        text: shot.narration,
        voice: project.voice,
        tone: project.voiceTone ?? undefined,
      })
      const audioRel = `projects/${shot.projectId}/shot-${shot.shotIndex}.mp3`
      await downloadToMedia(audioUrl, audioRel)
      await db
        .update(videoShots)
        .set({ audioUrl, localAudioPath: audioRel, updatedAt: new Date() })
        .where(eq(videoShots.id, id))
      return { ok: true, localAudioPath: audioRel }
    } catch (e) {
      const message = e instanceof Error ? e.message : '配音失败'
      return reply.code(502).send({ ok: false, error: message })
    }
  })

  app.post(
    '/video/projects/:id/render',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const id = Number((request.params as { id: string }).id)
      const project = await findProject(request.user.sub, id)
      if (!project) {
        return reply.code(404).send({ ok: false, error: '项目不存在' })
      }
      if (project.renderStatus === 'rendering') {
        return reply.code(409).send({ ok: false, error: '正在合成中，请稍候' })
      }

      await db
        .update(videoProjects)
        .set({ renderStatus: 'rendering', renderError: null, updatedAt: new Date() })
        .where(eq(videoProjects.id, id))

      void renderProject(id)

      return { ok: true, status: 'rendering' }
    },
  )
}
