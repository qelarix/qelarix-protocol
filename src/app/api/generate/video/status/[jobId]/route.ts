import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

fal.config({ credentials: process.env.FAL_KEY })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

interface GenerationSettings {
  fal_endpoint?: string
  fal_request_id?: string | null
  fal_response_url?: string | null
  muapi_model?: string
  muapi_job_id?: string | null
  duration?: number
  with_audio?: boolean
  estimated_seconds?: number
}

interface MuapiStatusResponse {
  status?: string
  state?: string
  video_url?: string
  output?: { url?: string } | string
  progress?: number
  error?: string
  message?: string
}

// Extract the video URL from a fal.ai result. The shape varies per model/endpoint — Veo 3.1 Standard/Fast wrap it
// differently (e.g. output.url / output.videos[] / result.*) than Veo 3.1 FLF & the rest. Ordered most-specific first;
// every previously-supported shape is kept FIRST so existing models (FLF/Luma/Seedance/Kling/Sora/Wan/Grok) are unaffected.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractVideoUrl(r: any): string | null {
  if (!r || typeof r !== "object") return null
  const direct =
    // existing shapes (unchanged order) ───────────────────────────────
    r?.video?.url ||
    r?.video_url ||
    r?.videos?.[0]?.url ||
    r?.output?.video_url ||
    r?.output?.video?.url ||
    r?.data?.video?.url ||
    r?.data?.video_url ||
    r?.data?.videos?.[0]?.url ||
    r?.url ||
    // added shapes (Veo 3.1 Standard/Fast + other fal wrappers) ────────
    r?.output?.url ||
    r?.output?.videos?.[0]?.url ||
    r?.data?.url ||
    r?.result?.video?.url ||
    r?.result?.video_url ||
    r?.result?.videos?.[0]?.url ||
    r?.result?.url ||
    null
  if (typeof direct === "string" && direct) return direct
  // Last-resort safety net: depth-limited walk for the FIRST http(s) URL that looks like a video file. Conservative —
  // only accepts .mp4/.webm/.mov/.m4v (optionally with query/hash) so it can never grab a thumbnail/poster/image URL.
  return findVideoUrlDeep(r, 0)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findVideoUrlDeep(node: any, depth: number): string | null {
  if (node == null || depth > 4) return null
  if (typeof node === "string") {
    return /^https?:\/\/\S+\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(node) ? node : null
  }
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findVideoUrlDeep(v, depth + 1); if (hit) return hit }
    return null
  }
  if (typeof node === "object") {
    for (const k of Object.keys(node)) { const hit = findVideoUrlDeep((node as Record<string, unknown>)[k], depth + 1); if (hit) return hit }
    return null
  }
  return null
}

// SAFE diagnostic: summarize a fal response by KEY NAMES only (top level + one nested level for the usual wrappers).
// Never logs values → no signed URLs / tokens / secrets leaked. Used only when extraction fails.
function summarizeShape(r: unknown): string {
  try {
    if (!r || typeof r !== "object") return `(non-object: ${typeof r})`
    const obj = r as Record<string, unknown>
    const top = Object.keys(obj).slice(0, 20)
    const nested: Record<string, string[]> = {}
    for (const k of ["output", "data", "result", "video"]) {
      const v = obj[k]
      if (v && typeof v === "object" && !Array.isArray(v)) nested[k] = Object.keys(v as object).slice(0, 12)
    }
    return JSON.stringify({ topLevelKeys: top, nestedKeys: nested })
  } catch { return "(unsummarizable)" }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  try {
    // ── Auth ──
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

    // ── Fetch generation ──
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

    // ── Already terminal ──
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any
    const { fal_endpoint, fal_request_id, fal_response_url, muapi_model, muapi_job_id } = gen.settings
    const estimatedSec = gen.settings.estimated_seconds ?? 90
    const elapsedSec = (Date.now() - new Date(gen.created_at).getTime()) / 1000
    const remaining = Math.max(0, estimatedSec - elapsedSec)

    // ── MUAPI path (Happy Horse 1.0) ──
    if (muapi_model && muapi_job_id) {
      const muapiKey = process.env.MUAPI_API_KEY
      if (!muapiKey) {
        return NextResponse.json({ error: "MUAPI API key is not configured" }, { status: 500 })
      }

      let muapiData: MuapiStatusResponse
      try {
        const muapiRes = await fetch(`${MUAPI_BASE}/video/status/${muapi_job_id}`, {
          headers: { "Authorization": `Bearer ${muapiKey}` },
        })
        if (!muapiRes.ok) {
          console.error("[status] muapi status error", muapiRes.status)
          return NextResponse.json({
            status: gen.status,
            progress: Math.round(Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)),
            estimated_seconds_remaining: Math.round(remaining),
            output_url: null,
            error_message: null,
          })
        }
        muapiData = (await muapiRes.json()) as MuapiStatusResponse
      } catch (muapiErr) {
        console.error("[status] muapi fetch error", muapiErr)
        return NextResponse.json({
          status: gen.status,
          progress: Math.round(Math.min(15, elapsedSec * 0.5)),
          estimated_seconds_remaining: Math.round(remaining),
          output_url: null,
          error_message: null,
        })
      }

      const muapiStatus = (muapiData.status ?? muapiData.state ?? "").toLowerCase()

      if (muapiStatus === "completed" || muapiStatus === "success" || muapiStatus === "done") {
        // Extract video URL from MUAPI response
        let videoUrl: string | null = null
        if (typeof muapiData.video_url === "string") videoUrl = muapiData.video_url
        else if (typeof muapiData.output === "string") videoUrl = muapiData.output
        else if (typeof muapiData.output === "object" && muapiData.output !== null) {
          videoUrl = (muapiData.output as { url?: string }).url ?? null
        }

        if (videoUrl) {
          const permanentUrl = await uploadToStorage(videoUrl, userId, 'video', jobId, adminAny)

          const { data: muapiUpdated, error: muapiUpdateError } = await adminAny
            .from("generations")
            .update({ status: "completed", output_url: permanentUrl })
            .eq("id", jobId)
            .neq("status", "completed")
            .select()
            .single()

          if (!muapiUpdated || muapiUpdateError) {
            return NextResponse.json({ status: "completed", progress: 100, output_url: permanentUrl })
          }

          // Charge exactly once, on success (credits: generations.credits_deducted compare-and-set; QLC: settles the on-chain charge).
          await settleGenerationCharge({
            user: authUser, generationId: jobId, credits: gen.credits_used, description: `Video generacija: ${gen.prompt.slice(0, 50)}`, once: "generation-row",
          })

          const elapsedMs = Date.now() - new Date(gen.created_at).getTime()
          if (elapsedMs > 30_000) {
            const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
            fetch(`${appUrl}/api/email/generation-complete`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId, generationId: jobId }),
            }).catch((e) => console.warn("[status] muapi email send error", e))
          }

          return NextResponse.json({
            status: "completed",
            progress: 100,
            estimated_seconds_remaining: 0,
            output_url: permanentUrl,
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

      if (muapiStatus === "failed" || muapiStatus === "error" || muapiStatus === "cancelled") {
        await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
        await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
        return NextResponse.json({
          status: "failed",
          progress: 0,
          estimated_seconds_remaining: 0,
          output_url: null,
          error_message: muapiData.error ?? muapiData.message ?? "MUAPI generation failed",
        })
      }

      // pending / processing
      const muapiProgress = muapiData.progress
        ? Math.min(85, muapiData.progress)
        : Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)
      const newStatus = muapiStatus === "processing" || muapiStatus === "generating" ? "processing" : "pending"
      if (gen.status !== newStatus) {
        await adminAny.from("generations").update({ status: newStatus }).eq("id", jobId)
      }
      return NextResponse.json({
        status: newStatus,
        progress: Math.round(muapiProgress),
        estimated_seconds_remaining: Math.round(remaining),
        output_url: null,
        error_message: null,
      })
    }

    // ── Check fal.ai queue ──
    if (!fal_endpoint || !fal_request_id) {
      return NextResponse.json({
        status: gen.status,
        progress: 0,
        estimated_seconds_remaining: 60,
        output_url: null,
        error_message: null,
      })
    }

    let falStatus: { status: string; logs?: unknown[]; response_url?: string }
    try {
      falStatus = await fal.queue.status(fal_endpoint, {
        requestId: fal_request_id,
        logs: false,
      }) as { status: string; logs?: unknown[]; response_url?: string }
    } catch (falErr) {
      console.error("[status] fal.ai status check error", falErr)
      return NextResponse.json({
        status: gen.status,
        progress: 5,
        estimated_seconds_remaining: 60,
        output_url: null,
        error_message: null,
      })
    }

    const falStatusStr = falStatus.status as string

    // ── COMPLETED ──
    if (falStatusStr === "COMPLETED") {
      let videoUrl: string | null = null
      let falResultData: Record<string, unknown> = {}
      let rawResult: unknown = null // freshest raw provider result (captured for diagnostics even when extraction fails)

      // Method 1: response_url from status object (fal.ai provides this when completed)
      const responseUrl = (falStatus as Record<string, unknown>).response_url as string | undefined

      // Method 2: Direct URL using full endpoint path (fixes result() path-stripping bug)
      const directUrl = `https://queue.fal.run/${fal_endpoint}/requests/${fal_request_id}`

      // Prefer fal's OWN canonical result URL persisted at submit time (response_url): it needs no endpoint-path
      // reconstruction, so it sidesteps the queue.result() 422 / path-stripping issue that breaks Veo 3.1 Standard/Fast
      // (whose sub-path endpoints mis-resolve). Falls back to the status response_url, then the constructed directUrl.
      const urlsToTry = [fal_response_url, responseUrl, directUrl].filter((u): u is string => !!u)

      for (const url of urlsToTry) {
        if (videoUrl) break
        try {
          // Try without auth first (response_url may be pre-signed), then with auth
          for (const headers of [undefined, { Authorization: `Key ${process.env.FAL_KEY}` }] as const) {
            if (videoUrl) break
            try {
              const resp = await fetch(url, { headers })
              if (resp.ok) {
                const json = (await resp.json()) as Record<string, unknown>
                rawResult = json
                videoUrl = extractVideoUrl(json)
                if (videoUrl) falResultData = json
              }
            } catch { /* try next */ }
          }
        } catch { /* try next url */ }
      }

      // Method 3: fal.queue.result() — final fallback
      if (!videoUrl) {
        try {
          const result = await fal.queue.result(fal_endpoint, { requestId: fal_request_id })
          falResultData = (result?.data ?? {}) as Record<string, unknown>
          rawResult = result // capture the FULL wrapper (data + any root-level url) for diagnosis + extraction
          // Try the unwrapped data first (normal path), then the full wrapper in case the URL sits at the result root.
          videoUrl = extractVideoUrl(falResultData) || extractVideoUrl(result)
        } catch (resultErr) {
          // Safe detailed error log: endpoint + (truncated) requestId + method + HTTP status + capped body.detail.
          // No secrets/headers/API keys — only the provider's validation detail, capped at 1000 chars.
          const e = resultErr as { status?: number; body?: { detail?: unknown }; message?: string }
          const detail = e?.body?.detail ?? e?.body ?? e?.message
          console.error("[status] fal.queue.result() failed:", JSON.stringify({
            endpoint: fal_endpoint,
            requestId: typeof fal_request_id === "string" ? fal_request_id.slice(0, 16) : fal_request_id,
            method: "fal.queue.result",
            status: e?.status,
            detail: JSON.stringify(detail).slice(0, 1000),
          }))
        }
      }

      if (videoUrl) {
        const permanentUrl = await uploadToStorage(videoUrl, userId, 'video', jobId, adminAny)

        const { data: falUpdated, error: falUpdateError } = await adminAny
          .from("generations")
          .update({ status: "completed", output_url: permanentUrl })
          .eq("id", jobId)
          .neq("status", "completed")
          .select()
          .single()

        if (!falUpdated || falUpdateError) {
          return NextResponse.json({ status: "completed", progress: 100, output_url: permanentUrl })
        }

        // Charge exactly once, on success (credits: generations.credits_deducted compare-and-set; QLC: settles the on-chain charge).
        await settleGenerationCharge({
          user: authUser, generationId: jobId, credits: gen.credits_used, description: `Video generacija: ${gen.prompt.slice(0, 50)}`, once: "generation-row",
        })

        // Send email if processing took > 30 seconds
        const elapsedMs = Date.now() - new Date(gen.created_at).getTime()
        if (elapsedMs > 30_000) {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
          fetch(`${appUrl}/api/email/generation-complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, generationId: jobId }),
          }).catch((e) => console.warn("[status] email send error", e))
        }

        return NextResponse.json({
          status: "completed",
          progress: 100,
          estimated_seconds_remaining: 0,
          output_url: permanentUrl,
          error_message: null,
        })
      }

      // Completed but no URL — log a concise safe shape summary (key names only — no values/URLs/secrets).
      console.error(`[status] completed but no video URL for ${jobId} (endpoint=${fal_endpoint}). Shape:`, summarizeShape(rawResult ?? falResultData))
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        estimated_seconds_remaining: 0,
        output_url: null,
        error_message: "Video URL missing from the response",
      })
    }

    // ── FAILED ──
    if (falStatusStr === "FAILED" || falStatusStr === "CANCELLED") {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        estimated_seconds_remaining: 0,
        output_url: null,
        error_message: "fal.ai generation failed",
      })
    }

    // ── IN_PROGRESS or IN_QUEUE ──
    const newStatus = falStatusStr === "IN_PROGRESS" ? "processing" : "pending"
    if (gen.status !== newStatus) {
      await adminAny.from("generations").update({ status: newStatus }).eq("id", jobId)
    }

    const falProgress = falStatusStr === "IN_PROGRESS"
      ? Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)
      : Math.min(15, elapsedSec * 0.5)

    return NextResponse.json({
      status: newStatus,
      progress: Math.round(falProgress),
      estimated_seconds_remaining: Math.round(remaining),
      output_url: null,
      error_message: null,
    })
  } catch (err) {
    console.error("[generate/video/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
