import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

// Polls the MuAPI prediction result for ai-product-photography and maps it to completed/failed/processing.
// IMPORTANT (verified live 2026-06-27): this tool nests the prediction under `detail`, and a FAILED job
// returns a non-2xx (HTTP 400) body like {"detail":{"status":"failed","error":"…"}}. The shared
// getMuapiPredictionResult treats every non-2xx as "processing", which made the UI hang at 85% forever.
// So this route parses the result endpoint directly and robustly. On completion: charges ONCE
// (settleGenerationCharge) and persists output_url. No new Supabase schema.

const MUAPI_BASE = "https://api.muapi.ai/api/v1"

interface Settings {
  muapi_request_id?: string | null
  image_url?: string
  scene_description?: string
  estimated_seconds?: number
}

// Pull the first http(s) RESULT image URL from a prediction/output node.
// IMPORTANT: ai-product-shot returns the result in `outputs[]`; `urls.get` is the polling endpoint
// (NOT the image) and `inputs.*` echoes the source image — so we ONLY read the real output fields,
// never urls.get or inputs, to avoid "completing" with a non-image URL during processing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractResultUrl(node: any): string | null {
  if (!node || typeof node !== "object") return null
  const candidates: Array<unknown> = [
    Array.isArray(node.outputs) ? node.outputs[0] : undefined,
    node.output_url, node.result_url,
    Array.isArray(node.images) ? node.images[0] : undefined,
  ]
  for (const c of candidates) if (typeof c === "string" && c.startsWith("http")) return c
  return null
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
      return NextResponse.json({ error: "jobId is required" }, { status: 400 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const { data: generation, error } = await admin
      .from("generations")
      .select("id, status, output_url, credits_used, settings, created_at")
      .eq("id", jobId)
      .eq("user_id", userId)
      .single()

    if (error || !generation) {
      return NextResponse.json({ error: "Generation not found" }, { status: 404 })
    }

    const gen = generation as {
      id: string
      status: string
      output_url: string | null
      credits_used: number
      settings: Settings
      created_at: string
    }

    if (gen.status === "completed") {
      return NextResponse.json({ status: "completed", progress: 100, output_url: gen.output_url, error_message: null })
    }
    if (gen.status === "failed") {
      return NextResponse.json({ status: "failed", progress: 0, output_url: null, error_message: "Generation failed" })
    }

    const requestId = gen.settings?.muapi_request_id
    const estimatedSec = gen.settings?.estimated_seconds ?? 40
    const elapsed = (Date.now() - new Date(gen.created_at).getTime()) / 1000
    const progress = Math.round(Math.min(85, (elapsed / estimatedSec) * 80 + 5))

    if (!requestId) {
      return NextResponse.json({ status: gen.status, progress: 0, output_url: null, error_message: null })
    }
    if (!process.env.MUAPI_API_KEY) {
      return NextResponse.json({ error: "MUAPI_API_KEY is missing on server" }, { status: 500 })
    }

    // Fetch + parse the prediction result robustly (handles the `detail` wrapper + failed-on-400).
    let mappedStatus: "completed" | "failed" | "processing" = "processing"
    let outputUrl: string | null = null
    let errorMessage: string | null = null
    try {
      const res = await fetch(`${MUAPI_BASE}/predictions/${requestId}/result`, {
        headers: { "x-api-key": process.env.MUAPI_API_KEY as string },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (await res.json().catch(() => null)) as any
      // The prediction object is under `detail` (an object) for this tool; sometimes it's the body itself.
      const pred = raw && typeof raw.detail === "object" && raw.detail ? raw.detail : raw
      const out = pred && typeof pred.output === "object" && pred.output ? pred.output : pred
      const st = String((pred && (pred.status ?? pred.state)) ?? (out && out.status) ?? "").toLowerCase()
      const url = extractResultUrl(out) || extractResultUrl(pred)

      if (st === "failed" || st === "error" || st === "canceled" || st === "cancelled") {
        mappedStatus = "failed"
        errorMessage = (pred && (pred.error || (out && out.error))) || "Product photo generation failed"
        // Log the FULL provider failure body (no secrets — just id/status/error) so the exact reason is
        // diagnosable in server logs, not reduced to the summarized message. (e.g. "Unexpected status code: 422").
        console.error("[apps/product-photos/status] provider failure", JSON.stringify(raw))
      } else if (url) {
        // A URL is only present once the job is genuinely complete.
        mappedStatus = "completed"
        outputUrl = url
      } else {
        mappedStatus = "processing"
      }
    } catch (err) {
      console.error("[apps/product-photos/status] muapi error", err)
      return NextResponse.json({ status: gen.status, progress, output_url: null, error_message: null })
    }

    if (mappedStatus === "completed" && outputUrl) {
      // Charge exactly once, on success (credits: compare-and-set deduction; QLC: settles the on-chain charge).
      await settleGenerationCharge({
        user: authUser, generationId: jobId, credits: gen.credits_used, description: "Product Photos", once: "generation-row",
      })
      await adminAny
        .from("generations")
        .update({ status: "completed", output_url: outputUrl })
        .eq("id", jobId)
      return NextResponse.json({ status: "completed", progress: 100, output_url: outputUrl, error_message: null })
    }

    if (mappedStatus === "failed") {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        output_url: null,
        error_message: errorMessage ?? "Product photo generation failed",
      })
    }

    if (gen.status !== "processing") {
      await adminAny.from("generations").update({ status: "processing" }).eq("id", jobId)
    }
    return NextResponse.json({ status: "processing", progress, output_url: null, error_message: null })
  } catch (err) {
    console.error("[apps/product-photos/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
