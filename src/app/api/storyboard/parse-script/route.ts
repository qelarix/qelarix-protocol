import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { checkGenerationEpoch } from '@/lib/billing/generationBilling'

interface ParseScriptBody {
  script: string
  style?: string
  aspectRatio?: string
}

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
  const gate = await checkGenerationEpoch()
  if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

  let body: ParseScriptBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { script, style, aspectRatio } = body
  if (!script?.trim()) {
    return NextResponse.json({ error: 'Skripta je obavezna' }, { status: 400 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 })
  }

  const systemPrompt = `You are a professional film assistant and storyboard artist.
You parse film/video scripts into structured storyboard scenes with consistent characters.
Every scene must have a detailed visual prompt for AI image generation.
Identify every character that appears in each scene.
Always respond ONLY with valid JSON, without any additional text.`

  const userPrompt = `Parse the following script into a complete storyboard:

SCRIPT:
${script}

Production style: ${style ?? 'cinematic, realistic'}
Video format: ${aspectRatio ?? '16:9'}

Generate between 5 and 20 scenes depending on the script length.
For every scene write a detailed visualPrompt in ENGLISH that the FLUX image model can use.
Find every character in the script and list them in each scene's characters array.

Return JSON in this EXACT format (JSON only, no text before or after):
{
  "title": "project title",
  "totalDuration": 120,
  "genre": "genre / content type",
  "colorPalette": "color palette description",
  "characters": [
    {
      "name": "character name",
      "description": "detailed physical description: age, appearance, clothing, traits",
      "role": "lead / supporting / antagonist / etc."
    }
  ],
  "scenes": [
    {
      "id": 1,
      "title": "scene title",
      "description": "short description of what happens in the scene",
      "visualPrompt": "detailed cinematic prompt in English for AI image generation: camera angle, lighting, characters, setting, mood, style",
      "dialogue": "dialogue or narration from the script (or an empty string)",
      "duration": 5,
      "cameraAngle": "e.g. close-up, wide shot, over-the-shoulder, bird's-eye view",
      "mood": "e.g. tense, joyful, mysterious, dramatic",
      "transition": "e.g. cut, dissolve, fade to black, smash cut",
      "characters": ["Character name 1", "Character name 2"]
    }
  ]
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
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text()
      console.error('[storyboard/parse-script] Anthropic error:', err)
      return NextResponse.json({ error: 'Failed to parse the script' }, { status: 500 })
    }

    const data = await anthropicRes.json()
    const raw = data.content?.[0]?.text ?? ''

    let storyboard
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      storyboard = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      console.error('[storyboard/parse-script] JSON parse error, raw:', raw.slice(0, 500))
      return NextResponse.json({ error: 'Failed to parse the JSON response' }, { status: 500 })
    }

    // Ensure each scene has a characters array
    if (Array.isArray(storyboard.scenes)) {
      storyboard.scenes = storyboard.scenes.map((scene: Record<string, unknown>) => ({
        ...scene,
        characters: Array.isArray(scene.characters) ? scene.characters : [],
      }))
    }
    if (!Array.isArray(storyboard.characters)) {
      storyboard.characters = []
    }

    return NextResponse.json({ storyboard })
  } catch (err) {
    console.error('[storyboard/parse-script]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
