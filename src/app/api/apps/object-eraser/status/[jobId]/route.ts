import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { releaseGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { getMuapiPredictionResult } from "@/lib/muapi"

// Polls the MuAPI prediction result. On completion: charges ONCE (settleGenerationCharge)
// and persists output_url to the existing `generations` row. Mirrors background-remover/status.

interface Settings {
  muapi_request_id?: string | null
  image_url?: string
  mask_image_url?: string
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
    const estimatedSec = gen.settings?.estimated_seconds ?? 30
    const elapsed = (Date.now() - new Date(gen.created_at).getTime()) / 1000
    const progress = Math.round(Math.min(85, (elapsed / estimatedSec) * 80 + 5))

    if (!requestId) {
      return NextResponse.json({ status: gen.status, progress: 0, output_url: null, error_message: null })
    }
    if (!process.env.MUAPI_API_KEY) {
      return NextResponse.json({ error: "MUAPI_API_KEY is missing on server" }, { status: 500 })
    }

    let result
    try {
      result = await getMuapiPredictionResult(requestId)
    } catch (err) {
      console.error("[apps/object-eraser/status] muapi error", err)
      return NextResponse.json({ status: gen.status, progress, output_url: null, error_message: null })
    }

    if (result.status === "completed" && result.outputUrl) {
      // Charge exactly once, on success (credits: compare-and-set deduction; QLC: settles the on-chain charge).
      await settleGenerationCharge({
        user: authUser, generationId: jobId, credits: gen.credits_used, description: "Object Eraser", once: "generation-row",
      })
      await adminAny
        .from("generations")
        .update({ status: "completed", output_url: result.outputUrl })
        .eq("id", jobId)
      return NextResponse.json({ status: "completed", progress: 100, output_url: result.outputUrl, error_message: null })
    }

    if (result.status === "failed") {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", jobId)
      await releaseGenerationCharge({ generationId: jobId, reason: "provider reported failure" })
      return NextResponse.json({
        status: "failed",
        progress: 0,
        output_url: null,
        error_message: result.errorMessage ?? "Object removal failed",
      })
    }

    if (gen.status !== "processing") {
      await adminAny.from("generations").update({ status: "processing" }).eq("id", jobId)
    }
    return NextResponse.json({ status: "processing", progress, output_url: null, error_message: null })
  } catch (err) {
    console.error("[apps/object-eraser/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
