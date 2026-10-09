import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

// ── Video Tools v1 status route (Upscale / PixVerse Extend) ─────────────────────────────────────
// Mirrors the main video status route's safety pattern: poll the fal queue, persist the output to
// OUR storage bucket (no provider-URL rot in history), then deduct credits ONLY on success behind a
// credits_deducted compare-and-set (never double-deduct, never deduct before success).

fal.config({ credentials: process.env.FAL_KEY })

// Same persistence helper pattern as src/app/api/generate/video/status/[jobId]/route.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function uploadToStorage(tempUrl: string, userId: string, generationId: string, adminClient: any): Promise<string> {
  try {
    const path = `${userId}/${generationId}.mp4`
    const response = await fetch(tempUrl)
    if (!response.ok) return tempUrl
    const buffer = await response.arrayBuffer()
    const { error } = await adminClient.storage.from("generations").upload(path, buffer, { contentType: "video/mp4", upsert: true })
    if (error) { console.error("[video-tools storage]", error); return tempUrl }
    const { data } = adminClient.storage.from("generations").getPublicUrl(path)
    return data.publicUrl || tempUrl
  } catch (err) {
    console.error("[video-tools storage error]", err)
    return tempUrl
  }
}

// Same multi-shape extractor as the main video status route (fal result shapes vary per endpoint).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractVideoUrl(r: any): string | null {
  if (!r || typeof r !== "object") return null
  const direct =
    r?.video?.url ||
    r?.video_url ||
    r?.videos?.[0]?.url ||
    r?.output?.video_url ||
    r?.output?.video?.url ||
    r?.data?.video?.url ||
    r?.data?.video_url ||
    r?.data?.videos?.[0]?.url ||
    r?.url ||
    r?.output?.url ||
    r?.output?.videos?.[0]?.url ||
    r?.data?.url ||
    r?.result?.video?.url ||
    r?.result?.video_url ||
    r?.result?.videos?.[0]?.url ||
    r?.result?.url ||
    null
  if (typeof direct === "string" && direct) return direct
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

interface ToolSettings {
  tool?: string
  fal_endpoint?: string
  fal_request_id?: string | null
}

// fal validation errors carry body.detail as a plain string OR an array of { msg, loc, type } items.
// Reduce either shape to a short human-readable message (capped; no secrets — provider text only).
function formatProviderDetail(detail: unknown): string | null {
  if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 300)
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === "object" && typeof (d as { msg?: unknown }).msg === "string" ? (d as { msg: string }).msg : null))
      .filter((m): m is string => !!m)
    if (msgs.length) return msgs.join(" · ").slice(0, 300)
  }
  if (detail && typeof detail === "object") {
    const msg = (detail as { msg?: unknown; message?: unknown }).msg ?? (detail as { message?: unknown }).message
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 300)
  }
  return null
}

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
    const jobId = params.jobId
    if (!jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const { data: gen, error: genError } = await adminAny
      .from("generations")
      .select("id, user_id, status, output_url, credits_used, settings, prompt, created_at")
      .eq("id", jobId)
      .eq("user_id", userId)
      .single()

    if (genError || !gen) {
      return NextResponse.json({ error: "Generation not found." }, { status: 404 })
    }

    // Terminal states — return as stored (idempotent polling). A persisted provider error message wins.
    if (gen.status === "completed") {
      return NextResponse.json({ status: "completed", progress: 100, output_url: gen.output_url })
    }
    if (gen.status === "failed") {
      const persisted = (gen.settings as Record<string, unknown> | null)?.error_message
      return NextResponse.json({
        status: "failed", progress: 0, output_url: null,
        error_message: typeof persisted === "string" && persisted ? persisted : "Generation failed.",
      })
    }

    const settings = (gen.settings ?? {}) as ToolSettings
    const falEndpoint = settings.fal_endpoint
    const falRequestId = settings.fal_request_id
    if (!falEndpoint || !falRequestId) {
      // Submitted row without a provider job — treat as failed (submit route marks these, but be safe).
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", progress: 0, output_url: null, error_message: "Provider job reference missing." })
    }

    // ── Poll the fal queue ──
    let queueStatus = ""
    try {
      const s = await fal.queue.status(falEndpoint, { requestId: falRequestId, logs: false })
      queueStatus = ((s as { status?: string })?.status ?? "").toUpperCase()
    } catch (statusErr) {
      const e = statusErr as { status?: number; message?: string }
      // 4xx from the queue status = the job is unknown/expired → fail truthfully; transient errors keep polling.
      if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) {
        console.error("[video-tools status] queue status 4xx:", e.status, e.message)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
        await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
        return NextResponse.json({ status: "failed", progress: 0, output_url: null, error_message: "Provider job not found." })
      }
      // Transient status error — keep processing with non-regressing, elapsed-based progress.
      const transientElapsed = Math.max(0, (Date.now() - new Date(gen.created_at).getTime()) / 1000)
      return NextResponse.json({
        status: "processing",
        progress: Math.min(90, 30 + Math.round((transientElapsed / 180) * 60)),
        output_url: null,
      })
    }

    // Elapsed-based progress so long jobs visibly move instead of freezing at one number:
    // queue 10→25%, in-progress ramps 30→90% over ~3 minutes, completed = 100%. fal's queue API
    // exposes no native percentage, so time is the honest proxy (capped at 90 until truly done).
    const elapsedSec = Math.max(0, (Date.now() - new Date(gen.created_at).getTime()) / 1000)
    const queueProgress = Math.min(25, 10 + Math.round(elapsedSec / 10))
    const runProgress = Math.min(90, 30 + Math.round((elapsedSec / 180) * 60))

    if (queueStatus === "IN_QUEUE") {
      return NextResponse.json({ status: "pending", progress: queueProgress, output_url: null })
    }
    if (queueStatus === "IN_PROGRESS") {
      return NextResponse.json({ status: "processing", progress: runProgress, output_url: null })
    }
    if (queueStatus === "FAILED" || queueStatus === "CANCELLED" || queueStatus === "ERROR") {
      // Terminal provider failure — persist the reason, never deduct.
      const errorMessage = `The provider reported ${queueStatus.toLowerCase()}.`
      await adminAny
        .from("generations")
        .update({ status: "failed", settings: { ...(gen.settings ?? {}), error_message: errorMessage } })
        .eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", progress: 0, output_url: null, error_message: errorMessage })
    }
    if (queueStatus !== "COMPLETED") {
      // UNKNOWN provider state — do NOT fail the job (it may still finish); log and keep it processing.
      console.error("[video-tools status] unknown queue state (treated as processing):", queueStatus)
      return NextResponse.json({ status: "processing", progress: runProgress, output_url: null })
    }

    // ── COMPLETED → fetch result, persist, deduct (success-only, CAS-guarded) ──
    // NOTE: fal reports provider VALIDATION failures (e.g. the Bytedance 1080p input-size rule) only
    // when the RESULT is fetched — the queue status still says COMPLETED. So the real, user-relevant
    // error detail must be extracted HERE and surfaced/persisted, not collapsed into "no video URL".
    let videoUrl: string | null = null
    let providerError: string | null = null
    try {
      const result = await fal.queue.result(falEndpoint, { requestId: falRequestId })
      const data = (result as { data?: unknown })?.data ?? {}
      videoUrl = extractVideoUrl(data) || extractVideoUrl(result)
    } catch (resultErr) {
      const e = resultErr as { status?: number; body?: { detail?: unknown }; message?: string }
      providerError = formatProviderDetail(e?.body?.detail) ?? (typeof e?.message === "string" ? e.message : null)
      console.error("[video-tools status] fal.queue.result failed:", JSON.stringify({
        endpoint: falEndpoint,
        status: e?.status,
        detail: JSON.stringify(e?.body?.detail ?? e?.body ?? e?.message).slice(0, 800),
      }))
    }

    if (!videoUrl) {
      const errorMessage = providerError || "The provider returned no video URL."
      // Persist the real reason on the row so later polls (terminal branch) return it too.
      await adminAny
        .from("generations")
        .update({ status: "failed", settings: { ...(gen.settings ?? {}), error_message: errorMessage } })
        .eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", progress: 0, output_url: null, error_message: errorMessage })
    }

    // Persist to OUR storage so the output (and history) never depends on a provider-hosted URL.
    const permanentUrl = await uploadToStorage(videoUrl, userId, jobId, adminAny)

    const { data: updated, error: updateError } = await adminAny
      .from("generations")
      .update({ status: "completed", output_url: permanentUrl })
      .eq("id", jobId)
      .neq("status", "completed")
      .select()
      .single()

    if (!updated || updateError) {
      // Another poll already completed it — never deduct twice.
      return NextResponse.json({ status: "completed", progress: 100, output_url: permanentUrl })
    }

    // Charge exactly once, on success (credits: generations.credits_deducted compare-and-set; QLC: settles the on-chain charge).
    await settleGenerationCharge({
      user: authUser, generationId: jobId, credits: gen.credits_used, description: `Video tools: ${String(gen.prompt ?? "").slice(0, 50)}`, once: "generation-row",
    })

    return NextResponse.json({ status: "completed", progress: 100, output_url: permanentUrl, error_message: null })
  } catch (err) {
    console.error("[video-tools status] unexpected error", err)
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 })
  }
}
