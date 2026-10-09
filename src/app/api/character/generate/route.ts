import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { CREDITS } from "@/lib/credits"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

const FAL_ENDPOINT = "fal-ai/flux-pro/kontext"
const CREDIT_COST = CREDITS.character.flux_kontext

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface GenerateCharacterBody {
  name: string
  description: string
  style: string
  outfit: string
  background: string
  pose: string
  referenceImageUrl?: string
}

function buildPrompt(body: GenerateCharacterBody): string {
  const styleMap: Record<string, string> = {
    Realistic: "photorealistic, ultra-detailed, professional photography",
    Cinematic: "cinematic photography, film grain, dramatic lighting, movie still",
    Anime: "anime art style, vibrant colors, detailed illustration, manga-inspired",
    "3D": "3D rendered character, CGI, Pixar-style, high detail render",
  }

  const styleDesc = styleMap[body.style] ?? styleMap.Realistic
  const parts: string[] = []

  parts.push(`${styleDesc} portrait of ${body.name}`)
  if (body.description?.trim()) parts.push(body.description.trim())
  if (body.outfit?.trim()) parts.push(`Wearing: ${body.outfit.trim()}`)
  if (body.background?.trim()) parts.push(`Background: ${body.background.trim()}`)
  if (body.pose?.trim()) parts.push(`Pose: ${body.pose.trim()}`)
  parts.push("high quality, sharp focus, professional lighting, character design")

  return parts.join(". ")
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = authUser.id
  const isAdmin = isInternalUser(authUser)
    const body = (await req.json()) as GenerateCharacterBody

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Character name is required" }, { status: 400 })
    }
    if (!body.description?.trim()) {
      return NextResponse.json({ error: "Opis karaktera je obavezan" }, { status: 400 })
    }

    const admin: AdminAny = createSupabaseAdmin()

    const funds = await checkGenerationFunds({ user: authUser, credits: CREDIT_COST, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    const prompt = buildPrompt(body)

    const { data: generation, error: insertError } = await admin
      .from("generations")
      .insert({
        user_id: userId,
        type: "image",
        model: "flux_kontext_character",
        prompt,
        status: "pending",
        credits_used: CREDIT_COST,
        settings: {
          fal_endpoint: FAL_ENDPOINT,
          fal_request_id: null,
          character_name: body.name,
          style: body.style,
          reference_image_url: body.referenceImageUrl ?? null,
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[character/generate] insert error", insertError)
      return NextResponse.json({ error: "Could not create the generation" }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: CREDIT_COST, exempt: isAdmin })
    if (!charge.ok) {
      await admin.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    const falInput: Record<string, unknown> = {
      prompt,
      aspect_ratio: "1:1",
      output_format: "jpeg",
      guidance_scale: 3.5,
    }

    if (body.referenceImageUrl) {
      falInput.image_url = body.referenceImageUrl
    }

    let requestId: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queued = await fal.queue.submit(FAL_ENDPOINT as any, { input: falInput as any })
      requestId = queued.request_id
    } catch (falErr) {
      console.error("[character/generate] fal.ai error", falErr)
      await admin.from("generations").update({ status: "failed" }).eq("id", generationId)
      await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
      return NextResponse.json({ error: "fal.ai rejected the request" }, { status: 502 })
    }

    await admin
      .from("generations")
      .update({
        settings: {
          fal_endpoint: FAL_ENDPOINT,
          fal_request_id: requestId,
          character_name: body.name,
          style: body.style,
          reference_image_url: body.referenceImageUrl ?? null,
        },
      })
      .eq("id", generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error("[character/generate]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
