import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { checkGenerationEpoch } from '@/lib/billing/generationBilling'

interface GenerateScriptBody {
  topic: string
  platform: 'instagram' | 'tiktok' | 'youtube' | 'twitter'
  style: string
  language: string
  duration: number
}


export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
  const gate = await checkGenerationEpoch()
  if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

  let body: GenerateScriptBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { topic, platform, style, language, duration } = body
  if (!topic || !platform) {
    return NextResponse.json({ error: 'Topic i platform su obavezni' }, { status: 400 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 })
  }

  const sceneCount = Math.max(3, Math.floor((duration || 30) / 5))
  const platformGuidelines: Record<string, string> = {
    instagram: 'Instagram Reels: vertical 9:16 format, fast pacing, hook within the first 2 seconds',
    tiktok: 'TikTok: vertical 9:16 format, energetic style, trending sounds',
    youtube: 'YouTube Shorts: vertical 9:16 format, educational tone, clearly structured',
    twitter: 'Twitter/X video: short and informative, horizontal or square format',
  }

  const systemPrompt = `You are an expert in short-form video content (Shorts/Reels/TikTok).
Generate professional scripts optimized for social media platforms.
Always respond in JSON format.`

  const userPrompt = `Generate a script for a short video about: "${topic}"

Platform: ${platform}
${platformGuidelines[platform] || ''}
Style: ${style || 'educational and engaging'}
Script language: ${language || 'English'}
Number of scenes: ${sceneCount}

Return JSON in this format:
{
  "title": "video title",
  "hook": "attention-grabbing opening (1-2 sentences)",
  "description": "video description for the platform (max 150 characters)",
  "hashtags": ["#tag1", "#tag2", "#tag3"],
  "scenes": [
    {
      "id": 1,
      "description": "visual description of the scene",
      "voiceover": "narration or dialogue text",
      "duration": 5,
      "cameraAngle": "e.g. close-up, wide shot, aerial",
      "transition": "e.g. cut, fade, zoom"
    }
  ],
  "callToAction": "call to action at the end of the video"
}`

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text()
      console.error('Anthropic API error:', err)
      return NextResponse.json({ error: 'Failed to generate the script' }, { status: 500 })
    }

    const data = await anthropicRes.json()
    const raw = data.content?.[0]?.text ?? ''

    let script
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      script = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      return NextResponse.json({ error: 'Failed to parse the script' }, { status: 500 })
    }

    return NextResponse.json({ script })
  } catch (err) {
    console.error('Shorts generate-script error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
