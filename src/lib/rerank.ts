import { config } from '../config.js'

export const RERANK_MODEL = 'qwen3-rerank'

const base = config.DASHSCOPE_BASE_URL.replace(/\/$/, '')

export async function rerankDocuments(
  query: string,
  documents: string[],
  topN: number,
): Promise<{ index: number; score: number }[]> {
  if (documents.length === 0) return []

  const res = await fetch(`${base}/api/v1/services/rerank/text-rerank/text-rerank`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: RERANK_MODEL,
      input: { query, documents },
      parameters: { return_documents: false, top_n: Math.min(topN, documents.length) },
    }),
  })

  const data = (await res.json()) as {
    output?: { results?: { index: number; relevance_score: number }[] }
    code?: string
    message?: string
  }

  const results = data.output?.results
  if (!res.ok || !results) {
    throw new Error(`重排失败 (${data.code ?? res.status}) ${data.message ?? ''}`)
  }

  return results.map((r) => ({ index: r.index, score: r.relevance_score }))
}
