import { NextResponse } from "next/server"
import { getServerAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const authUser = await getServerAuthUser()
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const admin = createSupabaseAdmin()
    const { data, error } = await admin
      .from("credit_transactions")
      .select("id, amount, type, description, created_at")
      .eq("user_id", authUser.id)
      .order("created_at", { ascending: false })
      .limit(10)

    if (error) throw error

    return NextResponse.json({ transactions: data ?? [] })
  } catch (err) {
    console.error("[settings/transactions]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
