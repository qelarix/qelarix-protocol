import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface CharacterBody {
  name: string
  description?: string
  referenceImages?: string[]
  generatedImageUrl?: string
  style?: string
  outfit?: string
  background?: string
  pose?: string
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const admin: AdminAny = createSupabaseAdmin()
    const { data, error } = await admin
      .from("characters")
      .select("*")
      .eq("user_id", authUser.id)
      .order("created_at", { ascending: false })

    if (error) {
      console.error("[character/GET]", error)
      return NextResponse.json({ error: "Failed to load characters" }, { status: 500 })
    }

    return NextResponse.json({ characters: data ?? [] })
  } catch (err) {
    console.error("[character/GET]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await req.json()) as CharacterBody
    const { name, description, referenceImages, generatedImageUrl, style, outfit, background, pose } = body

    if (!name?.trim()) {
      return NextResponse.json({ error: "Character name is required" }, { status: 400 })
    }

    // Build reference_images: generated image first, then user uploads
    const images: string[] = []
    if (generatedImageUrl) images.push(generatedImageUrl)
    if (referenceImages?.length) {
      for (const url of referenceImages) {
        if (url && !images.includes(url)) images.push(url)
      }
    }

    // Store extra generation fields in description as JSON
    const descriptionData = JSON.stringify({
      text: description ?? "",
      style: style ?? "Realistic",
      outfit: outfit ?? "",
      background: background ?? "",
      pose: pose ?? "",
    })

    const admin: AdminAny = createSupabaseAdmin()
    const { data, error } = await admin
      .from("characters")
      .insert({
        user_id: authUser.id,
        name: name.trim(),
        description: descriptionData,
        reference_images: images,
        type: "character",
      })
      .select("*")
      .single()

    if (error) {
      console.error("[character/POST]", error)
      return NextResponse.json({ error: "Failed to save character" }, { status: 500 })
    }

    return NextResponse.json({ character: data }, { status: 201 })
  } catch (err) {
    console.error("[character/POST]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
