import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { getMarketingCredits } from "@/lib/credits"
import type { PlanId } from "@/lib/plans"
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

const FAL_ENDPOINT = "fal-ai/seedance-v1-lite"
const PLAN_ACCESS: PlanId[] = ["starter", "pro", "ultra", "business"]

const PLATFORM_ASPECT: Record<string, string> = {
  instagram_reels: "9:16",
  tiktok: "9:16",
  youtube_shorts: "9:16",
  linkedin: "16:9",
  facebook: "16:9",
}

const PLATFORM_LABELS: Record<string, string> = {
  instagram_reels: "Instagram Reels",
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  linkedin: "LinkedIn",
  facebook: "Facebook",
}

const AD_TYPE_LABELS: Record<string, string> = {
  product_demo: "product demo",
  ugc_style: "UGC-style",
  testimonial: "testimonial",
  brand_awareness: "brand awareness",
}

const TONE_LABELS: Record<string, string> = {
  professional: "professional and trustworthy",
  casual: "casual and friendly",
  energetic: "energetic and dynamic",
  luxury: "luxurious and premium",
  playful: "playful and fun",
}

interface MarketingGenerateBody {
  productName: string
  productDescription: string
  productFeatures: string[]
  productImageUrl?: string | null
  platform: string
  adType: string
  brandKitId?: string | null
  tone: string
  targetAudience: string
  cta: string
  duration: 15 | 30 | 60
}

function buildPrompt(body: MarketingGenerateBody, brandStyle?: string | null): string {
  const platform = PLATFORM_LABELS[body.platform] ?? body.platform
  const adType = AD_TYPE_LABELS[body.adType] ?? body.adType
  const tone = TONE_LABELS[body.tone] ?? body.tone
  const features = body.productFeatures.length > 0
    ? `Key features: ${body.productFeatures.join(", ")}.`
    : ""
  const audienceLine = body.targetAudience
    ? `Target audience: ${body.targetAudience}.`
    : ""
  const brandLine = brandStyle
    ? `Brand style: ${brandStyle}`
    : ""

  return [
    `Create a ${body.duration}-second ${adType} advertisement video optimized for ${platform}.`,
    `Product: "${body.productName}". ${body.productDescription}`,
    features,
    `Tone: ${tone}. ${audienceLine}`,
    `End with a clear call-to-action: "${body.cta}".`,
    brandLine,
    "High production quality, visually engaging, modern design.",
  ]
    .filter(Boolean)
    .join(" ")
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const userId = authUser.id
  const isAdmin = isInternalUser(authUser)
    const userPlan = (authUser.plan as PlanId) ?? "free"

    if (!PLAN_ACCESS.includes(userPlan)) {
      return NextResponse.json(
        { error: "Marketing Studio requires the Starter plan or higher. Upgrade to Starter, Pro, Ultra or Business." },
        { status: 403 },
      )
    }

    let body: MarketingGenerateBody
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Neispravan request body" }, { status: 400 })
    }

    const { productName, productDescription, platform, adType, tone, cta, duration } = body

    if (!productName?.trim()) return NextResponse.json({ error: "Naziv produkta je obavezan" }, { status: 400 })
    if (!productDescription?.trim()) return NextResponse.json({ error: "Opis produkta je obavezan" }, { status: 400 })
    if (!platform) return NextResponse.json({ error: "Platforma je obavezna" }, { status: 400 })
    if (!adType) return NextResponse.json({ error: "Tip reklame je obavezan" }, { status: 400 })
    if (!tone) return NextResponse.json({ error: "Ton je obavezan" }, { status: 400 })
    if (!cta?.trim()) return NextResponse.json({ error: "CTA je obavezan" }, { status: 400 })
    if (![15, 30, 60].includes(duration)) return NextResponse.json({ error: "Duration must be 15, 30 or 60 seconds" }, { status: 400 })

    const creditCost = getMarketingCredits(duration)

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    let brandStyle: string | null = null
    if (body.brandKitId) {
      const { data: kit } = await adminAny
        .from("brand_kits")
        .select("style_description, primary_color, secondary_color, font")
        .eq("id", body.brandKitId)
        .eq("user_id", userId)
        .single()

      if (kit) {
        const kitData = kit as {
          style_description: string | null
          primary_color: string
          secondary_color: string
          font: string
        }
        brandStyle = kitData.style_description
          ?? `Primary color ${kitData.primary_color}, secondary ${kitData.secondary_color}, font ${kitData.font}.`
      }
    }

    const prompt = buildPrompt(body, brandStyle)
    const aspectRatio = PLATFORM_ASPECT[platform] ?? "9:16"
    const falDuration = duration >= 60 ? 10 : 5

    const { data: generation, error: insertError } = await adminAny
      .from("generations")
      .insert({
        user_id: userId,
        type: "video",
        model: "seedance2",
        prompt,
        status: "pending",
        credits_used: creditCost,
        settings: {
          fal_endpoint: FAL_ENDPOINT,
          fal_request_id: null,
          duration: falDuration,
          aspect_ratio: aspectRatio,
          marketing: {
            platform,
            adType,
            tone,
            targetAudience: body.targetAudience ?? "",
            cta,
            userDuration: duration,
            productName: productName.trim(),
            productDescription: productDescription.trim(),
            productFeatures: body.productFeatures ?? [],
            productImageUrl: body.productImageUrl ?? null,
            brandKitId: body.brandKitId ?? null,
          },
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[marketing/generate] insert error", insertError)
      return NextResponse.json({ error: "Could not create the generation" }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    const falInput: Record<string, unknown> = {
      prompt,
      duration: falDuration,
      aspect_ratio: aspectRatio,
    }
    if (body.productImageUrl) {
      falInput.image_url = body.productImageUrl
    }

    let requestId: string
    try {
      const queued = await fal.queue.submit(FAL_ENDPOINT, { input: falInput })
      requestId = queued.request_id
    } catch (falErr) {
      console.error("[marketing/generate] fal.ai submit error", falErr)
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      await releaseGenerationCharge({ generationId, reason: "provider submit failed" })
      return NextResponse.json({ error: "fal.ai queue submission failed" }, { status: 502 })
    }

    await adminAny
      .from("generations")
      .update({
        settings: {
          fal_endpoint: FAL_ENDPOINT,
          fal_request_id: requestId,
          duration: falDuration,
          aspect_ratio: aspectRatio,
          marketing: {
            platform,
            adType,
            tone,
            targetAudience: body.targetAudience ?? "",
            cta,
            userDuration: duration,
            productName: productName.trim(),
            productDescription: productDescription.trim(),
            productFeatures: body.productFeatures ?? [],
            productImageUrl: body.productImageUrl ?? null,
            brandKitId: body.brandKitId ?? null,
          },
        },
      })
      .eq("id", generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error("[marketing/generate]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
