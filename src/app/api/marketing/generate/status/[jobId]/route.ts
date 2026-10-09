import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

fal.config({ credentials: process.env.FAL_KEY })

interface GenerationSettings {
  fal_endpoint: string
  fal_request_id: string | null
  duration?: number
  aspect_ratio?: string
  marketing?: {
    platform: string
    adType: string
    tone: string
    targetAudience: string
    cta: string
    userDuration: number
    productName: string
    productDescription: string
    productFeatures: string[]
    productImageUrl: string | null
    brandKitId: string | null
  }
}

function extractVideoUrl(data: Record<string, unknown>): string | null {
  if (typeof data?.video === "object" && data.video !== null) {
    const vid = data.video as Record<string, unknown>
    if (typeof vid.url === "string") return vid.url
  }
  if (typeof data?.video_url === "string") return data.video_url
  if (Array.isArray(data?.videos) && data.videos.length > 0) {
    const first = data.videos[0] as Record<string, unknown>
    if (typeof first?.url === "string") return first.url
  }
  if (typeof data?.url === "string") return data.url
  return null
}

function extractThumbnailUrl(data: Record<string, unknown>): string | null {
  if (typeof data?.thumbnail === "object" && data.thumbnail !== null) {
    const thumb = data.thumbnail as Record<string, unknown>
    if (typeof thumb.url === "string") return thumb.url
  }
  if (typeof data?.thumbnail_url === "string") return data.thumbnail_url
  if (Array.isArray(data?.images) && data.images.length > 0) {
    const first = data.images[0] as Record<string, unknown>
    if (typeof first?.url === "string") return first.url
  }
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const userId = authUser.id
    const { jobId } = params

    if (!jobId) return NextResponse.json({ error: "jobId je obavezan" }, { status: 400 })

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const { data: generation, error: fetchError } = await adminAny
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
      const thumbUrl = ((gen.settings as unknown) as Record<string, unknown> & { thumbnail_url?: string }).thumbnail_url ?? null
      return NextResponse.json({
        status: "completed",
        progress: 100,
        output_url: gen.output_url,
        thumbnail_url: thumbUrl,
        error_message: null,
      })
    }

    if (gen.status === "failed") {
      return NextResponse.json({
        status: "failed",
        progress: 0,
        output_url: null,
        thumbnail_url: null,
        error_message: "Generation failed",
      })
    }

    const { fal_endpoint, fal_request_id } = gen.settings

    if (!fal_endpoint || !fal_request_id) {
      return NextResponse.json({
        status: gen.status,
        progress: 0,
        output_url: null,
        thumbnail_url: null,
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
      console.error("[marketing/status] fal.ai status check error", falErr)
      return NextResponse.json({
        status: gen.status,
        progress: 5,
        output_url: null,
        thumbnail_url: null,
        error_message: null,
      })
    }

    const falStatusStr = falStatus.status as string

    if (falStatusStr === "COMPLETED") {
      let videoUrl: string | null = null
      let thumbnailUrl: string | null = null

      try {
        const result = await fal.queue.result(fal_endpoint, { requestId: fal_request_id })
        const data = (result.data ?? {}) as Record<string, unknown>
        videoUrl = extractVideoUrl(data)
        thumbnailUrl = extractThumbnailUrl(data)
      } catch (resultErr) {
        console.error("[marketing/status] fal.ai result fetch error", resultErr)
      }

      if (videoUrl) {
        // Charge exactly once, on success (credits: compare-and-set deduction; QLC: settles the on-chain charge).
        const deducted = await settleGenerationCharge({
          user: authUser,
          generationId: jobId,
          credits: gen.credits_used,
          description: `Marketing Studio: ${gen.settings.marketing?.productName?.slice(0, 40) ?? "video"}`,
          once: "generation-row",
        })

        if (!deducted) {
          console.warn("[marketing/status] credits deduction failed for", jobId)
        }

        const updatedSettings = { ...gen.settings, thumbnail_url: thumbnailUrl ?? undefined }
        await adminAny
          .from("generations")
          .update({ status: "completed", output_url: videoUrl, settings: updatedSettings })
          .eq("id", jobId)

        return NextResponse.json({
          status: "completed",
          progress: 100,
          output_url: videoUrl,
          thumbnail_url: thumbnailUrl,
          error_message: null,
        })
      }

      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        output_url: null,
        thumbnail_url: null,
        error_message: "Video URL missing from the response",
      })
    }

    if (falStatusStr === "FAILED" || falStatusStr === "CANCELLED") {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        output_url: null,
        thumbnail_url: null,
        error_message: "fal.ai generation failed",
      })
    }

    const newStatus = falStatusStr === "IN_PROGRESS" ? "processing" : "pending"
    if (gen.status !== newStatus) {
      await adminAny.from("generations").update({ status: newStatus }).eq("id", jobId)
    }

    const elapsedSec = (Date.now() - new Date(gen.created_at).getTime()) / 1000
    const estimatedSec = 90
    const remaining = Math.max(0, estimatedSec - elapsedSec)
    const progress =
      falStatusStr === "IN_PROGRESS"
        ? Math.min(85, (elapsedSec / estimatedSec) * 80 + 5)
        : Math.min(15, elapsedSec * 0.5)

    return NextResponse.json({
      status: newStatus,
      progress: Math.round(progress),
      estimated_seconds_remaining: Math.round(remaining),
      output_url: null,
      thumbnail_url: null,
      error_message: null,
    })
  } catch (err) {
    console.error("[marketing/generate/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
