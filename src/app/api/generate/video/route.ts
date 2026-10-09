import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { canAccessVideo } from "@/lib/plans"
import { calculateVideoCost, getModelById } from "@/lib/video-models"
import type { PlanId } from "@/lib/plans"
import type { AspectRatio, CameraMotion } from "@/lib/video-models"
import { isInternalUser } from "@/lib/planAccess"

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


const MUAPI_BASE = "https://api.muapi.ai/v1"

interface GenerateBody {
  model: string
  prompt: string
  duration: number
  aspect_ratio: AspectRatio
  camera_motion?: CameraMotion
  with_audio?: boolean
  image_url?: string | null
  first_frame_url?: string | null
  last_frame_url?: string | null
  // Playground visual-input pipeline (prepared shape; mapped onto image_url/first_frame_url/last_frame_url
  // at parse time). Real PUBLIC urls (history or fal.storage upload) — never blob:.
  referenceImageUrl?: string | null
  referenceImageUrls?: string[] | null // Kling O1 Reference-to-Video: multiple subject/character refs → provider image_urls[]
  startFrameUrl?: string | null
  endFrameUrl?: string | null
  resolution?: '480p' | '580p' | '720p' | '1080p' // per-model output tier (Grok / Wan 2.2 / Wan 2.5); injected from the registry, not a user control
  debugPayloadOnly?: boolean // DEV-ONLY: return the resolved endpoint + provider input preview WITHOUT submitting/inserting/deducting
}

interface MuapiGenerateResponse {
  job_id?: string
  id?: string
  task_id?: string
  error?: string
  message?: string
}


// Build fal.ai-specific input from our generic settings
function buildFalInput(
  falEndpoint: string,
  body: GenerateBody,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    prompt: body.prompt,
  }

  // Aspect ratio
  base.aspect_ratio = body.aspect_ratio

  // Per-model specifics — each branch sets duration in the format required by that model
  if (falEndpoint.includes("wan/v2.2")) {
    // Wan 2.2 A14B t2v: prompt-only; NO duration field — duration is num_frames / fps.
    // num_frames must be 17-161 (inclusive) @16fps → ~1-10s (15s/240 frames is unsupported, clamped to 161).
    // Resolution is a per-model tier (480p/580p/720p) injected from the registry. No audio.
    base.frames_per_second = 16
    base.num_frames = Math.max(17, Math.min(161, Math.round(body.duration * 16)))
    if (body.resolution) base.resolution = body.resolution
  } else if (falEndpoint.includes("ltx-video")) {
    if (body.image_url) base.image_url = body.image_url
    // LTX: max 5s supported
    base.num_frames = Math.min(body.duration, 5) * 25
  } else if (falEndpoint.includes("ray-2/image-to-video")) {
    // Luma Ray IMAGE-TO-VIDEO (dedicated endpoint): image_url = start image (from referenceImageUrl/image_url OR
    // startFrameUrl/first_frame_url); end_image_url = OPTIONAL end (from endFrameUrl/last_frame_url). Duration enum
    // 5s/9s; resolution LOCKED to 540p (no 720p/1080p surcharge tier). NO camera_motion (not in i2v schema), NO audio.
    const startImg = body.image_url || body.first_frame_url
    if (startImg) base.image_url = startImg
    if (body.last_frame_url) base.end_image_url = body.last_frame_url
    base.duration = body.duration >= 9 ? "9s" : "5s"
    base.resolution = "540p"
  } else if (falEndpoint.includes("luma-dream-machine")) {
    if (body.image_url) base.image_url = body.image_url
    if (body.camera_motion && body.camera_motion !== "Static") {
      base.camera_motion = body.camera_motion
    }
    // luma ray-2: duration must be "5s" or "9s", no audio support
    base.duration = body.duration >= 9 ? "9s" : "5s"
  } else if (falEndpoint.includes("pika")) {
    if (body.image_url) base.image_url = body.image_url
    // pika: max 5s supported
    base.duration = Math.min(body.duration, 5)
  } else if (falEndpoint.includes("minimax")) {
    // minimax/video-01: only accepts prompt (no duration, no aspect_ratio)
    delete base.aspect_ratio
  } else if (falEndpoint.includes("kling-video/o1")) {
    // Kling O1 Reference-to-Video: prompt + image_urls[] (1..N subject/character reference images). NO image_url,
    // NO start/end/tail frame. Duration enum "5"/"10". No generate_audio (audio block regex excludes o1; priced no==yes).
    const refUrls = (Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls : [])
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    if (refUrls.length > 0) base.image_urls = refUrls
    base.duration = body.duration <= 5 ? "5" : "10"
  } else if (falEndpoint.includes("kling-video")) {
    if (body.first_frame_url) base.image_url = body.first_frame_url
    else if (body.image_url) base.image_url = body.image_url
    if (body.last_frame_url) base.tail_image_url = body.last_frame_url
    if (falEndpoint.includes("v2.1") ||
        falEndpoint.includes("v3/") ||
        falEndpoint.includes("o3/")) {
      // v2.1, v3, o3 — podrzavaju 5/10/15
      base.duration = body.duration <= 5 ? "5" : body.duration >= 15 ? "15" : "10"
    } else {
      // v2.6 and v1.6 — 5/10 only
      base.duration = body.duration <= 5 ? "5" : "10"
    }
  } else if (falEndpoint.includes("seedance-2.0") || falEndpoint.includes("seedance/v2")) {
    // Seedance 2.0 — generate_audio supported (verified) → respect the in-box Audio On/Off toggle (default on).
    base.duration = String(body.duration)
    base.generate_audio = body.with_audio !== false
    // Image-to-Video (…/image-to-video endpoint): SINGLE start image only → image_url. NO end frame, NO multi-ref,
    // NO role metadata. No-op for the text-to-video endpoint (it never receives a start frame).
    if (falEndpoint.includes("image-to-video")) {
      const startImg = body.first_frame_url || body.image_url
      if (startImg) base.image_url = startImg
    }
  } else if (falEndpoint.includes("seedance/v1.5")) {
    // Seedance 1.5 Pro — ima audio
    base.duration = String(body.duration)
    base.generate_audio = body.with_audio !== false
  } else if (falEndpoint.includes("seedance")) {
    // Seedance v1 lite — no audio, legacy endpoint
    base.duration = String(body.duration)
    base.audio = false
  } else if (falEndpoint.includes("veo2")) {
    if (body.camera_motion && body.camera_motion !== "Static") {
      base.camera_motion = body.camera_motion
    }
    // veo2: duration as "5s" – "8s" (max 8)
    const d = Math.min(body.duration, 8)
    base.duration = `${d}s`
  } else if (falEndpoint.includes("veo3.1/first-last-frame")) {
    // Veo 3.1 First/Last Frame — requires first_frame_url + last_frame_url; duration enum '4s'/'6s'/'8s';
    // audio set in the audio block (generate_audio); resolution left default (720p — no 1080p/4K here).
    base.duration = `${body.duration}s`
    if (body.first_frame_url) base.first_frame_url = body.first_frame_url
    if (body.last_frame_url) base.last_frame_url = body.last_frame_url
  } else if (falEndpoint.includes("veo3.1")) {
    // Veo 3.1 Standard + Fast (fal-ai/veo3.1 and /fast): duration is a STRING enum '4s'/'6s'/'8s' (DURATION FIX
    // 2026-06-06 — live 422 + fal API schema proved integer/5-10-15 invalid). camera_motion supported. FLF handled above.
    if (body.camera_motion && body.camera_motion !== "Static") {
      base.camera_motion = body.camera_motion
    }
    base.duration = `${body.duration}s`
  } else if (falEndpoint.includes("veo3")) {
    // Veo 3 (fal-ai/veo3): duration is a STRING enum '4s'/'6s'/'8s'; aspect 16:9/9:16; resolution defaults 720p
    // (no separate verified 1080p price → no upcharge). Audio on/off handled in the audio block via with_audio.
    base.duration = `${body.duration}s`
  } else if (falEndpoint.includes("grok-imagine-video")) {
    // xAI Grok Imagine Video (served via fal). Prompt-only; integer duration; native audio (no toggle, no surcharge).
    // Resolution is a per-model tier (720p standard / 480p budget) injected from the registry — not a user control.
    base.duration = body.duration
    if (body.resolution === "480p" || body.resolution === "720p") base.resolution = body.resolution
  } else if (falEndpoint.includes("sora-2")) {
    // Sora 2 / Sora 2 Pro: prompt-only (character_ids optional, unused here); integer duration enum [4,8,12,16,20]; native audio (no toggle, surcharge 0).
    // resolution:720p — base Sora 2 already defaults to 720p (no-op); Sora 2 Pro defaults to 1080p, so this FORCES 720p to match our 720p-only locked pricing.
    // delete_video:false keeps the fal output alive long enough for the status route to download + persist it to our own storage.
    base.duration = body.duration
    base.resolution = "720p"
    base.delete_video = false
  } else {
    base.duration = body.duration
  }

  // Audio — clean slate, then set exactly one param per model (seedance handles its own)
  if (!falEndpoint.includes('seedance')) {
    delete base.with_audio
    delete base.audio
    delete base.generate_audio
    delete base.sound

    if (
      falEndpoint.includes('kling-video/v2.1') ||
      falEndpoint.includes('kling-video/v2.6') ||
      falEndpoint.includes('kling-video/v3')
    ) {
      // Kling v2.1/v2.6/v3 — generate_audio supported (verified) → respect the in-box Audio On/Off toggle (default on).
      base.generate_audio = body.with_audio !== false
    }
    if (falEndpoint.includes('veo2') || falEndpoint.includes('veo3')) {
      // Veo 2/3/3.1 native audio — respect the model's audio capability (Veo 3 has a distinct silent variant).
      // Veo 2 / Veo 3.1 are hasAudio:true so they always send with_audio:true → generate_audio:true (unchanged).
      base.generate_audio = body.with_audio !== false
    }
    if (falEndpoint.includes('minimax')) {
      base.generate_audio = true
    }
  }

  return base
}

// Determine fal.ai endpoint: handle i2v variants per model
function resolveFalEndpoint(model: ReturnType<typeof getModelById>): string | null {
  if (!model?.falEndpoint) return null

  return model.falEndpoint
}

export async function POST(req: NextRequest) {
  try {
    // ── Auth ──
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
    const userPlan = (authUser.plan as PlanId) ?? "free"
    const isAdmin = isInternalUser(authUser)
    const isUltra = userPlan === 'ultra'

    // ── Parse body ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await req.json()) as any
    const body: GenerateBody = {
      ...raw,
      aspect_ratio: raw.aspect_ratio ?? raw.aspectRatio,
      with_audio: raw.with_audio ?? raw.withAudio,
      // Map the prepared visual-input shape onto the provider fields buildFalInput already consumes
      // per-endpoint. Existing image_url/first_frame_url/last_frame_url (from other surfaces) take priority,
      // so no current caller changes. Client only sends these when the model declares the capability.
      image_url: raw.image_url ?? raw.referenceImageUrl ?? null,
      first_frame_url: raw.first_frame_url ?? raw.startFrameUrl ?? null,
      last_frame_url: raw.last_frame_url ?? raw.endFrameUrl ?? null,
    }
    const { model: modelId, prompt, duration, aspect_ratio } = body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    if (!modelId || !prompt?.trim() || !duration || !aspect_ratio) {
      return NextResponse.json({ error: "model, prompt, duration, and aspect_ratio are required" }, { status: 400 })
    }
    if (prompt.length > 5000) {
      return NextResponse.json({ error: "Prompt cannot exceed 5000 characters" }, { status: 400 })
    }

    // ── Validate model ──
    const model = getModelById(modelId)
    if (!model) {
      return NextResponse.json({ error: "Unknown model" }, { status: 400 })
    }

    const isMuapi = !!model.muapiModel
    const falEndpoint = isMuapi ? null : resolveFalEndpoint(model)

    // ── Debug Preview Payload (DEV-ONLY) ─────────────────────────────────────────────────────────────────
    // Return the EXACT resolved endpoint + provider input that a real generation WOULD send — with ZERO side
    // effects: NO fal.queue.submit, NO generation row, NO credit check/deduction, NO upload, NO Supabase write.
    // Resolution/endpoint/input use the SAME resolveFalEndpoint + buildFalInput as real generation, so the preview
    // can never drift from the real payload. Placed BEFORE every guard so an incomplete payload can still be inspected.
    // Only the provider endpoint + input + model metadata are returned — never FAL_KEY / tokens / headers / secrets.
    if (body.debugPayloadOnly === true) {
      const debugEnabled = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_QELARIX_DEBUG_PAYLOADS === "true"
      if (!debugEnabled) return NextResponse.json({ error: "Debug payload preview is disabled." }, { status: 403 })
      const dWithAudio = model.hasAudio ? (isMuapi ? true : (body.with_audio ?? true)) : false
      const dPriceModelId = modelId === "luma3_i2v" ? "luma3" : modelId === "seedance20_i2v" ? "seedance20" : modelId === "seedance2_i2v" ? "seedance2" : modelId
      const dCredits = calculateVideoCost(dPriceModelId, duration, dWithAudio)
      let endpoint: string | null = falEndpoint
      let input: Record<string, unknown> | null = null
      if (isMuapi && model.muapiModel) {
        endpoint = `MUAPI:${model.muapiModel}`
        input = {
          model: model.muapiModel, prompt: prompt.trim(), duration, aspect_ratio,
          ...(body.image_url ? { image_url: body.image_url, mode: "image_to_video" } : {}),
          ...(body.camera_motion && body.camera_motion !== "Static" ? { camera_motion: body.camera_motion } : {}),
        }
      } else if (falEndpoint) {
        if (model.resolution) body.resolution = model.resolution // per-model output tier (same injection as real generation)
        input = buildFalInput(falEndpoint, body)
      }
      return NextResponse.json({
        debug: true,
        model: modelId,
        effectiveModel: { id: model.id, label: model.label, priceKey: dPriceModelId },
        endpoint,
        input,
        credits: dCredits,
        withAudio: dWithAudio,
        note: "Preview only — no provider call, no generation row, no credits deducted",
      })
    }

    // First/Last Frame requires BOTH public frame urls — fail truthfully, never silently fall back to text-to-video.
    if ((falEndpoint ?? "").includes("first-last-frame") && (!body.first_frame_url || !body.last_frame_url)) {
      return NextResponse.json(
        { error: "First/Last Frame requires both a start frame and an end frame image." },
        { status: 400 },
      )
    }

    if (!isMuapi && !falEndpoint) {
      return NextResponse.json(
        { error: `Model '${model.label}' is not currently available. API integration in progress.` },
        { status: 501 },
      )
    }

    // ── Plan check ──
    if (!isAdmin && !isUltra && !canAccessVideo(userPlan, modelId)) {
      return NextResponse.json(
        { error: `Your plan (${userPlan}) does not support this model. Please upgrade your plan.` },
        { status: 403 },
      )
    }

    // ── Credit check ──
    // Happy Horse 1.0: audio is always native (no surcharge), treat with_audio as true
    const withAudio = model.hasAudio ? (isMuapi ? true : (body.with_audio ?? true)) : false
    // Luma i2v reuses the luma3 base price tier (same duration cost at 540p; no separate i2v VIDEO_PRICES key).
    const priceModelId = modelId === 'luma3_i2v' ? 'luma3'
      : modelId === 'seedance20_i2v' ? 'seedance20'
      : modelId === 'seedance2_i2v' ? 'seedance2'
      : modelId
    const creditCost = calculateVideoCost(priceModelId, duration, withAudio)
    if (creditCost <= 0) {
      return NextResponse.json({ error: "Could not calculate the credit cost" }, { status: 400 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    // Provjeri unlimited period
    let isUnlimited = false
    if (!isAdmin && ['pro', 'business', 'ultra'].includes(userPlan)) {
      const now = new Date().toISOString()
      const { data: unlimitedPeriod } = await adminAny
        .from('unlimited_periods')
        .select('id, limit_count, used_count')
        .eq('user_id', userId)
        .eq('model_id', modelId)
        .eq('is_active', true)
        .gt('expires_at', now)
        .single()

      if (unlimitedPeriod) {
        const up = unlimitedPeriod as { id: string; limit_count: number | null; used_count: number }
        if (up.limit_count === null) {
          isUnlimited = true
        } else if (up.used_count < up.limit_count) {
          isUnlimited = true
          await adminAny
            .from('unlimited_periods')
            .update({ used_count: up.used_count + 1 })
            .eq('id', up.id)
        }
      }
    }

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin || isUnlimited })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    // Dedup: the same user+model+prompt already pending/processing in the last 30 s → return the existing jobId
    const dupCutoff = new Date(Date.now() - 30_000).toISOString()
    const { data: dupGen } = await adminAny
      .from('generations')
      .select('id')
      .eq('user_id', userId)
      .eq('model', modelId)
      .eq('prompt', prompt.trim())
      .in('status', ['pending', 'processing'])
      .gte('created_at', dupCutoff)
      .limit(1)
      .maybeSingle()

    if (dupGen?.id) {
      return NextResponse.json({ jobId: dupGen.id })
    }

    // ── MUAPI path (Happy Horse 1.0 and future Muapi models) ──
    if (isMuapi && model.muapiModel) {
      const muapiKey = process.env.MUAPI_API_KEY
      if (!muapiKey) {
        return NextResponse.json({ error: "MUAPI API key is not configured" }, { status: 500 })
      }

      // Create DB record
      const { data: generation, error: insertError } = await adminAny
        .from("generations")
        .insert({
          user_id: userId,
          type: "video",
          model: modelId,
          prompt: prompt.trim(),
          status: "pending",
          credits_used: creditCost,
          is_public: false,
          settings: {
            duration,
            aspect_ratio,
            camera_motion: body.camera_motion ?? "Static",
            with_audio: true,
            image_url: body.image_url ?? null,
            first_frame_url: null,
            last_frame_url: null,
            muapi_model: model.muapiModel,
            muapi_job_id: null,
            estimated_seconds: model.estimatedSeconds,
            watermark: userPlan === "free",
          },
        })
        .select("id")
        .single()

      if (insertError || !generation) {
        console.error("[generate/video] muapi insert error", insertError)
        return NextResponse.json({ error: "Could not create generation" }, { status: 500 })
      }

      const generationId = (generation as { id: string }).id

      // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
      const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin || isUnlimited })
      if (!charge.ok) {
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
      }

      // Submit to MUAPI
      let muapiJobId: string
      try {
        const muapiPayload: Record<string, unknown> = {
          model: model.muapiModel,
          prompt: prompt.trim(),
          duration,
          aspect_ratio,
        }
        if (body.image_url) {
          muapiPayload.image_url = body.image_url
          muapiPayload.mode = "image_to_video"
        }
        if (body.camera_motion && body.camera_motion !== "Static") {
          muapiPayload.camera_motion = body.camera_motion
        }

        const muapiRes = await fetch(`${MUAPI_BASE}/video/generate`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${muapiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(muapiPayload),
        })

        if (!muapiRes.ok) {
          const errText = await muapiRes.text().catch(() => "")
          console.error("[generate/video] muapi error", muapiRes.status, errText)
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
          return NextResponse.json(
            { error: `MUAPI generation failed (${muapiRes.status})` },
            { status: 502 },
          )
        }

        const muapiData = (await muapiRes.json()) as MuapiGenerateResponse
        muapiJobId = muapiData.job_id ?? muapiData.id ?? muapiData.task_id ?? ""

        if (!muapiJobId) {
          console.error("[generate/video] muapi missing job_id", muapiData)
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
          return NextResponse.json({ error: "MUAPI did not return a job ID" }, { status: 502 })
        }
      } catch (muapiErr) {
        console.error("[generate/video] muapi fetch error", muapiErr)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
        return NextResponse.json({ error: "Error sending the request to MUAPI" }, { status: 502 })
      }

      // Save muapi_job_id
      await adminAny
        .from("generations")
        .update({
          settings: {
            duration,
            aspect_ratio,
            camera_motion: body.camera_motion ?? "Static",
            with_audio: true,
            image_url: body.image_url ?? null,
            first_frame_url: null,
            last_frame_url: null,
            muapi_model: model.muapiModel,
            muapi_job_id: muapiJobId,
            estimated_seconds: model.estimatedSeconds,
          },
        })
        .eq("id", generationId)

      return NextResponse.json({ jobId: generationId })
    }

    // ── fal.ai path ──
    // Create DB record
    const { data: generation, error: insertError } = await adminAny
      .from("generations")
      .insert({
        user_id: userId,
        type: "video",
        model: modelId,
        prompt: prompt.trim(),
        status: "pending",
        credits_used: creditCost,
        is_public: false,
        settings: {
          duration,
          aspect_ratio,
          camera_motion: body.camera_motion ?? "Static",
          with_audio: withAudio,
          image_url: body.image_url ?? null,
          first_frame_url: body.first_frame_url ?? null,
          last_frame_url: body.last_frame_url ?? null,
          fal_endpoint: falEndpoint,
          fal_request_id: null,
          watermark: userPlan === "free",
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[generate/video] insert error", insertError)
      return NextResponse.json({ error: "Could not create generation" }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin || isUnlimited })
    if (!charge.ok) {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    // ── Submit to fal.ai queue ──
    const effectiveFalEndpoint = falEndpoint!
    // xAI Grok Imagine Video: output resolution is a per-model tier (720p / 480p), not a user control — inject from the registry.
    if (model.resolution) body.resolution = model.resolution
    const falInput = buildFalInput(effectiveFalEndpoint, body)

    let requestId = ""
    let falResponseUrl: string | null = null // fal's canonical result URL (response_url) — authoritative for the status fetch (avoids endpoint-path reconstruction / queue.result 422s)
    try {
      const queued = await fal.queue.submit(effectiveFalEndpoint, { input: falInput })
      requestId = queued.request_id
      falResponseUrl = (queued as { response_url?: string }).response_url ?? null
    } catch (falErr) {
      // NO silent fallback (removed 2026-06-06): the user must receive EXACTLY the model they selected — never a
      // substitute (the prior fal-ai/ltx-video retry mis-attributed cost/output to the chosen model). On submit failure →
      // mark the generation failed + return a clear error. NO credits are deducted here (they're charged only after a
      // verified output_url in the status route), so a failed submit costs the user nothing and no wrong-model job is created.
      const e = falErr as { status?: number; body?: { detail?: unknown }; message?: string }
      const detail = e?.body?.detail ?? e?.body ?? e?.message
      console.error("[generate/video] fal.queue.submit failed (no fallback):", JSON.stringify({
        model: model.id, endpoint: effectiveFalEndpoint, status: e?.status, detail: JSON.stringify(detail).slice(0, 500),
      }))
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
      return NextResponse.json({ error: `Generation failed for ${model.label} — please try again.`, status: "failed" }, { status: 502 })
    }

    // ── Save request_id ──
    await adminAny
      .from("generations")
      .update({
        settings: {
          duration,
          aspect_ratio,
          camera_motion: body.camera_motion ?? "Static",
          with_audio: withAudio,
          image_url: body.image_url ?? null,
          first_frame_url: body.first_frame_url ?? null,
          last_frame_url: body.last_frame_url ?? null,
          fal_endpoint: effectiveFalEndpoint,
          fal_request_id: requestId,
          fal_response_url: falResponseUrl,
        },
      })
      .eq("id", generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error("[generate/video]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

