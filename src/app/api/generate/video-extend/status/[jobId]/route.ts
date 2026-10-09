import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { parseMuapiStatus } from "@/lib/muapi"

const MUAPI_BASE = "https://api.muapi.ai/v1"

interface GenerationSettings {
  muapi_model?: string
  muapi_job_id?: string | null
  video_url?: string
  prompt?: string | null
  duration?: number
  estimated_seconds?: number
}

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
    const { jobId } = params

    if (!jobId) {
      return NextResponse.json({ error: "jobId je obavezan" }, { status: 400 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const { data: generation, error: fetchError } = await admin
      .from("generations")
      .select("id, status, output_url, credits_used, settings, created_at, prompt")
      .eq("id", jobId)
      .eq("user_id", userId)
      .single()

    if (fetchError || !generation) {
      return NextResponse.json({ error: "Generation not found" }, { status: 404 })
    }

    const gen = generation as {
      id: string
      status: string
      output_url: string | null
      credits_used: number
      settings: GenerationSettings
      created_at: string
      prompt: string
    }

    if (gen.status === "completed") {
      return NextResponse.json({
        status: "completed",
        progress: 100,
        estimated_seconds_remaining: 0,
        output_url: gen.output_url,
        error_message: null,
      })
    }
    if (gen.status === "failed") {
      return NextResponse.json({
        status: "failed",
        progress: 0,
        estimated_seconds_remaining: 0,
        output_url: null,
        error_message: "Generation failed",
      })
    }

    const { muapi_job_id } = gen.settings
    const estimatedSec = gen.settings.estimated_seconds ?? 90
    const elapsedSec = (Date.now() - new Date(gen.created_at).getTime()) / 1000
    const remaining = Math.max(0, estimatedSec - elapsedSec)

    if (!muapi_job_id) {
      return NextResponse.json({
        status: gen.status,
        progress: 0,
        estimated_seconds_remaining: Math.round(estimatedSec),
        output_url: null,
        error_message: null,
      })
    }

    const muapiKey = process.env.MUAPI_API_KEY
    if (!muapiKey) {
      return NextResponse.json({ error: "MUAPI API key is not configured" }, { status: 500 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let muapiData: any
    try {
      const muapiRes = await fetch(`${MUAPI_BASE}/video/status/${muapi_job_id}`, {
        headers: { Authorization: `Bearer ${muapiKey}` },
      })
      if (!muapiRes.ok) {
        return NextResponse.json({
          status: gen.status,
          progress: Math.round(Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)),
          estimated_seconds_remaining: Math.round(remaining),
          output_url: null,
          error_message: null,
        })
      }
      muapiData = await muapiRes.json()
    } catch (err) {
      console.error("[video-extend/status] muapi fetch error", err)
      return NextResponse.json({
        status: gen.status,
        progress: Math.round(Math.min(10, elapsedSec * 0.5)),
        estimated_seconds_remaining: Math.round(remaining),
        output_url: null,
        error_message: null,
      })
    }

    const rawStatus = muapiData.status ?? muapiData.state ?? "pending"
    const muapiStatus = parseMuapiStatus(rawStatus)

    if (muapiStatus === "completed") {
      const videoUrl: string | null =
        muapiData.video_url ?? muapiData.output_url ??
        (typeof muapiData.output === "string" ? muapiData.output : null) ??
        (muapiData.output?.url ?? null)

      if (videoUrl) {
        // Charge exactly once, on success (credits: compare-and-set deduction; QLC: settles the on-chain charge).
        await settleGenerationCharge({
          user: authUser, generationId: jobId, credits: gen.credits_used, description: `Video Extend: ${gen.prompt.slice(0, 50)}`, once: "generation-row",
        })
        await adminAny
          .from("generations")
          .update({ status: "completed", output_url: videoUrl })
          .eq("id", jobId)

        const elapsedMs = Date.now() - new Date(gen.created_at).getTime()
        if (elapsedMs > 30_000) {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
          fetch(`${appUrl}/api/email/generation-complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, generationId: jobId }),
          }).catch((e) => console.warn("[video-extend/status] email error", e))
        }

        return NextResponse.json({
          status: "completed",
          progress: 100,
          estimated_seconds_remaining: 0,
          output_url: videoUrl,
          error_message: null,
        })
      }

      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        estimated_seconds_remaining: 0,
        output_url: null,
        error_message: "Video URL missing from the MUAPI response",
      })
    }

    if (muapiStatus === "failed") {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        estimated_seconds_remaining: 0,
        output_url: null,
        error_message: muapiData.error ?? muapiData.message ?? "Video extend failed",
      })
    }

    const progress = muapiData.progress
      ? Math.min(85, muapiData.progress)
      : Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)

    if (gen.status !== muapiStatus) {
      await adminAny.from("generations").update({ status: muapiStatus }).eq("id", jobId)
    }

    return NextResponse.json({
      status: muapiStatus,
      progress: Math.round(progress),
      estimated_seconds_remaining: Math.round(remaining),
      output_url: null,
      error_message: null,
    })
  } catch (err) {
    console.error("[video-extend/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
