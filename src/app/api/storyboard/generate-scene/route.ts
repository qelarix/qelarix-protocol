import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { CREDITS } from '@/lib/credits'
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge } from '@/lib/billing/generationBilling'
import { fal } from '@fal-ai/client'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

// FLUX Kontext Pro — character consistency via reference image
const FAL_KONTEXT = 'fal-ai/flux-pro/kontext'
// FLUX 2 Pro — standard high-quality generation
const FAL_FLUX2PRO = 'fal-ai/flux-pro/v1.1'

const SCENE_CREDIT_COST = CREDITS.storyboard.scene

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface GenerateSceneBody {
  visualPrompt: string
  aspectRatio?: string
  // Reference images from linked library characters (Soul ID system)
  characterUrls?: string[]
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userId = authUser.id
  const isAdmin = isInternalUser(authUser)

    let body: GenerateSceneBody
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const { visualPrompt, aspectRatio = '16:9', characterUrls } = body

    if (!visualPrompt?.trim()) {
      return NextResponse.json({ error: 'visualPrompt je obavezan' }, { status: 400 })
    }

    const admin: AdminAny = createSupabaseAdmin()

    const funds = await checkGenerationFunds({ user: authUser, credits: SCENE_CREDIT_COST, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    // Use FLUX Kontext Pro if character reference images are provided (Soul ID)
    const hasCharacterRef = Array.isArray(characterUrls) && characterUrls.length > 0
    const falEndpoint = hasCharacterRef ? FAL_KONTEXT : FAL_FLUX2PRO
    const modelLabel = hasCharacterRef ? 'flux_kontext_storyboard' : 'flux2pro_storyboard'

    const { data: generation, error: insertError } = await admin
      .from('generations')
      .insert({
        user_id: userId,
        type: 'image',
        model: modelLabel,
        prompt: visualPrompt.trim(),
        status: 'pending',
        credits_used: SCENE_CREDIT_COST,
        settings: {
          fal_endpoint: falEndpoint,
          fal_request_id: null,
          aspect_ratio: aspectRatio,
          character_urls: characterUrls ?? [],
          soul_id: hasCharacterRef,
        },
      })
      .select('id')
      .single()

    if (insertError || !generation) {
      console.error('[storyboard/generate-scene] insert error', insertError)
      return NextResponse.json({ error: 'Could not create the generation' }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id

    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status
    // route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: SCENE_CREDIT_COST, exempt: isAdmin })
    if (!charge.ok) {
      await admin.from('generations').update({ status: 'failed' }).eq('id', generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }

    const falInput: Record<string, unknown> = {
      prompt: visualPrompt.trim(),
      aspect_ratio: aspectRatio,
      output_format: 'jpeg',
      num_images: 1,
    }

    // Pass first character reference image for FLUX Kontext Pro
    if (hasCharacterRef && characterUrls![0]) {
      falInput.image_url = characterUrls![0]
    }

    let requestId: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queued = await fal.queue.submit(falEndpoint as any, { input: falInput as any })
      requestId = queued.request_id
    } catch (falErr) {
      console.error('[storyboard/generate-scene] fal.ai error', falErr)
      await admin.from('generations').update({ status: 'failed' }).eq('id', generationId)
      await releaseGenerationCharge({ generationId, reason: 'provider submit failed' })
      return NextResponse.json({ error: 'fal.ai rejected the request' }, { status: 502 })
    }

    await admin
      .from('generations')
      .update({
        settings: {
          fal_endpoint: falEndpoint,
          fal_request_id: requestId,
          aspect_ratio: aspectRatio,
          character_urls: characterUrls ?? [],
          soul_id: hasCharacterRef,
        },
      })
      .eq('id', generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error('[storyboard/generate-scene]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
