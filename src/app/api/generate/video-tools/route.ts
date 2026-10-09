import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import { meetsPlan, type PlanId } from "@/lib/plans"
import { isInternalUser } from "@/lib/planAccess"

// ── Video Tools v1 — Bytedance Video Upscale + PixVerse Video Extend ────────────────────────────
// Pricing/source-of-truth: MASTER Excel "Final Video Pricing" rows 152-158 (locked 2026-06-12) →
// CREDITS.videoTools. Veo 3.1 Extend and Upscale "Pro mode" are COMING SOON — deliberately NOT
// implemented here (do not add). Credits are checked upfront but deducted ONLY on success (status route).
// The existing MUAPI /api/generate/video-extend tool is untouched and stays CURRENT.

fal.config({ credentials: process.env.FAL_KEY })

const UPSCALE_ENDPOINT = "fal-ai/bytedance-upscaler/upscale/video"
const EXTEND_ENDPOINT = "fal-ai/pixverse/extend"

type UpscaleResolution = "1080p" | "2k" | "4k"
type ExtendResolution = "720p" | "1080p"

interface VideoToolsBody {
  tool: "upscale" | "extend"
  video_url: string
  // upscale
  resolution?: UpscaleResolution | ExtendResolution
  fps?: 30 | 60
  duration_seconds?: number // measured client-side from the source video metadata (charged per OUTPUT second)
  // extend
  prompt?: string
}

const UPSCALE_PER_SEC: Record<UpscaleResolution, number> = {
  "1080p": CREDITS.videoTools.video_upscale_1080p,
  "2k": CREDITS.videoTools.video_upscale_2k,
  "4k": CREDITS.videoTools.video_upscale_4k,
}
const EXTEND_FLAT: Record<ExtendResolution, number> = {
  "720p": CREDITS.videoTools.video_extend_pixverse_720p,
  "1080p": CREDITS.videoTools.video_extend_pixverse_1080p,
}

// Cost-control clamp for the per-second upscale charge basis (source video length).
const MIN_UPSCALE_SECONDS = 1
const MAX_UPSCALE_SECONDS = 300

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
    const isAdmin = isInternalUser(authUser)
    const userPlan = (authUser.plan as PlanId | undefined) ?? "free"

    // Same gate as the existing Video Extend tool (Pro+).
    if (!meetsPlan(userPlan, "pro") && !isAdmin) {
      return NextResponse.json({ error: "Video Tools require the Pro plan or higher." }, { status: 403 })
    }

    if (!process.env.FAL_KEY) {
      return NextResponse.json({ error: "FAL API key is not configured." }, { status: 500 })
    }

    const body = (await req.json()) as VideoToolsBody
    const { tool, video_url } = body

    if (tool !== "upscale" && tool !== "extend") {
      return NextResponse.json({ error: "tool must be 'upscale' or 'extend'" }, { status: 400 })
    }
    if (!video_url || !/^https?:\/\//.test(video_url)) {
      return NextResponse.json({ error: "A public video_url is required." }, { status: 400 })
    }

    // ── Per-tool validation + cost (MASTER-locked; no other tiers exist) ──
    let creditCost = 0
    let model = ""
    let falEndpoint = ""
    let falInput: Record<string, unknown> = {}
    let settingsExtra: Record<string, unknown> = {}

    if (tool === "upscale") {
      const resolution = body.resolution as UpscaleResolution | undefined
      const fps = body.fps ?? 30
      if (!resolution || !(resolution in UPSCALE_PER_SEC)) {
        return NextResponse.json({ error: "resolution must be 1080p, 2k or 4k" }, { status: 400 })
      }
      if (fps !== 30 && fps !== 60) {
        return NextResponse.json({ error: "fps must be 30 or 60" }, { status: 400 })
      }
      const rawSec = Number(body.duration_seconds)
      if (!Number.isFinite(rawSec) || rawSec <= 0) {
        return NextResponse.json({ error: "duration_seconds (source video length) is required for upscale." }, { status: 400 })
      }
      const chargedSeconds = Math.min(MAX_UPSCALE_SECONDS, Math.max(MIN_UPSCALE_SECONDS, Math.ceil(rawSec)))
      const fpsMultiplier = fps === 60 ? 2 : 1 // MASTER rule: 60fps = 2x credits (2x provider cost, same margin)
      creditCost = UPSCALE_PER_SEC[resolution] * fpsMultiplier * chargedSeconds
      model = "video_upscale"
      falEndpoint = UPSCALE_ENDPOINT
      // Provider field names (verified against the fal schema): `target_resolution` ("1080p"|"2k"|"4k")
      // and `target_fps` ("30fps"|"60fps"). The previous `resolution`/`frame_rate` names were IGNORED by
      // the provider, so it silently defaulted to 1080p — that was the "selected 4K, got 1080p error" bug.
      const targetResolution = resolution // already "1080p" | "2k" | "4k" — exact enum match
      const targetFps = fps === 60 ? "60fps" : "30fps"
      falInput = { video_url, target_resolution: targetResolution, target_fps: targetFps }
      settingsExtra = { resolution, fps, charged_seconds: chargedSeconds }
    } else {
      const resolution = (body.resolution as ExtendResolution | undefined) ?? "720p"
      if (!(resolution in EXTEND_FLAT)) {
        return NextResponse.json({ error: "resolution must be 720p or 1080p" }, { status: 400 })
      }
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
      if (prompt.length > 2000) {
        return NextResponse.json({ error: "Prompt cannot exceed 2000 characters." }, { status: 400 })
      }
      creditCost = EXTEND_FLAT[resolution]
      model = "video_extend_pixverse"
      falEndpoint = EXTEND_ENDPOINT
      falInput = { video_url, resolution, ...(prompt ? { prompt } : {}) }
      settingsExtra = { resolution, prompt: prompt || null, extend_seconds: 5 }
    }

    if (creditCost <= 0) {
      return NextResponse.json({ error: "Could not calculate the credit cost." }, { status: 400 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    // Upfront credit CHECK only — deduction happens in the status route, success-only.
    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    // Pending generation row (same table/shape as the other video tools → appears in history when completed).
    const promptLabel =
      tool === "upscale"
        ? `Video upscale ${settingsExtra.resolution} ${settingsExtra.fps}fps`
        : (settingsExtra.prompt as string | null) || `Video extend +5s (${settingsExtra.resolution})`
    const { data: generation, error: insertError } = await adminAny
      .from("generations")
      .insert({
        user_id: userId,
        type: "video",
        model,
        prompt: promptLabel,
        status: "pending",
        credits_used: creditCost,
        settings: {
          tool,
          fal_endpoint: falEndpoint,
          fal_request_id: null,
          fal_response_url: null,
          video_url,
          ...settingsExtra,
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[video-tools] insert error", insertError)
      return NextResponse.json({ error: "Could not create the generation." }, { status: 500 })
    }
    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    // ── Submit to the fal queue ──
    try {
      const queued = await fal.queue.submit(falEndpoint, { input: falInput })
      const requestId = (queued as { request_id?: string; requestId?: string })?.request_id
        ?? (queued as { requestId?: string })?.requestId
        ?? null
      const responseUrl = (queued as { response_url?: string })?.response_url ?? null
      if (!requestId) {
        console.error("[video-tools] fal submit returned no request id", JSON.stringify(queued).slice(0, 300))
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
        return NextResponse.json({ error: "Provider did not accept the job." }, { status: 502 })
      }
      await adminAny
        .from("generations")
        .update({
          settings: {
            tool,
            fal_endpoint: falEndpoint,
            fal_request_id: requestId,
            fal_response_url: responseUrl,
            video_url,
            ...settingsExtra,
          },
        })
        .eq("id", generationId)

      return NextResponse.json({ jobId: generationId, generationId, creditCost })
    } catch (submitErr) {
      const e = submitErr as { status?: number; body?: { detail?: unknown }; message?: string }
      console.error("[video-tools] fal.queue.submit failed:", JSON.stringify({
        endpoint: falEndpoint,
        status: e?.status,
        detail: JSON.stringify(e?.body?.detail ?? e?.body ?? e?.message).slice(0, 800),
      }))
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
      return NextResponse.json({ error: "The provider rejected the job. Please try again." }, { status: 502 })
    }
  } catch (err) {
    console.error("[video-tools] unexpected error", err)
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 })
  }
}
