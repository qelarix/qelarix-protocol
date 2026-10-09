import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { checkGenerationEpoch } from '@/lib/billing/generationBilling'

interface GenerateContentBody {
  name: string
  niche: string
  personality: string
  platforms: string[]
  language: string
}

interface ContentIdea {
  platform: string
  format: string
  title: string
  caption: string
  hashtags: string[]
  suggestedImagePrompt: string
  videoPrompt?: string
}

interface CalendarEntry {
  day: string
  platform: string
  contentType: string
  title: string
  time: string
}

const PLATFORM_DESCRIPTIONS: Record<string, string> = {
  instagram: 'Instagram (Reels, Carousel post, Story, Static post)',
  tiktok: 'TikTok (short video 15-60s, vertical 9:16 format)',
  youtube: 'YouTube Shorts (vertical, educational or entertaining)',
  twitter: 'Twitter/X (text with image, short video, thread)',
  linkedin: 'LinkedIn (professional content, articles, carousel)',
}

const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
  const gate = await checkGenerationEpoch()
  if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

  let body: GenerateContentBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { name, niche, personality, platforms, language } = body
  if (!name?.trim() || !niche || !platforms?.length) {
    return NextResponse.json({ error: 'name, niche and platforms are required' }, { status: 400 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 500 })
  }

  const platformList = platforms
    .map((p) => `- ${PLATFORM_DESCRIPTIONS[p] || p}`)
    .join('\n')

  const totalIdeas = platforms.length * 2
  const lang = language || 'English'

  const userPrompt = `You are an expert in social media strategy and AI influencer marketing. Create a detailed content plan.

AI INFLUENCER PROFILE:
- Name: ${name}
- Niche: ${niche}
- Personality: ${personality || 'Authentic and motivating'}
- Platforms:
${platformList}
- Content language: ${lang}

TASK: Generate ${totalIdeas} content ideas (2 per platform) and a weekly posting schedule.

RULES:
1. Captions must be written in ${lang}
2. Image prompts must be in ENGLISH (for AI image generation)
3. Hashtags must be relevant to the ${niche} niche
4. Every image prompt must start with "photorealistic portrait of ${name},"

Respond ONLY in JSON format:
{
  "ideas": [
    {
      "platform": "instagram",
      "format": "Reel",
      "title": "idea title",
      "caption": "complete caption with emojis (max 220 characters)",
      "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
      "suggestedImagePrompt": "photorealistic portrait of ${name}, ${niche} influencer, [specific scene, outfit, lighting, setting], professional photography, high quality",
      "videoPrompt": "cinematic video of ${name}, ${niche} influencer, [action, setting, camera movement], smooth motion, professional"
    }
  ],
  "calendar": [
    {
      "day": "Mon",
      "platform": "instagram",
      "contentType": "Reel",
      "title": "short post title",
      "time": "09:00"
    }
  ]
}

Generate EXACTLY ${totalIdeas} ideas and 7 calendar entries for the days: ${WEEK_DAYS.join(', ')}.`

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
        max_tokens: 4096,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!anthropicRes.ok) {
      console.error('[influencer/generate-content] Anthropic error:', await anthropicRes.text())
      return NextResponse.json({ error: 'Failed to generate content' }, { status: 500 })
    }

    const data = await anthropicRes.json()
    const raw = (data.content?.[0]?.text ?? '') as string

    let result: { ideas: ContentIdea[]; calendar: CalendarEntry[] }
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      result = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      console.error('[influencer/generate-content] JSON parse error, raw:', raw.slice(0, 300))
      return NextResponse.json({ error: 'Failed to parse the response' }, { status: 500 })
    }

    if (!Array.isArray(result.ideas) || !Array.isArray(result.calendar)) {
      return NextResponse.json({ error: 'Invalid response format' }, { status: 500 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[influencer/generate-content]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
