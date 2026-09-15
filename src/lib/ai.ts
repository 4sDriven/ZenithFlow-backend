import { config } from '../config.js'

const base = config.DASHSCOPE_BASE_URL.replace(/\/$/, '')

function authHeaders() {
  return {
    Authorization: `Bearer ${config.DASHSCOPE_API_KEY}`,
    'Content-Type': 'application/json',
  }
}

export type ScriptShot = {
  description: string
  narration?: string
  duration?: number
}

export type GeneratedScript = {
  title: string
  shots: ScriptShot[]
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced?.[1] ?? text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
  return JSON.parse(candidate)
}

export async function generateScript(params: {
  topic: string
  style?: string
  durationSec: number
  shotCount: number
}): Promise<GeneratedScript> {
  const { topic, style, durationSec, shotCount } = params

  const system =
    '你是资深短视频策划。根据用户给出的主题，产出一份可直接拍摄的短视频脚本。只输出 JSON，不要任何多余文字或解释。'
  const user = `主题：${topic}
风格：${style || '通用'}
总时长：约 ${durationSec} 秒
分镜数量：${shotCount} 个

请严格输出如下 JSON 结构（不要改动字段名）：
{"title":"视频标题","shots":[{"description":"画面描述：包含镜头/场景/主体动作，将直接用作文生视频提示词","narration":"该镜的旁白或台词（可留空）","duration":单个镜头秒数}]}`

  const res = await fetch(`${base}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'qwen-plus',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.8,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`脚本生成失败 (${res.status}) ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  const parsed = extractJson(content) as GeneratedScript

  if (!parsed?.shots?.length) {
    throw new Error('脚本解析失败')
  }

  return parsed
}

function buildVideoParameters(
  model: string,
  resolution: string,
  requestedDuration: number,
): Record<string, unknown> {
  const sizeMap: Record<string, string> = {
    '480P': '832*480',
    '720P': '1280*720',
    '1080P': '1920*1080',
  }

  if (model === 'wan2.2-t2v-plus') {
    return { size: sizeMap[resolution] ?? '832*480', duration: 5 }
  }
  if (model === 'wan2.5-t2v-preview') {
    return { size: sizeMap[resolution] ?? '1280*720', duration: requestedDuration <= 5 ? 5 : 10 }
  }
  if (model.startsWith('happyhorse') || model.startsWith('wan2.7') || model.startsWith('wan3.0')) {
    return { resolution, duration: Math.min(Math.max(requestedDuration, 3), 15) }
  }
  return {
    size: sizeMap[resolution] ?? '1280*720',
    duration: Math.min(Math.max(requestedDuration, 3), 10),
  }
}

export async function submitTextToVideo(params: {
  prompt: string
  model?: string
  resolution?: string
  duration?: number
}): Promise<string> {
  const { prompt, model = 'wan2.5-t2v-preview', resolution = '720P', duration = 5 } = params
  const parameters = buildVideoParameters(model, resolution, duration)

  const res = await fetch(`${base}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers: { ...authHeaders(), 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model,
      input: { prompt },
      parameters,
    }),
  })

  const data = (await res.json()) as {
    output?: { task_id?: string }
    message?: string
    code?: string
  }

  if (!res.ok || !data.output?.task_id) {
    throw new Error(`视频任务提交失败 (${data.code ?? res.status}) ${data.message ?? ''}`)
  }

  return data.output.task_id
}

export type VideoTaskResult = {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'UNKNOWN'
  videoUrl?: string
  message?: string
}

export async function queryVideoTask(taskId: string): Promise<VideoTaskResult> {
  const res = await fetch(`${base}/api/v1/tasks/${taskId}`, {
    headers: authHeaders(),
  })

  const data = (await res.json()) as {
    output?: {
      task_status?: string
      video_url?: string
      message?: string
    }
  }

  return {
    status: (data.output?.task_status ?? 'UNKNOWN') as VideoTaskResult['status'],
    videoUrl: data.output?.video_url,
    message: data.output?.message,
  }
}

export async function synthesizeSpeech(params: {
  text: string
  voice?: string
  tone?: string
}): Promise<string> {
  const { text, voice = 'Cherry', tone } = params

  const input: Record<string, unknown> = { text, voice, language_type: 'Chinese' }
  if (tone) {
    input.instructions = tone
    input.optimize_instructions = true
  }

  const res = await fetch(`${base}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'qwen3-tts-instruct-flash',
      input,
    }),
  })

  const data = (await res.json()) as {
    output?: { audio?: { url?: string } }
    message?: string
    code?: string
  }

  const url = data.output?.audio?.url
  if (!res.ok || !url) {
    throw new Error(`语音合成失败 (${data.code ?? res.status}) ${data.message ?? ''}`)
  }

  return url
}
