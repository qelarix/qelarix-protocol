import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { CREDITS } from '@/lib/credits'
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from '@/lib/billing/generationBilling'
import { fal } from '@fal-ai/client'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

// Allow up to 60s for FLUX Kontext Pro synchronous generation
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface GenerateImageBody {
  prompt: string
  referenceImageUrl?: string
  aspectRatio?: '1:1' | '9:16' | '16:9' | '4:3' | '3:4'
  influencerName?: string
}

const FAL_ENDPOINT = 'fal-ai/flux-pro/kontext'
const CREDIT_COST = CREDITS.influencer.generate_image

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userId = authUser.id
  const isAdmin = isInternalUser(authUser)

    const body = (await req.json()) as GenerateImageBody
    const { prompt, referenceImageUrl, aspectRatio = '1:1', influencerName } = body

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'Prompt je obavezan' }, { status: 400 })
    }

    const admin: AdminAny = createSupabaseAdmin()

    // Check the balance, then charge before the provider runs (QLC billing; no-op in credits mode). The row is
    // written after success with this id.
    const funds = await checkGenerationFunds({ user: authUser, credits: CREDIT_COST, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })
    const generationId = randomUUID()
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: CREDIT_COST, exempt: isAdmin })
    if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })

    // Build fal.ai input
    const falInput: Record<string, unknown> = {
      prompt: prompt.trim(),
      aspect_ratio: aspectRatio,
      output_format: 'jpeg',
      guidance_scale: 3.5,
      num_inference_steps: 28,
    }

    if (referenceImageUrl) {
      falInput.image_url = referenceImageUrl
    }

    // Generate synchronously via fal.subscribe
    let imageUrl: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (fal as any).subscribe(FAL_ENDPOINT, {
        input: falInput,
        pollInterval: 2000,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rd = result as any
      imageUrl =
        rd?.data?.images?.[0]?.url ??
        rd?.images?.[0]?.url ??
        rd?.data?.image?.url ??
        ''
      if (!imageUrl) throw new Error('No image URL in fal.ai response')
    } catch (falErr) {
      console.error('[influencer/generate-image] fal.ai error:', falErr)
      await releaseGenerationCharge({ generationId, reason: 'provider failed' })
      return NextResponse.json({ error: 'Image generation failed. Please try again.' }, { status: 502 })
    }

    // Charge (only after successful generation)
    const deducted = await settleGenerationCharge({
      user: authUser,
      generationId,
      credits: CREDIT_COST,
      description: `Influencer image${influencerName ? ` — ${influencerName}` : ''} (FLUX Kontext Pro)`,
      exempt: isAdmin,
      once: 'this-request',
    })

    if (!deducted) {
      console.error('[influencer/generate-image] credit deduction failed for user', userId)
    }

    // Log generation
    await admin.from('generations').insert({
      id: generationId,
      user_id: userId,
      type: 'image',
      model: 'flux_kontext_influencer',
      prompt: prompt.trim(),
      status: 'completed',
      output_url: imageUrl,
      credits_used: CREDIT_COST,
      settings: {
        fal_endpoint: FAL_ENDPOINT,
        aspect_ratio: aspectRatio,
        has_reference_image: !!referenceImageUrl,
        influencer_name: influencerName ?? null,
      },
    })

    return NextResponse.json({ imageUrl, creditsUsed: CREDIT_COST })
  } catch (err) {
    console.error('[influencer/generate-image]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
