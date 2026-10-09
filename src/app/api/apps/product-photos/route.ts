import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from "@/lib/billing/generationBilling"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import { runMuapiImageApp } from "@/lib/muapi"
import { isInternalUser } from "@/lib/planAccess"

// Product Photos — MuAPI ai-product-shot. Verified required payload: image_url + scene_description (one
// product image + a scene/background description). Same paid-tool pattern as the other apps: pending
// generations row → submit (no deduction) → deduct only on success in /status. No new Supabase schema.
// (ai-product-photography was provider-broken — returned 422 on all inputs incl. its own examples.)

interface Body {
  image_url: string
  scene_description: string
}

const isPublicHttps = (u: unknown): u is string =>
  typeof u === "string" && /^https?:\/\//.test(u)

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
    const isAdmin = isInternalUser(authUser)

    const { image_url, scene_description } = (await req.json()) as Body
    if (!isPublicHttps(image_url)) {
      return NextResponse.json({ error: "image_url is required (public URL)" }, { status: 400 })
    }
    if (!scene_description || typeof scene_description !== "string" || !scene_description.trim()) {
      return NextResponse.json({ error: "scene_description is required" }, { status: 400 })
    }

    if (!process.env.MUAPI_API_KEY) {
      return NextResponse.json({ error: "MUAPI_API_KEY is missing on server" }, { status: 500 })
    }

    const creditCost = CREDITS.muapi.product_photos

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    const muapiPayload = { image_url, scene_description: scene_description.trim() }

    const { data: generation, error: insertError } = await adminAny
      .from("generations")
      .insert({
        user_id: userId,
        type: "image",
        model: "product_photos",
        prompt: scene_description.trim(),
        status: "pending",
        credits_used: creditCost,
        settings: {
          muapi_model: "ai-product-shot",
          muapi_request_id: null,
          ...muapiPayload,
          estimated_seconds: 40,
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[apps/product-photos] insert error", insertError)
      return NextResponse.json({ error: "Could not create generation" }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode).
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    let requestId: string | null
    try {
      const submit = await runMuapiImageApp("ai-product-shot", muapiPayload)
      requestId = submit.requestId
      if (!requestId) {
        console.error("[apps/product-photos] muapi missing request_id", submit.raw)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        // Provider never ran: return the QLC charge (no-op in credits mode).
        await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
        return NextResponse.json({ error: "MUAPI did not return a request id" }, { status: 502 })
      }
    } catch (err) {
      console.error("[apps/product-photos] muapi submit error", err)
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      // Provider never ran: return the QLC charge (no-op in credits mode).
      await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
      // Surface the real reason (e.g. "MUAPI 402: Insufficient credit balance") instead of a generic message.
      const detail = err instanceof Error ? err.message : "Product photo failed to submit"
      return NextResponse.json({ error: detail }, { status: 502 })
    }

    await adminAny
      .from("generations")
      .update({
        settings: {
          muapi_model: "ai-product-shot",
          muapi_request_id: requestId,
          ...muapiPayload,
          estimated_seconds: 40,
        },
      })
      .eq("id", generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error("[apps/product-photos]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
