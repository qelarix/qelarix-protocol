import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { CREDITS } from "@/lib/credits"
import type { EditOperation } from "@/lib/credits"
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })


const EDIT_CONFIG: Record<EditOperation, { endpoint: string; credits: number }> = {
  inpaint:   { endpoint: "fal-ai/flux-pro/v1.1/inpainting",    credits: CREDITS.edit.inpaint },
  face_swap: { endpoint: "fal-ai/iface-swap",                  credits: CREDITS.edit.face_swap },
  outfit:    { endpoint: "fal-ai/cat-vton",                    credits: CREDITS.edit.outfit },
  bg_remove: { endpoint: "fal-ai/imageutils/rembg",            credits: CREDITS.edit.bg_remove },
  expand:    { endpoint: "fal-ai/ideogram/v3/reframe",         credits: CREDITS.edit.expand },
  upscale2x: { endpoint: "fal-ai/clarity-upscaler",           credits: CREDITS.edit.upscale2x },
  upscale4x: { endpoint: "fal-ai/clarity-upscaler",           credits: CREDITS.edit.upscale4x },
  relight:   { endpoint: "fal-ai/iclight-v2",                  credits: CREDITS.edit.relight },
}

// Input files are now uploaded client-side via the signed direct-to-storage flow (/api/upload/sign →
// PUT → generations bucket). This route receives ready public URLs in `urls` — no file body, no `media`
// bucket, no Vercel body-cap risk. buildFalInput/extractResultUrl/credit/history logic is unchanged.

function buildFalInput(operation: EditOperation, urls: Record<string, string>, settings: Record<string, string>): Record<string, unknown> {
  switch (operation) {
    case "inpaint":
      return { image_url: urls.image, mask_url: urls.mask, prompt: settings.prompt ?? "", num_inference_steps: 28, strength: 0.95 }
    case "face_swap":
      return { source_image_url: urls.source, target_image_url: urls.target }
    case "outfit":
      return { human_image_url: urls.person, garment_image_url: urls.garment, category: settings.category ?? "upper_body" }
    case "bg_remove":
      return { image_url: urls.image }
    case "expand":
      return { image_url: urls.image, aspect_ratio: settings.ratio ?? "16:9", expand_prompt: settings.prompt ?? "" }
    case "upscale2x":
      return { image_url: urls.image, scale_factor: 2, creativity: 0.35 }
    case "upscale4x":
      return { image_url: urls.image, scale_factor: 4, creativity: 0.35 }
    case "relight":
      return buildRelightInput(urls.image, settings.light_direction ?? "top-left", Number(settings.color_temp ?? "5500"))
    default:
      return {}
  }
}

// IC-Light v2 takes a text lighting prompt plus a coarse light side (Left/Right/Top/Bottom). The UI wheel has
// eight directions and a color temperature, so both are folded into the prompt and the nearest side.
function buildRelightInput(imageUrl: string, direction: string, colorTemp: number): Record<string, unknown> {
  const side = direction.includes("left") ? "Left" : direction.includes("right") ? "Right" : direction.startsWith("bottom") ? "Bottom" : "Top"
  const tone = colorTemp <= 4000 ? "warm golden" : colorTemp >= 7000 ? "cool blue" : "neutral daylight"
  const from = direction.replace("-", " ")
  return {
    image_url: imageUrl,
    prompt: `same subject, soft ${tone} light coming from the ${from}, natural shadows, high detail, photorealistic`,
    initial_latent: side,
    num_images: 1,
    output_format: "jpeg",
  }
}

function extractResultUrl(result: unknown): string | null {
  const r = result as Record<string, unknown>
  if (!r) return null
  if (r.image && typeof (r.image as Record<string, unknown>).url === "string") return (r.image as Record<string, unknown>).url as string
  if (Array.isArray(r.images) && r.images.length > 0) {
    const img = r.images[0] as Record<string, unknown>
    if (typeof img.url === "string") return img.url
  }
  if (typeof r.image_url === "string") return r.image_url
  if (typeof r.url === "string") return r.url
  return null
}

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = authUser.id
  const isAdmin = isInternalUser(authUser)

  // JSON payload: { operation, urls: { <inputKey>: publicUrl }, settings: { ... } }.
  // Inputs are pre-uploaded by the client via signed direct-to-storage (no file body here).
  let payload: { operation?: string; urls?: Record<string, string>; settings?: Record<string, string> }
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const operation = payload.operation as EditOperation | null
  if (!operation || !(operation in EDIT_CONFIG)) {
    return NextResponse.json({ error: "Invalid or missing operation" }, { status: 400 })
  }

  const urls: Record<string, string> = payload.urls ?? {}
  const settings: Record<string, string> = payload.settings ?? {}

  // All input URLs must be public http(s) URLs (from the signed upload) — never trust a local/file path.
  for (const [key, value] of Object.entries(urls)) {
    if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
      return NextResponse.json({ error: `Invalid input URL for "${key}".` }, { status: 400 })
    }
  }

  const config = EDIT_CONFIG[operation]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any

  const funds = await checkGenerationFunds({ user: authUser, credits: config.credits, exempt: isAdmin })
  if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

  // The generation id exists before the provider runs, so QLC billing can charge it first; the row is
  // written after success (no-op in credits mode).
  const generationId = randomUUID()
  const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: config.credits, exempt: isAdmin })
  if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })

  let falResult: unknown
  try {
    const input = buildFalInput(operation, urls, settings)
    const result = await fal.subscribe(config.endpoint, { input })
    falResult = result.data
  } catch (e) {
    console.error("fal.ai edit error:", e)
    await releaseGenerationCharge({ generationId, reason: "provider failed" })
    return NextResponse.json({ error: "Edit operation failed. Please try again." }, { status: 502 })
  }

  const resultUrl = extractResultUrl(falResult)
  if (!resultUrl) {
    await releaseGenerationCharge({ generationId, reason: "no output" })
    return NextResponse.json({ error: "No output from edit operation" }, { status: 502 })
  }

  const paid = await settleGenerationCharge({
    user: authUser, generationId, credits: config.credits, description: `Edit: ${operation}`, exempt: isAdmin, once: "this-request",
  })
  if (!paid) return NextResponse.json({ error: "Credit deduction failed" }, { status: 402 })

  await supabase.from("generations").insert({
    id: generationId,
    user_id: userId,
    type: "edit",
    model: operation,
    prompt: settings.prompt ?? operation,
    status: "completed",
    output_url: resultUrl,
    credits_used: config.credits,
    settings: { operation, ...settings },
    is_public: false,
  })

  return NextResponse.json({ resultUrl, creditsUsed: config.credits })
}
