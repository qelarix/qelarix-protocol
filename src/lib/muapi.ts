const MUAPI_BASE = 'https://api.muapi.ai/v1'

export interface MuapiJobResponse {
  job_id?: string
  id?: string
  task_id?: string
  error?: string
  message?: string
}

export interface MuapiStatusResponse {
  status?: string
  state?: string
  video_url?: string
  image_url?: string
  output_url?: string
  output?: { url?: string } | string
  progress?: number
  error?: string
  message?: string
}

interface VideoGenerateOptions {
  prompt: string
  duration?: number
  aspect_ratio?: string
  image_url?: string
  camera_motion?: string
}

interface VideoExtendOptions {
  video_url: string
  prompt?: string
  duration?: number
}

export class MuapiClient {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generateHappyHorse(
    prompt: string,
    duration = 5,
    aspectRatio = '16:9',
    imageUrl?: string,
  ): Promise<MuapiJobResponse> {
    const body: Record<string, unknown> = {
      model: 'happy-horse-1.0',
      prompt,
      duration,
      aspect_ratio: aspectRatio,
    }
    if (imageUrl) body.image_url = imageUrl
    return this.post('/video/generate', body)
  }

  async generateSeedance2Lite(options: VideoGenerateOptions): Promise<MuapiJobResponse> {
    const body: Record<string, unknown> = {
      model: 'seedance-2-lite',
      prompt: options.prompt,
      duration: options.duration ?? 5,
      aspect_ratio: options.aspect_ratio ?? '16:9',
    }
    if (options.image_url) body.image_url = options.image_url
    if (options.camera_motion && options.camera_motion !== 'Static') {
      body.camera_motion = options.camera_motion
    }
    return this.post('/video/generate', body)
  }

  async generateInfiniteTalk(
    imageUrl: string,
    audioUrl: string,
  ): Promise<MuapiJobResponse> {
    return this.post('/video/infinite-talk', {
      image_url: imageUrl,
      audio_url: audioUrl,
    })
  }

  async extendVideo(options: VideoExtendOptions): Promise<MuapiJobResponse> {
    const body: Record<string, unknown> = {
      video_url: options.video_url,
      duration: options.duration ?? 5,
    }
    if (options.prompt) body.prompt = options.prompt
    return this.post('/video/extend', body)
  }

  async removeWatermark(videoUrl: string): Promise<MuapiJobResponse> {
    return this.post('/video/remove-watermark', { video_url: videoUrl })
  }

  async getJobStatus(jobId: string): Promise<MuapiStatusResponse> {
    const res = await fetch(`${MUAPI_BASE}/video/status/${jobId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) {
      const error = await res.text()
      throw new Error(`MUAPI status error ${res.status}: ${error}`)
    }
    return res.json() as Promise<MuapiStatusResponse>
  }

  extractVideoUrl(data: MuapiStatusResponse): string | null {
    if (typeof data.video_url === 'string') return data.video_url
    if (typeof data.output_url === 'string') return data.output_url
    if (typeof data.output === 'string') return data.output
    if (typeof data.output === 'object' && data.output !== null) {
      return (data.output as { url?: string }).url ?? null
    }
    return null
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<MuapiJobResponse> {
    const res = await fetch(`${MUAPI_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const error = await res.text()
      throw new Error(`MUAPI error ${res.status}: ${error}`)
    }
    return res.json() as Promise<MuapiJobResponse>
  }
}

export function createMuapiClient(): MuapiClient {
  const apiKey = process.env.MUAPI_API_KEY
  if (!apiKey) throw new Error('MUAPI_API_KEY is not set')
  return new MuapiClient(apiKey)
}

export function extractMuapiJobId(data: MuapiJobResponse): string | null {
  return data.job_id ?? data.id ?? data.task_id ?? null
}

export function parseMuapiStatus(status: string): 'completed' | 'failed' | 'processing' | 'pending' {
  const s = status.toLowerCase()
  if (s === 'completed' || s === 'success' || s === 'done') return 'completed'
  if (s === 'failed' || s === 'error' || s === 'cancelled') return 'failed'
  if (s === 'processing' || s === 'generating' || s === 'running') return 'processing'
  return 'pending'
}

// ── MuAPI image "AI apps" ──────────────────────────────────────────────────────
// These live on a DIFFERENT base than the legacy video methods above: the AI-apps
// tools are POST https://api.muapi.ai/api/v1/<slug> (async → request_id), polled at
// GET https://api.muapi.ai/api/v1/predictions/{request_id}/result. The video methods
// (MUAPI_BASE = .../v1/video/*) are unchanged. Submit/result response shapes are
// untyped in MuAPI's public OpenAPI, so output-URL extraction is defensive.
const MUAPI_IMAGE_BASE = 'https://api.muapi.ai/api/v1'

export interface MuapiImageSubmit {
  requestId: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any
}

export async function runMuapiImageApp(
  slug: string,
  payload: Record<string, unknown>,
): Promise<MuapiImageSubmit> {
  const apiKey = process.env.MUAPI_API_KEY
  if (!apiKey) throw new Error('MUAPI_API_KEY is not set')
  const res = await fetch(`${MUAPI_IMAGE_BASE}/${slug}`, {
    method: 'POST',
    // MuAPI AI-apps endpoints authenticate with `x-api-key` (NOT Authorization: Bearer — Bearer 403s on
    // submit/result even though the read-only /models endpoint accepts both). Verified 2026-06-23.
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    let detail = bodyText
    try {
      const j = JSON.parse(bodyText)
      detail = j?.detail || j?.error?.message || j?.message || bodyText
    } catch { /* keep raw text */ }
    throw new Error(`MUAPI ${res.status}: ${detail || res.statusText}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await res.json()) as any
  const requestId = raw.request_id ?? raw.requestId ?? raw.id ?? raw.job_id ?? raw.task_id ?? null
  return { requestId, raw }
}

export interface MuapiImageResult {
  status: 'completed' | 'failed' | 'processing' | 'pending'
  outputUrl: string | null
  errorMessage: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImageOutputUrl(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null
  const pickUrl = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : (v && typeof v === 'object' ? (v as { url?: string }).url : undefined)
  const candidates: Array<string | undefined> = [
    raw.image_url, raw.output_url, raw.result_url, raw.url,
    pickUrl(raw.output), pickUrl(raw.result),
    Array.isArray(raw.outputs) ? pickUrl(raw.outputs[0]) : undefined,
    Array.isArray(raw.images) ? pickUrl(raw.images[0]) : undefined,
  ]
  for (const c of candidates) if (typeof c === 'string' && c.startsWith('http')) return c
  return null
}

export async function getMuapiPredictionResult(requestId: string): Promise<MuapiImageResult> {
  const apiKey = process.env.MUAPI_API_KEY
  if (!apiKey) throw new Error('MUAPI_API_KEY is not set')
  const res = await fetch(`${MUAPI_IMAGE_BASE}/predictions/${requestId}/result`, {
    headers: { 'x-api-key': apiKey },
  })
  // MuAPI reports a failed prediction as a non-2xx response with the result wrapped in `detail`,
  // e.g. HTTP 400 {"detail":{"status":"failed","error":"..."}}. Read the body for every response
  // so an explicit failure reaches the refund path instead of polling forever.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await res.json().catch(() => null)) as any
  const body = raw?.detail && typeof raw.detail === 'object' ? raw.detail : raw
  const outputUrl = res.ok ? extractImageOutputUrl(raw) : null
  if (outputUrl) return { status: 'completed', outputUrl, errorMessage: null, raw }
  const rawStatus = (body?.status ?? body?.state ?? 'pending') as string
  const status = parseMuapiStatus(typeof rawStatus === 'string' ? rawStatus : 'pending')
  if (status === 'failed') {
    return { status: 'failed', outputUrl: null, errorMessage: body?.error ?? body?.message ?? null, raw }
  }
  // Non-2xx without an explicit failure (e.g. not ready yet) → keep polling.
  if (!res.ok) return { status: 'processing', outputUrl: null, errorMessage: null, raw: null }
  // "completed" with no URL yet → keep polling.
  return { status: status === 'completed' ? 'processing' : status, outputUrl: null, errorMessage: null, raw }
}
