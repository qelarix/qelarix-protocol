import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

fal.config({ credentials: process.env.FAL_KEY })

// Upload a temp provider URL into the permanent `generations` bucket as mp3 (audio/mpeg). Mirrors the audio route's
// uploader; falls back to the temp URL on any error so a transient storage failure never loses a completed result.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function uploadAudioToStorage(tempUrl: string, userId: string, generationId: string, adminClient: any): Promise<string> {
  try {
    const path = `${userId}/${generationId}.mp3`
    const response = await fetch(tempUrl)
    if (!response.ok) return tempUrl
    const buffer = await response.arrayBuffer()
    const { error } = await adminClient.storage.from("generations").upload(path, buffer, { contentType: "audio/mpeg", upsert: true })
    if (error) { console.error("[audio/status storage upload]", error); return tempUrl }
    const { data } = adminClient.storage.from("generations").getPublicUrl(path)
    return data.publicUrl || tempUrl
  } catch (err) {
    console.error("[audio/status storage upload error]", err)
    return tempUrl
  }
}

// fal audio result shapes vary by model — extract the audio URL defensively (mirrors the audio route's extractor).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAudioUrl(r: any): string | null {
  if (!r || typeof r !== "object") return null
  const d = r.data ?? r
  const direct =
    d?.audio?.url ||
    d?.audio_url ||
    d?.audio_file?.url ||
    d?.url ||
    (Array.isArray(d?.audios) ? d.audios[0]?.url : null) ||
    (Array.isArray(d?.outputs) ? d.outputs[0]?.url : null) ||
    null
  if (typeof direct === "string" && direct) return direct
  return findAudioUrlDeep(r, 0)
}

// Conservative depth-limited fallback: first http(s) URL ending in a known audio extension. Never matches images/video.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findAudioUrlDeep(node: any, depth: number): string | null {
  if (node == null || depth > 4) return null
  if (typeof node === "string") return /^https?:\/\/\S+\.(mp3|wav|m4a|ogg|flac)(\?|#|$)/i.test(node) ? node : null
  if (Array.isArray(node)) { for (const v of node) { const h = findAudioUrlDeep(v, depth + 1); if (h) return h } return null }
  if (typeof node === "object") { for (const k of Object.keys(node)) { const h = findAudioUrlDeep((node as Record<string, unknown>)[k], depth + 1); if (h) return h } return null }
  return null
}

interface AudioGenSettings {
  fal_endpoint?: string
  fal_request_id?: string | null
  fal_response_url?: string | null
  estimated_seconds?: number
}

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const userId = authUser.id
    const { jobId } = params
    if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 })

    const admin = createSupabaseAdmin()

    const { data: generation, error: fetchError } = await admin
      .from("generations")
      .select("id, status, output_url, credits_used, settings, created_at, prompt, model")
      .eq("id", jobId)
      .eq("user_id", userId)
      .single()

    if (fetchError || !generation) return NextResponse.json({ error: "Generation not found" }, { status: 404 })

    const gen = generation as {
      id: string
      status: string
      output_url: string | null
      credits_used: number
      settings: AudioGenSettings
      created_at: string
      prompt: string
      model: string
    }

    // ── Already terminal ──
    if (gen.status === "completed") {
      return NextResponse.json({ status: "completed", progress: 100, estimated_seconds_remaining: 0, output_url: gen.output_url, error_message: null })
    }
    if (gen.status === "failed") {
      return NextResponse.json({ status: "failed", progress: 0, estimated_seconds_remaining: 0, output_url: null, error_message: "Generation failed" })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any
    const { fal_endpoint, fal_request_id, fal_response_url } = gen.settings
    const estimatedSec = gen.settings.estimated_seconds ?? 60
    const elapsedSec = (Date.now() - new Date(gen.created_at).getTime()) / 1000
    const remaining = Math.max(0, estimatedSec - elapsedSec)

    if (!fal_endpoint || !fal_request_id) {
      return NextResponse.json({ status: gen.status, progress: 0, estimated_seconds_remaining: 60, output_url: null, error_message: null })
    }

    // ── Poll fal queue ──
    let falStatus: { status: string; response_url?: string }
    try {
      falStatus = await fal.queue.status(fal_endpoint, { requestId: fal_request_id, logs: false }) as { status: string; response_url?: string }
    } catch (falErr) {
      console.error("[audio/status] fal status error", falErr)
      return NextResponse.json({ status: gen.status, progress: 5, estimated_seconds_remaining: 60, output_url: null, error_message: null })
    }

    const st = falStatus.status

    // ── COMPLETED ──
    if (st === "COMPLETED") {
      let audioUrl: string | null = null
      const responseUrl = (falStatus as Record<string, unknown>).response_url as string | undefined
      const directUrl = `https://queue.fal.run/${fal_endpoint}/requests/${fal_request_id}`
      // Prefer the response_url persisted at submit (pre-signed, no path reconstruction), then the status response_url,
      // then the constructed direct URL, then fal.queue.result() as a final fallback.
      const urlsToTry = [fal_response_url, responseUrl, directUrl].filter((u): u is string => !!u)
      for (const url of urlsToTry) {
        if (audioUrl) break
        for (const headers of [undefined, { Authorization: `Key ${process.env.FAL_KEY}` }] as const) {
          if (audioUrl) break
          try {
            const resp = await fetch(url, { headers })
            if (resp.ok) { const json = (await resp.json()) as Record<string, unknown>; audioUrl = extractAudioUrl(json) }
          } catch { /* try next */ }
        }
      }
      if (!audioUrl) {
        try {
          const result = await fal.queue.result(fal_endpoint, { requestId: fal_request_id })
          audioUrl = extractAudioUrl((result as Record<string, unknown>)?.data ?? result) || extractAudioUrl(result)
        } catch (e) { console.error("[audio/status] fal.queue.result failed", e) }
      }

      if (audioUrl) {
        const permanentUrl = await uploadAudioToStorage(audioUrl, userId, jobId, adminAny)

        // Mark completed exactly once (guard against concurrent polls).
        const { data: updated, error: updateError } = await adminAny
          .from("generations")
          .update({ status: "completed", output_url: permanentUrl })
          .eq("id", jobId)
          .neq("status", "completed")
          .select()
          .single()
        if (!updated || updateError) return NextResponse.json({ status: "completed", progress: 100, output_url: permanentUrl })

        // Charge exactly once, on success (credits: generations.credits_deducted compare-and-set; QLC: settles the on-chain charge).
        await settleGenerationCharge({
          user: authUser, generationId: jobId, credits: gen.credits_used, description: `Audio generation: ${gen.model} (${gen.prompt.slice(0, 40)})`, once: "generation-row",
        })

        return NextResponse.json({ status: "completed", progress: 100, estimated_seconds_remaining: 0, output_url: permanentUrl, error_message: null })
      }

      // Completed but no audio URL → fail WITHOUT deducting.
      console.error(`[audio/status] completed but no audio URL for ${jobId} (endpoint=${fal_endpoint})`)
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", progress: 0, estimated_seconds_remaining: 0, output_url: null, error_message: "No audio URL in provider response" })
    }

    // ── FAILED / CANCELLED — no deduction ──
    if (st === "FAILED" || st === "CANCELLED") {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", progress: 0, estimated_seconds_remaining: 0, output_url: null, error_message: "Audio generation failed" })
    }

    // ── IN_PROGRESS / IN_QUEUE ──
    const newStatus = st === "IN_PROGRESS" ? "processing" : "pending"
    if (gen.status !== newStatus) await adminAny.from("generations").update({ status: newStatus }).eq("id", jobId)
    const progress = st === "IN_PROGRESS" ? Math.min(85, (elapsedSec / estimatedSec) * 80 + 5) : Math.min(15, elapsedSec * 0.5)
    return NextResponse.json({ status: newStatus, progress: Math.round(progress), estimated_seconds_remaining: Math.round(remaining), output_url: null, error_message: null })
  } catch (err) {
    console.error("[generate/audio/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
