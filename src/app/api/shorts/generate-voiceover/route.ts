import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { CREDITS } from '@/lib/credits'
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from '@/lib/billing/generationBilling'
import { isInternalUser } from "@/lib/planAccess"

const VOICEOVER_CREDIT_COST = CREDITS.shorts.voiceover

interface GenerateVoiceoverBody {
  scenes: string[]
  voiceGender: 'male' | 'female'
  voiceTone: string
  language: string
}

// ElevenLabs voice IDs mapped by gender + tone
const VOICE_MAP: Record<string, Record<string, string>> = {
  female: {
    Professional: '21m00Tcm4TlvDq8ikWAM', // Rachel
    Friendly: 'AZnzlk1XvdvUeBnXmlld',      // Domi
    Energetic: 'EXAVITQu4vr4xnSDxMaL',     // Bella
    Calm: 'ThT5KcBeYPX3keUQqHPh',           // Dorothy
    Dramatic: 'jsCqWAovK2LkecY7zXl4',      // Freya
  },
  male: {
    Professional: 'TxGEqnHWrfWFTfGW9XjX',  // Josh
    Friendly: 'VR6AewLTigWG4xSOukaG',       // Arnold
    Energetic: 'pNInz6obpgDQGcFmaJgB',      // Adam
    Calm: 'yoZ06aMxZJJ28mfd3POQ',           // Sam
    Dramatic: 'ODq5zmih8GrVes37Dx0d',        // Patrick
  },
}

function getToneSettings(tone: string) {
  switch (tone) {
    case 'Energetic': return { stability: 0.4, similarity_boost: 0.75, style: 0.75 }
    case 'Dramatic':  return { stability: 0.3, similarity_boost: 0.80, style: 0.80 }
    case 'Calm':      return { stability: 0.75, similarity_boost: 0.70, style: 0.15 }
    case 'Friendly':  return { stability: 0.6, similarity_boost: 0.75, style: 0.35 }
    default:          return { stability: 0.65, similarity_boost: 0.75, style: 0.20 }
  }
}

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const isAdmin = isInternalUser(authUser)

  let body: GenerateVoiceoverBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { scenes, voiceGender, voiceTone, language } = body

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return NextResponse.json({ error: 'No scenes for the voiceover' }, { status: 400 })
  }

  const apiKey = process.env.ELEVENLABS_API_KEY

  if (!apiKey) {
    // Dev/mock mode — return success without charging credits
    console.warn('[shorts/generate-voiceover] ELEVENLABS_API_KEY is not set — mock mode')
    return NextResponse.json({ success: true, mock: true, audioData: null })
  }

  // ── Balance check, then the charge before the provider runs (QLC billing; no-op in credits mode) ──
  // The voiceover has no generations row; the id only keys its charge.
  const funds = await checkGenerationFunds({ user: authUser, credits: VOICEOVER_CREDIT_COST, exempt: isAdmin })
  if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })
  const generationId = randomUUID()
  const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: VOICEOVER_CREDIT_COST, exempt: isAdmin })
  if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })

  const fullText = scenes
    .filter(Boolean)
    .join(' ... ')
    .slice(0, 5000) // ElevenLabs limit

  const voiceId =
    VOICE_MAP[voiceGender]?.[voiceTone] ?? VOICE_MAP.female.Professional

  const voiceSettings = getToneSettings(voiceTone)

  try {
    const elRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: fullText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            ...voiceSettings,
            use_speaker_boost: true,
          },
          language_code: language?.startsWith('Bosanski') ? 'hr' : undefined,
        }),
      },
    )

    if (!elRes.ok) {
      const errText = await elRes.text().catch(() => '')
      console.error('[shorts/generate-voiceover] ElevenLabs error:', elRes.status, errText)
      await releaseGenerationCharge({ generationId, reason: 'provider failed' })
      return NextResponse.json(
        { error: 'Voiceover generation failed. Please try again.' },
        { status: 500 },
      )
    }

    // Charge only on success
    await settleGenerationCharge({
      user: authUser, generationId, credits: VOICEOVER_CREDIT_COST, exempt: isAdmin, once: 'this-request',
      description: `Shorts voiceover — ${voiceGender} ${voiceTone}`,
    })

    // Return audio as base64 data URL for in-browser playback
    const audioBuffer = await elRes.arrayBuffer()
    const base64 = Buffer.from(audioBuffer).toString('base64')

    return NextResponse.json({
      success: true,
      audioData: `data:audio/mpeg;base64,${base64}`,
    })
  } catch (err) {
    console.error('[shorts/generate-voiceover]', err)
    await releaseGenerationCharge({ generationId, reason: 'unexpected error' }).catch(() => {})
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
