import { config } from '../config.js'

export const EMBEDDING_MODEL = 'text-embedding-v4'
export const EMBEDDING_DIM = 1024

const base = config.DASHSCOPE_BASE_URL.replace(/\/$/, '')

type EmbedResponse = {
  output?: { embeddings?: { embedding: number[] }[] }
  code?: string
  message?: string
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const result: number[][] = []
  const batchSize = 10

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)

    const res = await fetch(`${base}/api/v1/services/embeddings/text-embedding/text-embedding`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: { texts: batch },
        parameters: { dimension: EMBEDDING_DIM },
      }),
    })

    const data = (await res.json()) as EmbedResponse
    const embeddings = data.output?.embeddings

    if (!res.ok || !embeddings || embeddings.length !== batch.length) {
      throw new Error(`向量生成失败 (${data.code ?? res.status}) ${data.message ?? ''}`)
    }

    for (const item of embeddings) {
      result.push(item.embedding)
    }
  }

  return result
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }

  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
