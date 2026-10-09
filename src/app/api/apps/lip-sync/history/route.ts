import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

// Lip Sync model ids — mirrors LIP_SYNC_MODELS (apps/lip-sync/page.tsx) and MODEL_CONFIG
// (api/generate/lip-sync/route.ts). Used ONLY to scope deletes so this route can never remove
// another tool's generation row, even if an output_url somehow matched.
const LIP_SYNC_MODEL_IDS = [
  "latentsync",
  "wav2lip-hd",
  "musetalk",
  "ditto",
  "hedra",
  "infinite-talk",
  "ltx-lipsync",
  "video-retalking",
  "sadtalker",
  "kling-lipsync",
  "kling-avatar-v2-standard",
  "kling-avatar-v2-pro",
  "sync-lipsync-2-pro",
]

// DELETE /api/apps/lip-sync/history  body: { outputUrl: string }
// Minimal, authenticated, app-scoped delete that mirrors the existing /api/generations/[id] style.
// We match by output_url (not row id) because in-session history items don't yet carry the DB row id,
// and output_url is already the unique key the client dedupes history by. Hard-deletes the DB record
// ONLY (no storage-file removal — same as the platform's existing generations delete).
export async function DELETE(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await req.json().catch(() => ({}))) as { outputUrl?: string }
    const outputUrl = typeof body.outputUrl === "string" ? body.outputUrl.trim() : ""
    if (!outputUrl) {
      return NextResponse.json({ error: "Missing outputUrl" }, { status: 400 })
    }

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    // Scoped to: this user's own row + exact output_url + Lip Sync models only.
    const { error } = await adminAny
      .from("generations")
      .delete()
      .eq("user_id", authUser.id)
      .eq("output_url", outputUrl)
      .in("model", LIP_SYNC_MODEL_IDS)

    if (error) {
      console.error("[apps/lip-sync/history/delete]", error)
      return NextResponse.json({ error: "Failed to delete" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[apps/lip-sync/history/delete]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
