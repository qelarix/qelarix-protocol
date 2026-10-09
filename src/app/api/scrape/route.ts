import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationEpoch } from "@/lib/billing/generationBilling"
import Anthropic from "@anthropic-ai/sdk"

const anthropic = new Anthropic()

const PRIVATE_IP = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|localhost|0\.0\.0\.0)/i

function isSafeUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    if (!["http:", "https:"].includes(parsed.protocol)) return false
    if (PRIVATE_IP.test(parsed.hostname)) return false
    return true
  } catch {
    return false
  }
}

function extractMeta(html: string, property: string): string {
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"))?.[1] ??
    ""
  )
}

function extractNameMeta(html: string, name: string): string {
  return (
    html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, "i"))?.[1] ??
    ""
  )
}

export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
  const gate = await checkGenerationEpoch()
  if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

  const url = new URL(req.url).searchParams.get("url") ?? ""

  if (!url) return NextResponse.json({ error: "URL je obavezan" }, { status: 400 })
  if (!isSafeUrl(url)) return NextResponse.json({ error: "Neispravna ili nedozvoljena URL adresa" }, { status: 400 })

  let html: string
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ProductAnalyzer/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    })
    if (!res.ok) {
      return NextResponse.json({ error: `Page is not reachable (HTTP ${res.status})` }, { status: 400 })
    }
    html = await res.text()
  } catch (err) {
    console.error("[scrape] fetch error", err)
    return NextResponse.json({ error: "Could not load the page" }, { status: 400 })
  }

  const ogTitle = extractMeta(html, "og:title")
  const ogDesc = extractMeta(html, "og:description")
  const ogImage = extractMeta(html, "og:image")
  const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? ""
  const metaDesc = extractNameMeta(html, "description")

  const stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000)

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: "You are a product analyst. Extract structured product info from web page content. Return only valid JSON, no markdown.",
      messages: [
        {
          role: "user",
          content: `Analyze this page and extract the product information.

Title: ${ogTitle || pageTitle}
Meta description: ${ogDesc || metaDesc}
Page content: ${stripped}

Return JSON (no markdown wrapper):
{
  "name": "product name",
  "description": "short 1-2 sentence description in the page's language",
  "features": ["feature 1", "feature 2", "feature 3"],
  "price": "price if visible, otherwise null",
  "category": "product category"
}`,
        },
      ],
    })

    const content = message.content[0]
    if (content.type !== "text") throw new Error("Unexpected type")

    let productInfo: {
      name: string
      description: string
      features: string[]
      price: string | null
      category: string
    }
    try {
      productInfo = JSON.parse(content.text.trim())
    } catch {
      productInfo = {
        name: ogTitle || pageTitle || "Produkt",
        description: ogDesc || metaDesc || "",
        features: [],
        price: null,
        category: "Ostalo",
      }
    }

    return NextResponse.json({
      product: {
        ...productInfo,
        imageUrl: ogImage || null,
      },
    })
  } catch (err) {
    console.error("[scrape] model error", err)
    return NextResponse.json({
      product: {
        name: ogTitle || pageTitle || "Produkt",
        description: ogDesc || metaDesc || "",
        features: [],
        price: null,
        category: "Ostalo",
        imageUrl: ogImage || null,
      },
    })
  }
}
