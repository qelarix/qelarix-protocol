import { NextRequest, NextResponse } from "next/server"
import { getServerAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { hasFeature } from "@/lib/plans"
import type { PlanId } from "@/lib/plans"

export async function PATCH(req: NextRequest) {
  try {
    const authUser = await getServerAuthUser()
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const plan = (authUser.plan ?? "free") as PlanId
    if (!hasFeature(plan, "makecom")) {
      return NextResponse.json(
        { error: "Webhook integration is not available on your plan" },
        { status: 403 }
      )
    }

    const { webhookUrl } = (await req.json()) as { webhookUrl?: string }

    if (webhookUrl && !webhookUrl.startsWith("https://")) {
      return NextResponse.json(
        { error: "Webhook URL must use HTTPS" },
        { status: 400 }
      )
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin.from("profiles") as any)
      .update({
        webhook_url: webhookUrl || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", authUser.id)

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[settings/webhook]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
