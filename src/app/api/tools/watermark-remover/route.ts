import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from "@/lib/billing/generationBilling"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import { extractMuapiJobId } from "@/lib/muapi"
import { meetsPlan, type PlanId } from "@/lib/plans"
import { isInternalUser } from "@/lib/planAccess"

const MUAPI_BASE = "https://api.muapi.ai/v1"

// PLAN_LEVEL now imported from @/lib/plans (single source for the plan hierarchy).

interface WatermarkBody {
  video_url: string
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
  const isAdmin = isInternalUser(authUser)
    const userPlan = ((authUser.plan as PlanId | undefined) ?? "free")

    if (!meetsPlan(userPlan, "starter")) {
      return NextResponse.json(
        { error: "Watermark Remover requires the Starter plan or higher." },
        { status: 403 },
      )
    }

    const body = (await req.json()) as WatermarkBody
    const { video_url } = body

    if (!video_url) {
      return NextResponse.json({ error: "video_url je obavezan" }, { status: 400 })
    }

    const muapiKey = process.env.MUAPI_API_KEY
    if (!muapiKey) {
      return NextResponse.json({ error: "MUAPI API key is not configured" }, { status: 500 })
    }

    const creditCost = CREDITS.muapi.watermark_remover

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    const { data: generation, error: insertError } = await adminAny
      .from("generations")
      .insert({
        user_id: userId,
        type: "video",
        model: "watermark_remover",
        prompt: "Watermark removal",
        status: "pending",
        credits_used: creditCost,
        settings: {
          muapi_model: "watermark_remover",
          muapi_job_id: null,
          video_url,
          estimated_seconds: 60,
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[watermark-remover] insert error", insertError)
      return NextResponse.json({ error: "Could not create the generation" }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    let muapiJobId: string
    try {
      const muapiRes = await fetch(`${MUAPI_BASE}/video/remove-watermark`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${muapiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ video_url }),
      })

      if (!muapiRes.ok) {
        const errText = await muapiRes.text().catch(() => "")
        console.error("[watermark-remover] muapi error", muapiRes.status, errText)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
        return NextResponse.json(
          { error: `MUAPI watermark remover failed (${muapiRes.status})` },
          { status: 502 },
        )
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const muapiData = (await muapiRes.json()) as any
      const extractedId = extractMuapiJobId(muapiData)
      if (!extractedId) {
        console.error("[watermark-remover] muapi missing job_id", muapiData)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
        return NextResponse.json({ error: "MUAPI did not return a job ID" }, { status: 502 })
      }
      muapiJobId = extractedId
    } catch (err) {
      console.error("[watermark-remover] fetch error", err)
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
      return NextResponse.json({ error: "Failed to send the request to MUAPI" }, { status: 502 })
    }

    await adminAny
      .from("generations")
      .update({
        settings: {
          muapi_model: "watermark_remover",
          muapi_job_id: muapiJobId,
          video_url,
          estimated_seconds: 60,
        },
      })
      .eq("id", generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error("[watermark-remover]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
