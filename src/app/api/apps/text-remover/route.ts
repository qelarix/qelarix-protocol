import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

// text-removal is fast (~seconds); generous headroom for the synchronous fal.subscribe call.
export const maxDuration = 120

// Text Remover — fal.ai `fal-ai/image-editing/text-removal`. Automatically removes visible TEXT from an
// image. Required payload: image_url ONLY (no mask, no prompt, no controls). Same proven synchronous
// fal.subscribe pattern as /apps/image-extension. Deduct 5 cr ONLY on success. No new Supabase schema.
// NOTE: this is a TEXT remover — NOT a watermark/logo remover; do not market or wire it as one.

interface Body {
  image_url: string
}

const isPublicHttps = (u: unknown): u is string =>
  typeof u === "string" && /^https?:\/\//.test(u)

// fal-ai/image-editing/text-removal output is { images: [{ url }], seed }. Read ONLY real output fields —
// never an echoed input url.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractResultUrl(data: any): string | null {
  if (!data || typeof data !== "object") return null
  if (Array.isArray(data.images) && typeof data.images[0]?.url === "string") return data.images[0].url
  if (typeof data.image?.url === "string") return data.image.url
  return null
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
    const isAdmin = isInternalUser(authUser)

    const { image_url } = (await req.json()) as Body
    if (!isPublicHttps(image_url)) {
      return NextResponse.json({ error: "image_url is required (public URL)" }, { status: 400 })
    }

    if (!process.env.FAL_KEY) {
      return NextResponse.json({ error: "FAL_KEY is missing on server" }, { status: 500 })
    }

    const creditCost = CREDITS.fal.text_remover

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    // The generation id exists before the provider runs, so QLC billing can charge it first; the row is
    // written after success (no-op in credits mode).
    const generationId = randomUUID()
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })

    // Synchronous text removal — fal.subscribe resolves with the final result or throws a clean error.
    let resultUrl: string | null = null
    try {
      const result = await fal.subscribe("fal-ai/image-editing/text-removal", {
        input: { image_url },
      })
      resultUrl = extractResultUrl(result.data)
    } catch (err) {
      console.error("[apps/text-remover] fal error", err)
      await releaseGenerationCharge({ generationId, reason: "provider failed" })
      const detail = err instanceof Error ? err.message : "Text removal failed"
      return NextResponse.json({ error: detail }, { status: 502 })
    }
    if (!resultUrl) {
      await releaseGenerationCharge({ generationId, reason: "no output" })
      return NextResponse.json({ error: "No output image returned" }, { status: 502 })
    }

    // Charge ONLY on success (admins are not charged but still proceed).
    const paid = await settleGenerationCharge({
      user: authUser, generationId, credits: creditCost, description: "Text Remover", exempt: isAdmin, once: "this-request",
    })
    if (!paid) {
      return NextResponse.json({ error: "Credit deduction failed" }, { status: 402 })
    }

    await adminAny.from("generations").insert({
      id: generationId,
      user_id: userId,
      type: "image",
      model: "text_remover",
      prompt: "Text removal",
      status: "completed",
      output_url: resultUrl,
      credits_used: creditCost,
      settings: { provider: "fal", fal_model: "fal-ai/image-editing/text-removal", image_url },
      is_public: false,
    })

    return NextResponse.json({ resultUrl, creditsUsed: creditCost })
  } catch (err) {
    console.error("[apps/text-remover]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
