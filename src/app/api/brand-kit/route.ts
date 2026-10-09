import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { PLANS, PLAN_GATING_ENABLED } from "@/lib/plans"
import type { PlanId } from "@/lib/plans"
import type { BrandKit } from "@/types/database"

const MAX_KITS: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 3,
  business: Infinity,
  ultra: Infinity,
}

export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any
  const { data: kits, error } = await supabase
    .from("brand_kits")
    .select("*")
    .eq("user_id", authUser.id)
    .order("created_at", { ascending: false }) as { data: BrandKit[] | null; error: unknown }

  if (error) return NextResponse.json({ error: String(error) }, { status: 500 })
  return NextResponse.json({ kits: kits ?? [] })
}

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const userId = authUser.id
  const plan = (authUser.plan as PlanId) ?? "free"
  const maxKits = PLAN_GATING_ENABLED ? (MAX_KITS[plan] ?? 0) : Infinity

  if (maxKits === 0) return NextResponse.json({ error: "Brand kits require Starter+ plan" }, { status: 403 })

  let body: {
    name: string
    logo_url?: string | null
    primary_color?: string | null
    secondary_color?: string | null
    font?: string | null
    style_description?: string | null
    is_default?: boolean
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }) }
  if (!body.name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseAdmin() as any

  const { count } = await supabase
    .from("brand_kits")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId) as { count: number | null }

  if (maxKits !== Infinity && (count ?? 0) >= maxKits) {
    const planLabel = PLANS[plan] ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Your"
    return NextResponse.json({
      error: `${planLabel} plan allows max ${maxKits} brand kit${maxKits !== 1 ? "s" : ""}. Upgrade to add more.`,
    }, { status: 403 })
  }

  if (body.is_default) {
    await supabase.from("brand_kits").update({ is_default: false }).eq("user_id", userId)
  }

  const { data: kit, error } = await supabase
    .from("brand_kits")
    .insert({
      user_id: userId,
      name: body.name.trim(),
      logo_url: body.logo_url ?? null,
      primary_color: body.primary_color ?? "#7B61FF",
      secondary_color: body.secondary_color ?? "#3BE7FF",
      font: body.font ?? "Inter",
      style_description: body.style_description ?? null,
      is_default: body.is_default ?? false,
    })
    .select()
    .single() as { data: BrandKit | null; error: unknown }

  if (error) return NextResponse.json({ error: String(error) }, { status: 500 })
  return NextResponse.json({ kit })
}
