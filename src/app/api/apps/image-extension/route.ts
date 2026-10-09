import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

// Allow the synchronous fal.subscribe call (Quality tier can take ~20–40s) to finish.
export const maxDuration = 300

// Image Extension — fal.ai `fal-ai/ideogram/v3/reframe` (Ideogram V3 Reframe / outpaint).
// SAME model + synchronous fal.subscribe pattern as /api/edit "expand" (proven stable; replaces the
// provider-unstable MuAPI ideogram-v3-reframe). The model takes image_url + image_size + rendering_speed
// — it has NO aspect_ratio enum and NO prompt. We map each user-facing target ratio to a concrete
// image_size (5 native presets + 5 explicit canvases). Quality tier ($0.09/run). Deduct 8 cr ONLY on
// success. No pending row / status poll needed (synchronous). No new Supabase schema.

// Target ratio → fal image_size. Native presets cover 1:1/4:3/3:4/16:9/9:16; the rest are explicit
// canvases (fixed resolutions, exactly like the presets). "Auto" is intentionally NOT offered — the
// model always needs a concrete target. These are the only ratios the UI exposes (no fake options).
type FalImageSize =
  | "square_hd" | "square"
  | "landscape_4_3" | "portrait_4_3"
  | "landscape_16_9" | "portrait_16_9"
  | { width: number; height: number }

const RATIO_TO_SIZE: Record<string, FalImageSize> = {
  "1:1": "square_hd",
  "4:3": "landscape_4_3",
  "3:4": "portrait_4_3",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "3:2": { width: 1536, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
  "4:5": { width: 1024, height: 1280 },
  "5:4": { width: 1280, height: 1024 },
  "21:9": { width: 1536, height: 658 },
}

interface Body {
  image_url: string
  ratio: string
}

const isPublicHttps = (u: unknown): u is string =>
  typeof u === "string" && /^https?:\/\//.test(u)

// fal-ai/ideogram/v3/reframe output is { images: [{ url }], seed }. Read ONLY real output fields —
// never an echoed input url.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractResultUrl(data: any): string | null {
  if (!data || typeof data !== "object") return null
  if (Array.isArray(data.images) && typeof data.images[0]?.url === "string") return data.images[0].url
  if (typeof data.image?.url === "string") return data.image.url
  if (typeof data.image_url === "string" && data.image_url.startsWith("http")) return data.image_url
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

    const { image_url, ratio } = (await req.json()) as Body
    if (!isPublicHttps(image_url)) {
      return NextResponse.json({ error: "image_url is required (public URL)" }, { status: 400 })
    }
    const image_size = RATIO_TO_SIZE[ratio]
    if (!image_size) {
      return NextResponse.json({ error: `ratio must be one of ${Object.keys(RATIO_TO_SIZE).join(", ")}` }, { status: 400 })
    }

    if (!process.env.FAL_KEY) {
      return NextResponse.json({ error: "FAL_KEY is missing on server" }, { status: 500 })
    }

    const creditCost = CREDITS.muapi.image_extension

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

    // Synchronous reframe — fal.subscribe resolves with the final result or throws a clean error.
    let resultUrl: string | null = null
    try {
      const result = await fal.subscribe("fal-ai/ideogram/v3/reframe", {
        input: { image_url, image_size, rendering_speed: "QUALITY" },
      })
      resultUrl = extractResultUrl(result.data)
    } catch (err) {
      console.error("[apps/image-extension] fal error", err)
      await releaseGenerationCharge({ generationId, reason: "provider failed" })
      const detail = err instanceof Error ? err.message : "Image extension failed"
      return NextResponse.json({ error: detail }, { status: 502 })
    }
    if (!resultUrl) {
      await releaseGenerationCharge({ generationId, reason: "no output" })
      return NextResponse.json({ error: "No output image returned" }, { status: 502 })
    }

    // Charge ONLY on success (admins are not charged but still proceed).
    const paid = await settleGenerationCharge({
      user: authUser, generationId, credits: creditCost, description: "Image Extension", exempt: isAdmin, once: "this-request",
    })
    if (!paid) {
      return NextResponse.json({ error: "Credit deduction failed" }, { status: 402 })
    }

    await adminAny.from("generations").insert({
      id: generationId,
      user_id: userId,
      type: "image",
      model: "image_extension",
      prompt: `Image extension (${ratio})`,
      status: "completed",
      output_url: resultUrl,
      credits_used: creditCost,
      settings: { provider: "fal", fal_model: "fal-ai/ideogram/v3/reframe", ratio, image_size, rendering_speed: "QUALITY" },
      is_public: false,
    })

    return NextResponse.json({ resultUrl, creditsUsed: creditCost })
  } catch (err) {
    console.error("[apps/image-extension]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
