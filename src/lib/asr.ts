import { config } from '../config.js'

const base = config.DASHSCOPE_BASE_URL.replace(/\/$/, '')

export type AsrWord = { text: string; beginMs: number }

type Sentence = { words?: { text?: string; begin_time?: number }[] }

async function submit(fileUrl: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'paraformer-v2',
      input: { file_urls: [fileUrl] },
      parameters: { channel_id: [0], language_hints: ['en'] },
    }),
  })

  const data = (await res.json()) as {
    output?: { task_id?: string }
    message?: string
    code?: string
  }

  if (!res.ok || !data.output?.task_id) {
    throw new Error(`ASR 提交失败 (${data.code ?? res.status}) ${data.message ?? ''}`)
  }
  return data.output.task_id
}

async function waitForResult(taskId: string): Promise<string> {
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${config.DASHSCOPE_API_KEY}` },
    })
    const data = (await res.json()) as {
      output?: {
        task_status?: string
        results?: { transcription_url?: string; output?: { transcription_url?: string } }[]
      }
      message?: string
    }

    const status = data.output?.task_status
    if (status === 'SUCCEEDED') {
      const first = data.output?.results?.[0]
      const url = first?.transcription_url ?? first?.output?.transcription_url
      if (!url) throw new Error('ASR 未返回转写结果')
      return url
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(`ASR 任务失败 (${status}) ${data.message ?? ''}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 4000))
  }

  throw new Error('ASR 任务超时')
}

export async function transcribeAudio(fileUrl: string): Promise<AsrWord[]> {
  const taskId = await submit(fileUrl)
  const transcriptionUrl = await waitForResult(taskId)
  const res = await fetch(transcriptionUrl)
  if (!res.ok) throw new Error(`ASR 结果下载失败 ${res.status}`)
  const data = (await res.json()) as { transcripts?: { sentences?: Sentence[] }[] }

  const words: AsrWord[] = []
  for (const transcript of data.transcripts ?? []) {
    for (const sentence of transcript.sentences ?? []) {
      for (const word of sentence.words ?? []) {
        const text = word.text?.trim()
        const beginMs = word.begin_time
        if (text && typeof beginMs === 'number') words.push({ text, beginMs })
      }
    }
  }
  return words
}
