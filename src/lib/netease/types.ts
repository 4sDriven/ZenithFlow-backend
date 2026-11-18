export type TrackSource = 'deep' | 'new'

export type TrackCandidate = {
  id: string
  originalId: string | null
  name: string
  artists: string
  album: string | null
  reason: string
  source: TrackSource
}

export type GenerationTrack = TrackCandidate & { position: number }

export type GenerationResult = {
  generationId: string
  playlist: {
    id: string
    originalId: string
    name: string
    url: string | null
  }
  tracks: GenerationTrack[]
  counts: { deep: number; new: number; total: number }
  generatedAt: string
}

export type GenerationPhase = 'idle' | 'running' | 'done' | 'failed'

export type GenerationJob = {
  phase: GenerationPhase
  step: string
  message: string
  startedAt: number | null
  finishedAt: number | null
  result: GenerationResult | null
  error: string | null
}
