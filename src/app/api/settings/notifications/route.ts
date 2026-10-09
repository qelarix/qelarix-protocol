import { NextRequest, NextResponse } from "next/server"
import { getServerAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export async function PATCH(req: NextRequest) {
  try {
    const authUser = await getServerAuthUser()
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await req.json()) as {
      notification_email_generation?: boolean
      notification_email_credits?: boolean
      notification_email_newsletter?: boolean
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin.from("profiles") as any)
      .update({
        notification_email_generation: Boolean(body.notification_email_generation ?? true),
        notification_email_credits: Boolean(body.notification_email_credits ?? true),
        notification_email_newsletter: Boolean(body.notification_email_newsletter ?? false),
        updated_at: new Date().toISOString(),
      })
      .eq("id", authUser.id)

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[settings/notifications]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
