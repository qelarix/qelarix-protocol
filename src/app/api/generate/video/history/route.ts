import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get("limit") ?? "50")

    const { data, error } = await adminAny
      .from("generations")
      .select("id, model, prompt, output_url, created_at, settings")
      .eq("user_id", authUser.id)
      .eq("type", "video")
      .eq("status", "completed")
      .not("output_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) {
      console.error("[video/history] db error", error)
      return NextResponse.json({ error: "Could not load history" }, { status: 500 })
    }

    return NextResponse.json({ generations: data ?? [] })
  } catch (err) {
    console.error("[video/history]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
