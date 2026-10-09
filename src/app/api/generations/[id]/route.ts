import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    const { error } = await adminAny
      .from("generations")
      .delete()
      .eq("id", params.id)
      .eq("user_id", authUser.id)

    if (error) {
      console.error("[generations/delete]", error)
      return NextResponse.json({ error: "Failed to delete" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[generations/delete]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
