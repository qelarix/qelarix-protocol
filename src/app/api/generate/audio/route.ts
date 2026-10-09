import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import type { AudioModel } from "@/lib/credits"
import {
  getAudioModelById,
  resolveAudioCredits,
  canUseAudioModel,
  type AudioModelConfig,
} from "@/lib/audio-models"
import { isInternalUser } from "@/lib/planAccess"
import { PLAN_GATING_ENABLED } from "@/lib/plans"

fal.config({ credentials: process.env.FAL_KEY })

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
async function uploadToStorage(tempUrl: string, userId: string, type: 'image' | 'video' | 'audio', generationId: string, adminClient: any): Promise<string> {
  try {
    const ext = type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : 'jpg'
    const contentType = type === 'video' ? 'video/mp4' : type === 'audio' ? 'audio/mpeg' : 'image/jpeg'
    const path = `${userId}/${generationId}.${ext}`
    const response = await fetch(tempUrl)
    if (!response.ok) return tempUrl
    const buffer = await response.arrayBuffer()
    const { error } = await adminClient.storage.from('generations').upload(path, buffer, { contentType, upsert: true })
    if (error) { console.error('[storage upload]', error); return tempUrl }
    const { data } = adminClient.storage.from('generations').getPublicUrl(path)
    return data.publicUrl || tempUrl
  } catch (err) {
    console.error('[storage upload error]', err)
    return tempUrl
  }
}

// fal audio result schemas vary by model — parse the audio URL defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFalAudioUrl(payload: any): string | null {
  const d = payload?.data ?? payload
  if (!d) return null
  return (
    d.audio?.url ||
    d.audio_url ||
    d.audio_file?.url ||
    d.url ||
    (Array.isArray(d.audios) ? d.audios[0]?.url : null) ||
    (Array.isArray(d.outputs) ? d.outputs[0]?.url : null) ||
    null
  )
}

// Build the fal input from truthful, model-specific controls.
function buildAudioFalInput(
  model: AudioModelConfig,
  prompt: string,
  seconds: number | undefined,
  lyrics: string | undefined,
): Record<string, unknown> {
  switch (model.taskType) {
    case "tts": {
      const text = model.maxChars ? prompt.slice(0, model.maxChars) : prompt
      return { text }
    }
    case "music":
      // Lyria 2: prompt-only instrumental music.
      return { prompt }
    case "song":
      // ACE-Step: prompt -> style tags; optional lyrics; duration tier.
      return { tags: prompt, lyrics: (lyrics ?? "").trim(), duration: seconds ?? 60 }
    default:
      return { prompt }
  }
}

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const userId = authUser.id
  const isAdmin = isInternalUser(authUser)
  const plan = (authUser.plan as string) ?? "free"
  const isUltra = plan === 'ultra'

  let body: { prompt: string; duration?: 30 | 60 | 120 | number; model?: string; lyrics?: string; instrumental?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const { prompt } = body
  if (!prompt?.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 })

  // Resolve the audio model. Legacy callers send only { prompt, duration } -> Stability Audio.
  const requestedModelId = body.model ?? "stability_audio"
  const audioModel = getAudioModelById(requestedModelId)
  if (!audioModel) {
    return NextResponse.json({ error: "Unknown audio model" }, { status: 400 })
  }

  // Coming-soon / muapi audio (submit/status not wired) is not generatable yet.
  if (audioModel.status !== "active" || audioModel.route === "muapi") {
    return NextResponse.json(
      { error: `${audioModel.label} is coming soon.` },
      { status: 501 },
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any

  // ─────────────────────────────────────────────────────────────────────────────
  // Stability Audio — existing synchronous flow (length tiers). Unchanged behaviour.
  // ─────────────────────────────────────────────────────────────────────────────
  if (audioModel.route === "stability") {
    const duration = (body.duration ?? 30) as number
    if (![30, 60, 120].includes(duration)) {
      return NextResponse.json({ error: "Invalid duration. Use 30, 60, or 120." }, { status: 400 })
    }

    const FREE_AUDIO_MODELS = ['stability30s']
    const STARTER_AUDIO_MODELS = ['stability30s', 'stability60s']
    const modelKey: AudioModel = duration === 30 ? "stability30s" : duration === 60 ? "stability60s" : "stability2min"
    const creditCost = CREDITS.audio[modelKey]

    if (PLAN_GATING_ENABLED && !isAdmin && !isUltra) {
      if (plan === 'free' && !FREE_AUDIO_MODELS.includes(modelKey)) {
        return NextResponse.json({ error: 'This model requires Starter plan or higher.' }, { status: 403 })
      }
      if (plan === 'starter' && !STARTER_AUDIO_MODELS.includes(modelKey)) {
        return NextResponse.json({ error: 'This model requires Pro plan or higher.' }, { status: 403 })
      }
    }

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    const stabilityKey = process.env.STABILITY_API_KEY
    if (!stabilityKey) return NextResponse.json({ error: "Audio generation not configured" }, { status: 500 })

    // The generation id exists before the provider runs, so QLC billing can charge it first; the row is
    // written after success (no-op in credits mode).
    const genId = crypto.randomUUID()
    const charge = await reserveGenerationCharge({ user: authUser, generationId: genId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })

    const stabilityRes = await fetch("https://api.stability.ai/v2beta/audio/stable-audio/generate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stabilityKey}`,
        "Content-Type": "application/json",
        Accept: "audio/*",
      },
      body: JSON.stringify({ prompt: prompt.trim(), output_format: "mp3", duration, steps: 50 }),
    })

    if (!stabilityRes.ok) {
      const errText = await stabilityRes.text().catch(() => "unknown error")
      console.error("Stability AI audio error:", stabilityRes.status, errText)
      await releaseGenerationCharge({ generationId: genId, reason: "provider failed" })
      return NextResponse.json({ error: "Audio generation failed. Please try again." }, { status: 502 })
    }

    const audioBuffer = await stabilityRes.arrayBuffer()
    if (!audioBuffer.byteLength) {
      await releaseGenerationCharge({ generationId: genId, reason: "no output" })
      return NextResponse.json({ error: "Empty audio response from provider" }, { status: 502 })
    }

    const storagePath = `${userId}/${genId}.mp3`

    const { error: uploadError } = await supabase.storage
      .from("generations")
      .upload(storagePath, new Uint8Array(audioBuffer), { contentType: "audio/mpeg", upsert: true })

    if (uploadError) {
      console.error("Storage upload error:", uploadError)
      await releaseGenerationCharge({ generationId: genId, reason: "output could not be stored" })
      return NextResponse.json({ error: "Failed to store audio file" }, { status: 500 })
    }

    const { data: urlData } = supabase.storage.from("generations").getPublicUrl(storagePath)
    const audioUrl = urlData.publicUrl

    // Charge ONLY on success (admins are not charged but still proceed).
    const paid = await settleGenerationCharge({
      user: authUser, generationId: genId, credits: creditCost, description: `Audio generation ${duration}s (stable-audio)`, exempt: isAdmin, once: "this-request",
    })

    if (!paid) {
      await supabase.storage.from("generations").remove([storagePath])
      return NextResponse.json({ error: "Credit deduction failed" }, { status: 402 })
    }

    const { error: genError } = await supabase.from("generations").insert({
      id: genId,
      user_id: userId,
      type: "audio",
      model: modelKey,
      prompt: prompt.trim(),
      status: "completed",
      output_url: audioUrl,
      credits_used: creditCost,
      settings: { duration, model: audioModel.id },
      is_public: false,
    })

    if (genError) console.error("Generation insert error:", genError)

    return NextResponse.json({ url: audioUrl, audioUrl, creditsUsed: creditCost, generationId: genId })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // fal audio — eleven_v3 / eleven_multilingual_v2 / lyria2 / ace_step
  // ─────────────────────────────────────────────────────────────────────────────
  if (!isAdmin && !isUltra && !canUseAudioModel(audioModel, plan)) {
    return NextResponse.json(
      { error: `Your plan (${plan}) does not include ${audioModel.label}. Upgrade to use it.` },
      { status: 403 },
    )
  }

  // Tiered models (ACE-Step) take a requested duration; flat models ignore it.
  const requestedSeconds = typeof body.duration === "number" ? body.duration : undefined
  const { creditKey, credits: creditCost, seconds: effSeconds } = resolveAudioCredits(audioModel, requestedSeconds)

  const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
  if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

  if (!audioModel.falEndpoint) {
    return NextResponse.json({ error: `${audioModel.label} has no provider endpoint configured.` }, { status: 500 })
  }
  if (!process.env.FAL_KEY) {
    return NextResponse.json({ error: "Audio generation not configured" }, { status: 500 })
  }

  // ── ASYNC audio (ElevenLabs Music): submit to the fal QUEUE (NOT fal.subscribe — long songs would time out a sync
  //    request). Insert a PENDING generation; credits are deducted by the status route ONLY after output_url succeeds. ──
  if (audioModel.async) {
    const asyncGenId = crypto.randomUUID()
    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId: asyncGenId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    try {
      const input: Record<string, unknown> = {
        prompt: prompt.trim(),
        music_length_ms: (effSeconds ?? 60) * 1000,
        force_instrumental: body.instrumental === true,
        // output_format omitted → provider default is mp3 (audio/mpeg); avoids passing an unverified enum value.
      }
      const queued = await fal.queue.submit(audioModel.falEndpoint, { input }) as { request_id: string; response_url?: string }
      const { error: asyncErr } = await supabase.from("generations").insert({
        id: asyncGenId,
        user_id: userId,
        type: "audio",
        model: audioModel.id,
        prompt: prompt.trim(),
        status: "pending",
        output_url: null,
        credits_used: creditCost,
        credits_deducted: false,
        settings: {
          model: audioModel.id,
          duration: effSeconds ?? null,
          fal_endpoint: audioModel.falEndpoint,
          fal_request_id: queued.request_id,
          fal_response_url: queued.response_url ?? null,
          estimated_seconds: 60,
        },
        is_public: false,
      })
      if (asyncErr) {
        console.error("[generate/audio] async insert error:", asyncErr)
        await releaseGenerationCharge({ generationId: asyncGenId, reason: "generation could not be recorded" })
        return NextResponse.json({ error: "Failed to start audio generation." }, { status: 500 })
      }
      return NextResponse.json({ jobId: asyncGenId, status: "pending" })
    } catch (err) {
      console.error(`[generate/audio] fal queue submit error (${audioModel.id})`, err)
      await releaseGenerationCharge({ generationId: asyncGenId, reason: "provider submit failed" })
      return NextResponse.json({ error: "Audio generation failed to start. Please try again." }, { status: 502 })
    }
  }

  // The generation id exists before the provider runs, so QLC billing can charge it first; the row is
  // written after success (no-op in credits mode).
  const genId = crypto.randomUUID()
  const charge = await reserveGenerationCharge({ user: authUser, generationId: genId, credits: creditCost, exempt: isAdmin })
  if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })

  let tempUrl: string | null = null
  try {
    const input = buildAudioFalInput(audioModel, prompt.trim(), effSeconds, body.lyrics)
    const result = await fal.subscribe(audioModel.falEndpoint, { input })
    tempUrl = extractFalAudioUrl(result)
  } catch (err) {
    console.error(`[generate/audio] fal error (${audioModel.id})`, err)
    await releaseGenerationCharge({ generationId: genId, reason: "provider failed" })
    return NextResponse.json({ error: "Audio generation failed. Please try again." }, { status: 502 })
  }

  if (!tempUrl) {
    await releaseGenerationCharge({ generationId: genId, reason: "no output" })
    return NextResponse.json({ error: "No audio returned by provider" }, { status: 502 })
  }

  const audioUrl = await uploadToStorage(tempUrl, userId, "audio", genId, supabase)

  // Charge ONLY on success (admins are not charged but still proceed).
  const paid = await settleGenerationCharge({
    user: authUser, generationId: genId, credits: creditCost, exempt: isAdmin, once: "this-request",
    description: `Audio generation: ${audioModel.label}${effSeconds ? ` ${effSeconds}s` : ""} (${creditKey})`,
  })

  if (!paid) {
    return NextResponse.json({ error: "Credit deduction failed" }, { status: 402 })
  }

  const { error: genError } = await supabase.from("generations").insert({
    id: genId,
    user_id: userId,
    type: "audio",
    model: audioModel.id,
    prompt: prompt.trim(),
    status: "completed",
    output_url: audioUrl,
    credits_used: creditCost,
    settings: { duration: effSeconds ?? null, model: audioModel.id, fal_endpoint: audioModel.falEndpoint },
    is_public: false,
  })

  if (genError) console.error("Generation insert error:", genError)

  return NextResponse.json({ url: audioUrl, audioUrl, creditsUsed: creditCost, generationId: genId })
}

export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any
  const { data: history } = await supabase
    .from("generations")
    .select("id, prompt, output_url, credits_used, settings, created_at")
    .eq("user_id", authUser.id)
    .eq("type", "audio")
    .order("created_at", { ascending: false })
    .limit(12)

  return NextResponse.json({ history: history ?? [] })
}
