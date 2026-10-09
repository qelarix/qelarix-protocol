import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const userId = authUser.id

  let body: { generation_id: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const { generation_id } = body
  if (!generation_id) return NextResponse.json({ error: "generation_id required" }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any

  const { data: existing } = await supabase
    .from("likes")
    .select("user_id")
    .eq("user_id", userId)
    .eq("generation_id", generation_id)
    .maybeSingle() as { data: { user_id: string } | null }

  if (existing) {
    await supabase.from("likes").delete().eq("user_id", userId).eq("generation_id", generation_id)
    const { data: gen } = await supabase
      .from("generations")
      .select("likes")
      .eq("id", generation_id)
      .single() as { data: { likes: number } | null }
    const newCount = Math.max(0, (gen?.likes ?? 1) - 1)
    await supabase.from("generations").update({ likes: newCount }).eq("id", generation_id)
    return NextResponse.json({ liked: false, likes: newCount })
  } else {
    await supabase.from("likes").insert({ user_id: userId, generation_id })
    const { data: gen } = await supabase
      .from("generations")
      .select("likes")
      .eq("id", generation_id)
      .single() as { data: { likes: number } | null }
    const newCount = (gen?.likes ?? 0) + 1
    await supabase.from("generations").update({ likes: newCount }).eq("id", generation_id)
    return NextResponse.json({ liked: true, likes: newCount })
  }
}
