import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import type { BrandKit } from "@/types/database"

type KitMeta = { id: string; user_id: string; logo_url: string | null }

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = params
  if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 })

  let body: {
    name?: string
    logo_url?: string | null
    primary_color?: string | null
    secondary_color?: string | null
    font?: string | null
    style_description?: string | null
    is_default?: boolean
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any

  const { data: existing } = await supabase
    .from("brand_kits")
    .select("id, user_id, logo_url")
    .eq("id", id)
    .single() as { data: KitMeta | null }

  if (!existing || existing.user_id !== authUser.id) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (body.is_default) {
    await supabase.from("brand_kits").update({ is_default: false }).eq("user_id", authUser.id)
  }

  const update: Record<string, unknown> = {}
  if (body.name !== undefined) update.name = body.name.trim()
  if (body.logo_url !== undefined) update.logo_url = body.logo_url
  if (body.primary_color !== undefined) update.primary_color = body.primary_color
  if (body.secondary_color !== undefined) update.secondary_color = body.secondary_color
  if (body.font !== undefined) update.font = body.font
  if (body.style_description !== undefined) update.style_description = body.style_description
  if (body.is_default !== undefined) update.is_default = body.is_default

  const { data: kit, error } = await supabase
    .from("brand_kits")
    .update(update)
    .eq("id", id)
    .select()
    .single() as { data: BrandKit | null; error: unknown }

  if (error) return NextResponse.json({ error: String(error) }, { status: 500 })
  return NextResponse.json({ kit })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = params
  if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any

  const { data: existing } = await supabase
    .from("brand_kits")
    .select("id, user_id, logo_url")
    .eq("id", id)
    .single() as { data: KitMeta | null }

  if (!existing || existing.user_id !== authUser.id) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("brand_kits").delete().eq("id", id)
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 })

  if (existing.logo_url?.includes("/storage/v1/")) {
    const path = existing.logo_url.split("/storage/v1/object/public/media/")[1]
    if (path) await supabase.storage.from("media").remove([path])
  }

  return NextResponse.json({ success: true })
}
