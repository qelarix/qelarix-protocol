import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import { extractMuapiJobId } from "@/lib/muapi"
import { meetsPlan, type PlanId } from "@/lib/plans"
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

const MUAPI_BASE = "https://api.muapi.ai/v1"

type LipSyncCreditsKey = keyof typeof CREDITS.lipSync

interface ModelConfig {
  falEndpoint: string | null
  muapiEndpoint?: string
  minPlan: PlanId
  creditsKey: LipSyncCreditsKey
  estimatedSeconds: number
}

const MODEL_CONFIG: Record<string, ModelConfig> = {
  latentsync: {
    falEndpoint: "fal-ai/latentsync",
    minPlan: "starter",
    creditsKey: "latentsync",
    estimatedSeconds: 35,
  },
  "wav2lip-hd": {
    falEndpoint: "fal-ai/wav2lip",
    minPlan: "starter",
    creditsKey: "wav2lip_hd",
    estimatedSeconds: 50,
  },
  musetalk: {
    falEndpoint: "fal-ai/musetalk",
    minPlan: "starter",
    creditsKey: "musetalk",
    estimatedSeconds: 25,
  },
  ditto: {
    falEndpoint: "fal-ai/ditto-talkinghead",
    minPlan: "pro",
    creditsKey: "ditto",
    estimatedSeconds: 65,
  },
  hedra: {
    falEndpoint: "fal-ai/hedra-character-2",
    minPlan: "pro",
    creditsKey: "hedra",
    estimatedSeconds: 90,
  },
  "infinite-talk": {
    falEndpoint: null,
    muapiEndpoint: "/video/infinite-talk",
    minPlan: "pro",
    creditsKey: "infinite_talk",
    estimatedSeconds: 60,
  },
  "ltx-lipsync": {
    falEndpoint: "fal-ai/ltx-video/lipsync",
    minPlan: "starter",
    creditsKey: "ltx_lipsync",
    estimatedSeconds: 50,
  },
  "video-retalking": {
    falEndpoint: "fal-ai/video-retalking",
    minPlan: "starter",
    creditsKey: "video_retalking",
    estimatedSeconds: 50,
  },
  sadtalker: {
    falEndpoint: "fal-ai/sadtalker",
    minPlan: "starter",
    creditsKey: "sadtalker",
    estimatedSeconds: 35,
  },
  // ── Phase 1 expansion (fal.ai; input keys verified against fal OpenAPI). ──
  "kling-lipsync": {
    falEndpoint: "fal-ai/kling-video/lipsync/audio-to-video",
    minPlan: "starter",
    creditsKey: "kling_lipsync",
    estimatedSeconds: 45,
  },
  "kling-avatar-v2-standard": {
    falEndpoint: "fal-ai/kling-video/ai-avatar/v2/standard",
    minPlan: "pro",
    creditsKey: "kling_avatar_v2_standard",
    estimatedSeconds: 60,
  },
  "kling-avatar-v2-pro": {
    falEndpoint: "fal-ai/kling-video/ai-avatar/v2/pro",
    minPlan: "pro",
    creditsKey: "kling_avatar_v2_pro",
    estimatedSeconds: 70,
  },
  "sync-lipsync-2-pro": {
    falEndpoint: "fal-ai/sync-lipsync/v2/pro",
    minPlan: "pro",
    creditsKey: "sync_lipsync_2_pro",
    estimatedSeconds: 60,
  },
}

// PLAN_LEVEL now imported from @/lib/plans (single source for the plan hierarchy).

function buildLipSyncInput(
  modelId: string,
  faceUrl: string,
  audioUrl: string,
  intensity: number,
): Record<string, unknown> {
  const intensityNorm = Math.max(0, Math.min(100, intensity)) / 100

  switch (modelId) {
    case "latentsync":
      return { video_url: faceUrl, audio_url: audioUrl }

    case "wav2lip-hd":
      return { face_url: faceUrl, audio_url: audioUrl }

    case "musetalk":
      return { video_url: faceUrl, audio_url: audioUrl }

    case "ditto":
      return { image_url: faceUrl, audio_url: audioUrl }

    case "hedra":
      return { image_url: faceUrl, audio_url: audioUrl }

    case "infinite-talk":
      return { image_url: faceUrl, audio_url: audioUrl }

    case "ltx-lipsync":
      return { video_url: faceUrl, audio_url: audioUrl }

    case "video-retalking":
      return { face_url: faceUrl, audio_url: audioUrl }

    case "sadtalker":
      return {
        source_image_url: faceUrl,
        driven_audio_url: audioUrl,
        expression_scale: parseFloat((intensityNorm * 3).toFixed(2)),
      }

    // ── Phase 1: video-to-video lip-sync (faceUrl carries the video). ──
    case "kling-lipsync":
    case "sync-lipsync-2-pro":
      return { video_url: faceUrl, audio_url: audioUrl }

    // ── Phase 1: image-to-video talking avatar (faceUrl carries the image). ──
    case "kling-avatar-v2-standard":
    case "kling-avatar-v2-pro":
      return { image_url: faceUrl, audio_url: audioUrl }

    default:
      return { face_url: faceUrl, audio_url: audioUrl }
  }
}

interface GenerateBody {
  model: string
  face_url: string
  audio_url: string
  intensity?: number
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
  const isAdmin = isInternalUser(authUser)
    const userPlan = ((authUser.plan as PlanId | undefined) ?? "free")

    const body = (await req.json()) as GenerateBody
    const { model: modelId, face_url, audio_url, intensity = 75 } = body

    if (!modelId || !face_url || !audio_url) {
      return NextResponse.json(
        { error: "model, face_url i audio_url su obavezni" },
        { status: 400 },
      )
    }

    const config = MODEL_CONFIG[modelId]
    if (!config) {
      return NextResponse.json({ error: "Nepoznati model" }, { status: 400 })
    }

    if (!meetsPlan(userPlan, config.minPlan)) {
      return NextResponse.json(
        { error: `Your plan (${userPlan}) does not include this model. Upgrade your plan.` },
        { status: 403 },
      )
    }

    const creditCost = CREDITS.lipSync[config.creditsKey]

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    // ── MUAPI path (Infinite Talk) ──
    if (config.muapiEndpoint) {
      const muapiKey = process.env.MUAPI_API_KEY
      if (!muapiKey) {
        return NextResponse.json({ error: "MUAPI API key is not configured" }, { status: 500 })
      }

      const { data: generation, error: insertError } = await adminAny
        .from("generations")
        .insert({
          user_id: userId,
          // generations.type CHECK constraint allows only video/image/audio/edit — lip-sync output is a
          // video, so store "video" ("lipsync" violates the constraint). model below preserves the model id.
          type: "video",
          model: modelId,
          prompt: `Infinite Talk: lip sync`,
          status: "pending",
          credits_used: creditCost,
          settings: {
            fal_endpoint: null,
            fal_request_id: null,
            muapi_endpoint: config.muapiEndpoint,
            muapi_job_id: null,
            face_url,
            audio_url,
            intensity,
            estimated_seconds: config.estimatedSeconds,
          },
        })
        .select("id")
        .single()

      if (insertError || !generation) {
        console.error("[lip-sync] muapi insert error", insertError)
        return NextResponse.json({ error: "Could not create the generation" }, { status: 500 })
      }

      const generationId = (generation as { id: string }).id

      // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
      const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
      if (!charge.ok) {
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
      }

      let muapiJobId: string
      try {
        const muapiRes = await fetch(`${MUAPI_BASE}${config.muapiEndpoint}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${muapiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ image_url: face_url, audio_url }),
        })

        if (!muapiRes.ok) {
          const errText = await muapiRes.text().catch(() => "")
          console.error("[lip-sync] muapi error", muapiRes.status, errText)
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
          return NextResponse.json(
            { error: `MUAPI submission failed (${muapiRes.status})` },
            { status: 502 },
          )
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const muapiData = (await muapiRes.json()) as any
        const extractedId = extractMuapiJobId(muapiData)
        if (!extractedId) {
          console.error("[lip-sync] muapi missing job_id", muapiData)
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
          return NextResponse.json({ error: "MUAPI did not return a job ID" }, { status: 502 })
        }
        muapiJobId = extractedId
      } catch (muapiErr) {
        console.error("[lip-sync] muapi fetch error", muapiErr)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
        return NextResponse.json({ error: "Failed to send the request to MUAPI" }, { status: 502 })
      }

      await adminAny
        .from("generations")
        .update({
          settings: {
            fal_endpoint: null,
            fal_request_id: null,
            muapi_endpoint: config.muapiEndpoint,
            muapi_job_id: muapiJobId,
            face_url,
            audio_url,
            intensity,
            estimated_seconds: config.estimatedSeconds,
          },
        })
        .eq("id", generationId)

      return NextResponse.json({ jobId: generationId })
    }

    // ── fal.ai path ──
    const { data: generation, error: insertError } = await adminAny
      .from("generations")
      .insert({
        user_id: userId,
        // generations.type CHECK constraint allows only video/image/audio/edit — lip-sync output is a
        // video, so store "video" ("lipsync" violates the constraint). model below preserves the model id.
        type: "video",
        model: modelId,
        prompt: `Lip sync: ${modelId}`,
        status: "pending",
        credits_used: creditCost,
        settings: {
          fal_endpoint: config.falEndpoint,
          fal_request_id: null,
          face_url,
          audio_url,
          intensity,
          estimated_seconds: config.estimatedSeconds,
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[lip-sync] insert error", insertError)
      return NextResponse.json({ error: "Could not create the generation" }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    const falInput = buildLipSyncInput(modelId, face_url, audio_url, intensity)

    let requestId: string
    try {
      const queued = await fal.queue.submit(config.falEndpoint!, { input: falInput })
      requestId = queued.request_id
    } catch (falErr) {
      console.error("[lip-sync] fal.ai submit error", falErr)
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
      return NextResponse.json({ error: "fal.ai submission failed" }, { status: 502 })
    }

    await adminAny
      .from("generations")
      .update({
        settings: {
          fal_endpoint: config.falEndpoint,
          fal_request_id: requestId,
          face_url,
          audio_url,
          intensity,
          estimated_seconds: config.estimatedSeconds,
        },
      })
      .eq("id", generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error("[lip-sync]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
