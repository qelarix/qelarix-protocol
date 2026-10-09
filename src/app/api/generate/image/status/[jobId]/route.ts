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

interface RouteParams {
  params: { jobId: string }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImageUrls(r: any): string[] {
  if (!r) return []
  const url: string | null =
    r?.images?.[0]?.url ||
    r?.image?.url ||
    r?.output?.[0] ||
    r?.data?.images?.[0]?.url ||
    r?.data?.image?.url ||
    r?.url ||
    null
  if (!url) return []
  // Return all images if available, otherwise single URL
  if (Array.isArray(r?.images)) {
    const urls = (r.images as Array<{ url?: string }>).map((img) => img?.url).filter((u): u is string => !!u)
    if (urls.length > 0) return urls
  }
  if (Array.isArray(r?.data?.images)) {
    const urls = (r.data.images as Array<{ url?: string }>).map((img) => img?.url).filter((u): u is string => !!u)
    if (urls.length > 0) return urls
  }
  return [url]
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { jobId } = params
    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const { data: gen } = await adminAny
      .from("generations")
      .select("id, status, output_url, settings, created_at, user_id, credits_used")
      .eq("id", jobId)
      .single()

    if (!gen || (gen as { user_id: string }).user_id !== authUser.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const generation = gen as {
      id: string
      status: string
      output_url: string | null
      settings: { fal_request_id?: string; fal_endpoint?: string; num_images?: number }
      created_at: string
      credits_used: number
    }

    if (generation.status === "completed" && generation.output_url) {
      const urls = JSON.parse(generation.output_url) as string[]
      return NextResponse.json({ status: "completed", output_urls: urls, progress: 100 })
    }

    if (generation.status === "failed") {
      return NextResponse.json({ status: "failed", error: "Generation failed" })
    }

    const requestId = generation.settings?.fal_request_id
    const falEndpoint = generation.settings?.fal_endpoint

    if (!requestId || !falEndpoint) {
      return NextResponse.json({ status: generation.status, progress: 0 })
    }

    const statusRes = await fal.queue.status(falEndpoint, {
      requestId,
      logs: false,
    }) as { status: string; response_url?: string }

    const falStatus = statusRes.status as "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED"

    if (falStatus === "COMPLETED") {
      let resultData: unknown = null
      // Set when the provider ran but produced no image for this prompt (fal error type no_media_generated).
      let noMediaForPrompt = false

      const responseUrl = (statusRes as Record<string, unknown>).response_url as string | undefined
      const directUrl = `https://queue.fal.run/${falEndpoint}/requests/${requestId}`
      const urlsToTry = [responseUrl, directUrl].filter((u): u is string => !!u)

      for (const url of urlsToTry) {
        if (resultData) break
        for (const headers of [undefined, { Authorization: `Key ${process.env.FAL_KEY}` }] as const) {
          if (resultData) break
          try {
            const resp = await fetch(url, { headers })
            if (resp.ok) {
              resultData = await resp.json()
            }
          } catch { /* try next */ }
        }
      }

      if (!resultData) {
        try {
          const r = await fal.queue.result(falEndpoint, { requestId })
          // r.data is the model output, but sometimes r itself is the output
          resultData = r.data || r
        } catch (e) {
          console.error('[image/status] fal.queue.result error:', e)
          const detail = (e as { body?: { detail?: Array<{ type?: string }> } })?.body?.detail
          noMediaForPrompt = Array.isArray(detail) && detail.some((d) => d?.type === "no_media_generated")
        }
      }

      const imageUrls = extractImageUrls(resultData)

      if (imageUrls.length > 0) {
        const permanentUrls = await Promise.all(
          imageUrls.map((url, i) =>
            uploadToStorage(url, authUser.id!, 'image', i === 0 ? jobId : `${jobId}_${i}`, adminAny)
          )
        )

        await adminAny
          .from("generations")
          .update({
            status: "completed",
            output_url: JSON.stringify(permanentUrls),
          })
          .eq("id", jobId)

        // Charge exactly once, on success (credits: generations.credits_deducted compare-and-set — concurrent polls
        // cannot double charge; QLC: settles the on-chain charge).
        await settleGenerationCharge({
          user: authUser, generationId: jobId, credits: generation.credits_used, description: `Image generation: ${jobId}`, once: "generation-row",
        })

        return NextResponse.json({ status: "completed", output_urls: permanentUrls, progress: 100 })
      } else {
        await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
        await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
        return NextResponse.json({
          status: "failed",
          error: noMediaForPrompt ? "no_media_generated" : "No output images",
          message: noMediaForPrompt
            ? "The model couldn't create an image from this prompt. Try a more descriptive prompt. Nothing was charged."
            : "Generation failed. Nothing was charged.",
        })
      }
    }

    if (falStatus === "FAILED") {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", error: "fal.ai generation failed" })
    }

    const progress = falStatus === "IN_PROGRESS" ? 55 : 15
    const mapped = falStatus === "IN_QUEUE" ? "pending" : "processing"
    await adminAny.from("generations").update({ status: mapped }).eq("id", jobId)

    return NextResponse.json({ status: mapped, progress })
  } catch (err) {
    console.error("[generate/image/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
