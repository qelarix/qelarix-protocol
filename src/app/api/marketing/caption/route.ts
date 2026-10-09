import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationEpoch } from "@/lib/billing/generationBilling"
import Anthropic from "@anthropic-ai/sdk"

const anthropic = new Anthropic()

const PLATFORM_LABELS: Record<string, string> = {
  instagram_reels: "Instagram Reels",
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  linkedin: "LinkedIn",
  facebook: "Facebook",
}

const PLATFORM_HINTS: Record<string, string> = {
  instagram_reels: "Use 3-5 relevant hashtags. Keep it punchy (under 150 chars). Add 1-2 emojis.",
  tiktok: "Short, punchy, trendy. 3-5 hashtags. Max 150 chars.",
  youtube_shorts: "Descriptive title style. 1-2 hashtags. Under 200 chars.",
  linkedin: "Professional tone. No hashtags. One clear value statement. Under 200 chars.",
  facebook: "Friendly and engaging. 1-2 hashtags max. Under 200 chars.",
}

interface CaptionBody {
  platform: string
  adType: string
  productName: string
  productDescription: string
  cta: string
  tone: string
  targetAudience: string
}

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
  const gate = await checkGenerationEpoch()
  if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

  let body: CaptionBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Neispravan request body" }, { status: 400 })
  }

  const { platform, productName, productDescription, cta, tone, targetAudience } = body

  if (!productName?.trim() || !platform) {
    return NextResponse.json({ error: "productName i platform su obavezni" }, { status: 400 })
  }

  const platformLabel = PLATFORM_LABELS[platform] ?? platform
  const hint = PLATFORM_HINTS[platform] ?? "Keep it concise and engaging."

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: `You are a social media copywriter. Write short, engaging captions for marketing videos.
Return only the caption text — no explanation, no quotes, no markdown.`,
      messages: [
        {
          role: "user",
          content: `Write a ${platformLabel} caption for this marketing video.

Product: ${productName}
Description: ${productDescription}
CTA: ${cta}
Tone: ${tone}
Audience: ${targetAudience || "general audience"}

${hint}

Caption:`,
        },
      ],
    })

    const content = message.content[0]
    if (content.type !== "text") throw new Error("Unexpected type")

    return NextResponse.json({ caption: content.text.trim() })
  } catch (err) {
    console.error("[marketing/caption]", err)
    const fallback = `✨ ${productName} — ${productDescription.slice(0, 60)}... ${cta}!`
    return NextResponse.json({ caption: fallback })
  }
}
