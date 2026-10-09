import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { parseMuapiStatus } from "@/lib/muapi"

fal.config({ credentials: process.env.FAL_KEY })

const MUAPI_BASE = "https://api.muapi.ai/v1"

interface GenerationSettings {
  fal_endpoint?: string | null
  fal_request_id?: string | null
  muapi_endpoint?: string
  muapi_job_id?: string | null
  estimated_seconds?: number
  face_url?: string
  audio_url?: string
  intensity?: number
}

// Extracts the generated video URL from a fal result. The documented fal shape is { video: File{url} }
// (all lip-sync models), but runtime shapes vary, so we support common variants + light nesting + a
// guarded deep fallback. `excludeUrls` (the input face/audio URLs) are never returned, so we can never
// echo the input as the output. Backward-compatible: existing { video: { url } } resolves on the first path.
function extractVideoUrl(data: unknown, excludeUrls: (string | undefined)[] = []): string | null {
  const excluded = new Set(excludeUrls.filter((u): u is string => !!u))
  const isUrl = (s: unknown): s is string =>
    typeof s === "string" && /^https?:\/\//.test(s) && !excluded.has(s)
  const fromFile = (v: unknown): string | null => {
    if (isUrl(v)) return v
    if (v && typeof v === "object") {
      const u = (v as Record<string, unknown>).url
      if (isUrl(u)) return u
    }
    return null
  }
  if (!data || typeof data !== "object") return isUrl(data) ? data : null
  const d = data as Record<string, unknown>

  const direct =
    fromFile(d.video) ??
    fromFile(d.video_url) ??
    fromFile(d.output_url) ??
    fromFile(d.url) ??
    (Array.isArray(d.videos) ? fromFile(d.videos[0]) : null) ??
    (d.output && typeof d.output === "object" ? extractVideoUrl(d.output, excludeUrls) : fromFile(d.output)) ??
    (d.result && typeof d.result === "object" ? extractVideoUrl(d.result, excludeUrls) : null)
  if (direct) return direct

  // Guarded deep fallback: collect every non-input http(s) URL in the result, prefer a video file.
  const urls: string[] = []
  const walk = (v: unknown) => {
    if (isUrl(v)) { urls.push(v); return }
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v && typeof v === "object") { Object.values(v as Record<string, unknown>).forEach(walk) }
  }
  walk(d)
  return urls.find((u) => /\.(mp4|mov|webm|m4v|m3u8)(\?|$)/i.test(u)) ?? urls[0] ?? null
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
        error_message: "Generation failed. Please try again.",
      })
    }

    const { fal_endpoint, fal_request_id, muapi_endpoint, muapi_job_id } = gen.settings
    const estimatedSec = gen.settings.estimated_seconds ?? 60
    const elapsedSec = (Date.now() - new Date(gen.created_at).getTime()) / 1000
    const remaining = Math.max(0, estimatedSec - elapsedSec)

    // ── MUAPI path (Infinite Talk) ──
    if (muapi_endpoint && muapi_job_id) {
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
      } catch (muapiErr) {
        console.error("[lip-sync/status] muapi fetch error", muapiErr)
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
          // Claim completion atomically (status compare-and-set) — only the winning concurrent poll
          // proceeds; others fall through and return the completed result without re-charging.
          const { data: claimed } = await adminAny
            .from("generations")
            .update({ status: "completed", output_url: videoUrl })
            .eq("id", jobId)
            .neq("status", "completed")
            .select("id")
            .single()

          if (claimed) {
            // Charge exactly once, on success (credits: generations.credits_deducted compare-and-set; QLC: settles the on-chain charge).
            await settleGenerationCharge({
              user: authUser, generationId: jobId, credits: gen.credits_used, description: `Infinite Talk: lip sync`, once: "generation-row",
            })

            const elapsedMs = Date.now() - new Date(gen.created_at).getTime()
            if (elapsedMs > 30_000) {
              const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
              fetch(`${appUrl}/api/email/generation-complete`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId, generationId: jobId }),
              }).catch((e) => console.warn("[lip-sync/status] email error", e))
            }
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
          error_message: "Generated video URL was not available in the provider response.",
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
          error_message: muapiData.error ?? muapiData.message ?? "The provider could not generate this lip-sync. Please try again.",
        })
      }

      const muapiProgress = muapiData.progress
        ? Math.min(85, muapiData.progress)
        : Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)

      if (gen.status !== muapiStatus) {
        await adminAny.from("generations").update({ status: muapiStatus }).eq("id", jobId)
      }
      return NextResponse.json({
        status: muapiStatus,
        progress: Math.round(muapiProgress),
        estimated_seconds_remaining: Math.round(remaining),
        output_url: null,
        error_message: null,
      })
    }

    if (!fal_endpoint || !fal_request_id) {
      return NextResponse.json({
        status: gen.status,
        progress: 0,
        estimated_seconds_remaining: Math.round(estimatedSec),
        output_url: null,
        error_message: null,
      })
    }

    let falStatus: { status: string }
    try {
      falStatus = await fal.queue.status(fal_endpoint, {
        requestId: fal_request_id,
        logs: false,
      })
    } catch (falErr) {
      console.error("[lip-sync/status] fal status error", falErr)
      return NextResponse.json({
        status: gen.status,
        progress: Math.round(Math.min(10, elapsedSec * 0.5)),
        estimated_seconds_remaining: Math.round(remaining),
        output_url: null,
        error_message: null,
      })
    }

    const falStatusStr = falStatus.status as string

    if (falStatusStr === "COMPLETED") {
      let videoUrl: string | null = null

      try {
        const result = await fal.queue.result(fal_endpoint, { requestId: fal_request_id })
        const data = (result.data ?? {}) as Record<string, unknown>
        videoUrl = extractVideoUrl(data, [gen.settings.face_url, gen.settings.audio_url])
        if (!videoUrl) {
          console.error("[lip-sync/status] no video url in fal result", fal_endpoint, JSON.stringify(data).slice(0, 1200))
        }
      } catch (resultErr) {
        console.error("[lip-sync/status] fal result error", resultErr)
      }

      if (videoUrl) {
        // Claim completion atomically (status compare-and-set) — only the winning concurrent poll
        // proceeds; others fall through and return the completed result without re-charging.
        const { data: claimed } = await adminAny
          .from("generations")
          .update({ status: "completed", output_url: videoUrl })
          .eq("id", jobId)
          .neq("status", "completed")
          .select("id")
          .single()

        if (claimed) {
          // Charge exactly once, on success (credits: generations.credits_deducted compare-and-set; QLC: settles the on-chain charge).
          await settleGenerationCharge({
            user: authUser, generationId: jobId, credits: gen.credits_used, description: `Lip sync: ${gen.prompt.slice(0, 50)}`, once: "generation-row",
          })

          const elapsedMs = Date.now() - new Date(gen.created_at).getTime()
          if (elapsedMs > 30_000) {
            const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
            fetch(`${appUrl}/api/email/generation-complete`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId, generationId: jobId }),
            }).catch((e) => console.warn("[lip-sync/status] email error", e))
          }
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
        error_message: "Generated video URL was not available in the provider response.",
      })
    }

    if (falStatusStr === "FAILED" || falStatusStr === "CANCELLED") {
      console.error("[lip-sync/status] fal job failed", fal_endpoint, fal_request_id, falStatusStr)
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        estimated_seconds_remaining: 0,
        output_url: null,
        error_message: "The model could not generate this lip-sync. Make sure the video clearly shows a face and meets the model's length/resolution limits, then try again.",
      })
    }

    const newStatus = falStatusStr === "IN_PROGRESS" ? "processing" : "pending"
    if (gen.status !== newStatus) {
      await adminAny.from("generations").update({ status: newStatus }).eq("id", jobId)
    }

    const progress =
      falStatusStr === "IN_PROGRESS"
        ? Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)
        : Math.min(15, elapsedSec * 0.5)

    return NextResponse.json({
      status: newStatus,
      progress: Math.round(progress),
      estimated_seconds_remaining: Math.round(remaining),
      output_url: null,
      error_message: null,
    })
  } catch (err) {
    console.error("[lip-sync/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
