import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface RouteParams {
  params: { id: string }
}

interface CharacterUpdateBody {
  name?: string
  description?: string
  referenceImages?: string[]
  generatedImageUrl?: string
  style?: string
  outfit?: string
  background?: string
  pose?: string
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = params
    const body = (await req.json()) as CharacterUpdateBody

    const admin: AdminAny = createSupabaseAdmin()

    // Verify ownership
    const { data: existing } = await admin
      .from("characters")
      .select("id, user_id")
      .eq("id", id)
      .single()

    if (!existing || existing.user_id !== authUser.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const update: Record<string, unknown> = {}

    if (body.name?.trim()) update.name = body.name.trim()

    if (
      body.description !== undefined ||
      body.style !== undefined ||
      body.outfit !== undefined ||
      body.background !== undefined ||
      body.pose !== undefined
    ) {
      update.description = JSON.stringify({
        text: body.description ?? "",
        style: body.style ?? "Realistic",
        outfit: body.outfit ?? "",
        background: body.background ?? "",
        pose: body.pose ?? "",
      })
    }

    if (body.referenceImages !== undefined || body.generatedImageUrl !== undefined) {
      const images: string[] = []
      if (body.generatedImageUrl) images.push(body.generatedImageUrl)
      if (body.referenceImages?.length) {
        for (const url of body.referenceImages) {
          if (url && !images.includes(url)) images.push(url)
        }
      }
      update.reference_images = images
    }

    const { data, error } = await admin
      .from("characters")
      .update(update)
      .eq("id", id)
      .select("*")
      .single()

    if (error) {
      console.error("[character/PUT]", error)
      return NextResponse.json({ error: "Failed to update character" }, { status: 500 })
    }

    return NextResponse.json({ character: data })
  } catch (err) {
    console.error("[character/PUT]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = params
    const admin: AdminAny = createSupabaseAdmin()

    // Verify ownership
    const { data: existing } = await admin
      .from("characters")
      .select("id, user_id")
      .eq("id", id)
      .single()

    if (!existing || existing.user_id !== authUser.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const { error } = await admin.from("characters").delete().eq("id", id)

    if (error) {
      console.error("[character/DELETE]", error)
      return NextResponse.json({ error: "Failed to delete character" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[character/DELETE]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
