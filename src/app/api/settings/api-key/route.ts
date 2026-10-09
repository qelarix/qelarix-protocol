import { NextRequest, NextResponse } from "next/server"
import { getServerAuthUser } from "@/lib/authSession"
import { createHash, randomBytes } from "crypto"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { hasFeature } from "@/lib/plans"
import type { PlanId } from "@/lib/plans"

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function POST(_: NextRequest) {
  try {
    const authUser = await getServerAuthUser()
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const plan = (authUser.plan ?? "free") as PlanId
    if (!hasFeature(plan, "api")) {
      return NextResponse.json(
        { error: "API access is not available on your plan" },
        { status: 403 }
      )
    }

    const raw = randomBytes(32).toString("hex")
    const apiKey = `sk-plt-${raw}`
    const keyPrefix = `sk-plt-${raw.slice(0, 8)}...`
    const keyHash = createHash("sha256").update(apiKey).digest("hex")

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin.from("profiles") as any)
      .update({
        api_key_hash: keyHash,
        api_key_prefix: keyPrefix,
        updated_at: new Date().toISOString(),
      })
      .eq("id", authUser.id)

    if (error) throw error

    return NextResponse.json({ apiKey, keyPrefix })
  } catch (err) {
    console.error("[settings/api-key POST]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function DELETE(_: NextRequest) {
  try {
    const authUser = await getServerAuthUser()
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin.from("profiles") as any)
      .update({
        api_key_hash: null,
        api_key_prefix: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", authUser.id)

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[settings/api-key DELETE]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
