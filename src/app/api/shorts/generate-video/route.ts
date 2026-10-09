import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { CREDITS } from '@/lib/credits'
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from '@/lib/billing/generationBilling'
import { fal } from '@fal-ai/client'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

// SAFETY FLAG (2026-06): paid Shorts video is DISABLED until a real completion + assembly path exists.
// The implementation below submits per-scene fal jobs and deducts 200/400 credits, but there is no status
// poller and no scene/voiceover assembly — so the user would be charged for an undelivered short. While
// false, the route returns "coming soon" BEFORE any credit check, deduction, or generations insert.
// Flip to true ONLY once completion + assembly are implemented.
const SHORTS_VIDEO_ENABLED = false

const CREDITS_30S = CREDITS.shorts.video_30s
const CREDITS_60S = CREDITS.shorts.video_60s
const WAN_ENDPOINT = 'fal-ai/wan/v2.1/t2v'

interface SceneInput {
  id: number
  description: string
  voiceover: string
  duration: number
  cameraAngle: string
  transition: string
}

interface GenerateVideoBody {
  scenes: SceneInput[]
  platform: string
  voiceGender: string
  voiceTone: string
  totalDuration: number
}

function buildScenePrompt(scene: SceneInput, platform: string): string {
  return [
    scene.description,
    `${scene.cameraAngle} shot`,
    `vertical 9:16 short-form video for ${platform}`,
    'high quality, cinematic, social media style',
    'no text, no watermark',
  ]
    .filter(Boolean)
    .join('. ')
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Guard: return "coming soon" BEFORE any credit check, deduction, or generations insert (see flag above).
    if (!SHORTS_VIDEO_ENABLED) {
      return NextResponse.json(
        { error: 'Video assembly coming soon', comingSoon: true },
        { status: 503 },
      )
    }

    const isAdmin = isInternalUser(authUser)

    const body = (await req.json()) as GenerateVideoBody
    const { scenes, platform, totalDuration } = body

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return NextResponse.json({ error: 'No scenes to generate' }, { status: 400 })
    }

    const creditCost = totalDuration <= 30 ? CREDITS_30S : CREDITS_60S

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createSupabaseAdmin() as any

    // ── Balance check, then the charge before any provider submission (QLC billing; no-op in credits mode) ──
    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })
    const generationId = randomUUID()
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
    if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })

    if (!process.env.FAL_KEY) {
      // Mock mode — deduct credits and return success
      console.warn('[shorts/generate-video] FAL_KEY is not set — mock mode')

      await settleGenerationCharge({
        user: authUser, generationId, credits: creditCost, exempt: isAdmin, once: 'this-request',
        description: `Shorts video (${totalDuration}s, ${scenes.length} scena) — mock`,
      })

      await admin.from('generations').insert({
        id: generationId,
        user_id: authUser.id,
        type: 'video',
        model: 'shorts_wan26',
        prompt: scenes[0]?.description ?? 'Shorts video',
        status: 'completed',
        credits_used: creditCost,
        settings: {
          platform,
          scene_count: scenes.length,
          total_duration: totalDuration,
          mock: true,
        },
      })

      return NextResponse.json({ success: true, mock: true })
    }

    // ── Submit all scenes to fal.ai queue (async) ──
    const requestIds: string[] = []

    for (const scene of scenes) {
      const prompt = buildScenePrompt(scene, platform)
      const sceneDuration = Math.min(Math.max(scene.duration, 3), 8)

      try {
        const queued = await fal.queue.submit(WAN_ENDPOINT, {
          input: {
            prompt,
            negative_prompt: 'blurry, low quality, shaky, distorted, watermark, text overlay, logo',
            aspect_ratio: '9:16',
            duration: sceneDuration,
          },
        })
        requestIds.push(queued.request_id)
      } catch (falErr) {
        console.error(`[shorts/generate-video] fal.ai scene ${scene.id} error:`, falErr)
        // Continue submitting other scenes even if one fails
      }
    }

    if (requestIds.length === 0) {
      await releaseGenerationCharge({ generationId, reason: 'no scene could be submitted' })
      return NextResponse.json(
        { error: 'Could not start the video generation. Please try again.' },
        { status: 502 },
      )
    }

    // ── Charge only after successful submission ──
    await settleGenerationCharge({
      user: authUser, generationId, credits: creditCost, exempt: isAdmin, once: 'this-request',
      description: `Shorts video (${totalDuration}s, ${scenes.length} scena)`,
    })

    // ── Save generation record ──
    await admin.from('generations').insert({
      id: generationId,
      user_id: authUser.id,
      type: 'video',
      model: 'shorts_wan26',
      prompt: scenes[0]?.description ?? 'Shorts video',
      status: 'pending',
      credits_used: creditCost,
      settings: {
        platform,
        scene_count: scenes.length,
        total_duration: totalDuration,
        fal_endpoint: WAN_ENDPOINT,
        fal_request_ids: requestIds,
      },
    })

    return NextResponse.json({
      success: true,
      scenesQueued: requestIds.length,
      totalScenes: scenes.length,
    })
  } catch (err) {
    console.error('[shorts/generate-video]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
