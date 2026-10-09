import { NextRequest, NextResponse } from "next/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const tab    = searchParams.get("tab")    ?? "newest"
  const type   = searchParams.get("type")   ?? "all"
  const model  = searchParams.get("model")  ?? ""
  const search = searchParams.get("search") ?? ""
  const page   = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10))
  const limit  = 24

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any

  let query = supabase
    .from('generations')
    .select('id, type, model, prompt, output_url, likes_count, views_count, created_at, settings, user_id')
    .eq('is_public', true)
    .eq('status', 'completed')

  if (type !== "all") query = query.eq("type", type)
  if (model) query = query.eq("model", model)
  if (search) query = query.ilike("prompt", `%${search}%`)

  if (tab === "trending") {
    query = query.order("likes_count", { ascending: false }).order("created_at", { ascending: false })
  } else {
    query = query.order("created_at", { ascending: false })
  }

  query = query.range(page * limit, (page + 1) * limit - 1)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await query
  if (error) return NextResponse.json({ items: [] })

  // Load the profiles for every user_id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userIds = Array.from(new Set((rows || []).map((r: any) => r.user_id)))
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', userIds)

  const profileMap = Object.fromEntries(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (profiles || []).map((p: any) => [p.id, p])
  )

  // Kombiniraj
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (rows || []).map((row: any) => {
    let url = row.output_url
    try {
      const parsed = JSON.parse(row.output_url || '')
      url = Array.isArray(parsed) ? parsed[0] : row.output_url
    } catch { }

    return {
      ...row,
      output_url: url,
      url,
      profile: profileMap[row.user_id] || null,
      username: profileMap[row.user_id]?.username || 'Creator',
      avatar_url: profileMap[row.user_id]?.avatar_url || null,
      liked_by_user: false,
    }
  })

  return NextResponse.json({ items, total: items.length })
}
