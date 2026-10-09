import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

fal.config({ credentials: process.env.FAL_KEY })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface RouteParams {
  params: { jobId: string }
}

function extractImageUrl(result: unknown): string | null {
  const r = result as Record<string, unknown>
  if (Array.isArray(r?.images) && r.images.length > 0) {
    const img = (r.images as Array<{ url?: string }>)[0]
    return img?.url ?? null
  }
  if (typeof r?.image === "object" && r?.image !== null) {
    const img = r.image as { url?: string }
    return img.url ?? null
  }
  if (typeof r?.output === "string") return r.output as string
  return null
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { jobId } = params
    const admin: AdminAny = createSupabaseAdmin()

    const { data: gen } = await admin
      .from("generations")
      .select("id, status, output_url, settings, user_id, credits_used")
      .eq("id", jobId)
      .single()

    if (!gen || gen.user_id !== authUser.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const generation = gen as {
      id: string
      status: string
      output_url: string | null
      settings: { fal_request_id?: string; fal_endpoint?: string }
      credits_used: number
    }

    if (generation.status === "completed" && generation.output_url) {
      let outputUrl = generation.output_url
      // Handle both JSON array format and plain URL
      try {
        const parsed = JSON.parse(generation.output_url) as string[]
        outputUrl = parsed[0] ?? generation.output_url
      } catch {
        // plain URL, use as-is
      }
      return NextResponse.json({ status: "completed", output_url: outputUrl, progress: 100 })
    }

    if (generation.status === "failed") {
      return NextResponse.json({ status: "failed", error: "Generation failed" })
    }

    const requestId = generation.settings?.fal_request_id
    const falEndpoint = generation.settings?.fal_endpoint

    if (!requestId || !falEndpoint) {
      return NextResponse.json({ status: generation.status, progress: 0 })
    }

    const statusRes = await fal.queue.status(falEndpoint, { requestId, logs: false })
    const falStatus = statusRes.status as "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED"

    if (falStatus === "COMPLETED") {
      const result = await fal.queue.result(falEndpoint, { requestId })
      const outputUrl = extractImageUrl(result.data)

      if (outputUrl) {
        await admin
          .from("generations")
          .update({ status: "completed", output_url: outputUrl })
          .eq("id", jobId)

        // Charge exactly once, on success (credits: compare-and-set deduction; QLC: settles the on-chain charge).
        await settleGenerationCharge({
          user: authUser, generationId: jobId, credits: generation.credits_used, description: `Character generation: ${jobId}`, once: "generation-row",
        })

        return NextResponse.json({ status: "completed", output_url: outputUrl, progress: 100 })
      }

      await admin.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", error: "No output image" })
    }

    if (falStatus === "FAILED") {
      await admin.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({ status: "failed", error: "fal.ai generation failed" })
    }

    const progress = falStatus === "IN_PROGRESS" ? 55 : 15
    const mapped = falStatus === "IN_QUEUE" ? "pending" : "processing"
    await admin.from("generations").update({ status: mapped }).eq("id", jobId)

    return NextResponse.json({ status: mapped, progress })
  } catch (err) {
    console.error("[character/generate/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
