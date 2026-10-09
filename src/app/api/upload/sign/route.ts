import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { recordStorageAsset } from "@/lib/storageUsage"

// ── Signed DIRECT-to-storage upload (Video Tools) ───────────────────────────────────────────────
// Large video files cannot pass through a Next API route on Vercel (FUNCTION_PAYLOAD_TOO_LARGE,
// ~4.5MB body cap). This route never sees the file: it only authorizes one upload — the client
// PUTs the file straight to Supabase Storage using the returned signed URL, then uses publicUrl.
// Existing `media` bucket (public-read, same as /api/upload); service-role token authorizes the
// PUT, so NO bucket/policy/RLS change is needed.

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"]
const MAX_VIDEO_SIZE = 100 * 1024 * 1024 // 100MB — matches the Video Tools UI copy
// Image inputs added for the Edit Tools recovery (inpaint/face-swap/outfit/bg-remove/expand/upscale/relight
// + the inpaint mask PNG). Same signed → generations flow; video support is unchanged.
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
// Audio inputs added for the Lip Sync recovery (uploaded voice tracks). Same signed → generations flow.
const ALLOWED_AUDIO_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg",
]
const MAX_AUDIO_SIZE = 20 * 1024 * 1024 // 20MB

// Bucket truth (verified via listBuckets 2026-06-13): this Supabase project has NO "media" bucket —
// /api/upload's "media" target does not exist (its uploads 404 too; separate pre-existing issue).
// We use the EXISTING public "generations" bucket (the platform's proven video bucket — all output
// URLs are served from it) under a distinct uploads/ prefix so source files never collide with outputs.
const UPLOAD_BUCKET = "generations"

interface SignBody {
  filename?: string
  contentType?: string
  sizeBytes?: number
}

// Make any original filename safe for a Supabase Storage object key (and for the resulting public URL).
// Real files arrive with spaces, parentheses, accents, etc. (e.g. "wir-schaffen-das-zusammen-(pixi-remake).mp3"),
// which can break the storage key / URL. We slug the base name → lowercase, spaces→dash, drop everything
// except a-z 0-9 . _ -, collapse repeated dashes, trim separators. Extension is handled separately.
function slugifyBase(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // fold accents (ä→a) instead of dropping them
    .replace(/\s+/g, "-")          // spaces → hyphen
    .replace(/[^a-z0-9._-]/g, "")  // drop parentheses and any other unsafe char
    .replace(/-+/g, "-")           // collapse repeated dashes
    .replace(/^[-._]+|[-._]+$/g, "") // trim leading/trailing separators
    .slice(0, 64)                  // cap length
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const userId = authUser.id

    const body = (await req.json().catch(() => ({}))) as SignBody
    const contentType = body.contentType ?? ""
    const sizeBytes = Number(body.sizeBytes)

    const isVideo = ALLOWED_VIDEO_TYPES.includes(contentType)
    const isImage = ALLOWED_IMAGE_TYPES.includes(contentType)
    const isAudio = ALLOWED_AUDIO_TYPES.includes(contentType)
    const assetType = isVideo ? "video" : isAudio ? "audio" : "image"
    if (!isVideo && !isImage && !isAudio) {
      return NextResponse.json({ error: "Unsupported file type. Use MP4, MOV, WebM, PNG, JPEG, WebP or MP3, WAV, AAC, OGG." }, { status: 400 })
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return NextResponse.json({ error: "sizeBytes is required." }, { status: 400 })
    }
    const maxSize = isVideo ? MAX_VIDEO_SIZE : isAudio ? MAX_AUDIO_SIZE : MAX_IMAGE_SIZE
    if (sizeBytes > maxSize) {
      const maxLabel = isVideo ? "100MB" : isAudio ? "20MB" : "10MB"
      return NextResponse.json({ error: `File too large. Max ${maxLabel}.` }, { status: 400 })
    }

    const originalFilename = body.filename ?? ""
    const ext = originalFilename.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || (isVideo ? "mp4" : isAudio ? "mp3" : "png")
    // Sanitize the original base name (everything before the final dot) into a URL-safe slug, then add a
    // timestamp + random for uniqueness. Even an all-unsafe name (e.g. "(((...)))") falls back to "file".
    const dotIdx = originalFilename.lastIndexOf(".")
    const rawBase = dotIdx > 0 ? originalFilename.slice(0, dotIdx) : originalFilename
    const safeBase = slugifyBase(rawBase) || "file"
    // Distinct namespaces per kind: video sources, audio inputs, image edit inputs.
    const prefix = isVideo ? "uploads/video-tools" : isAudio ? "uploads/audio-inputs" : "uploads/edit-inputs"
    const path = `${prefix}/${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeBase}.${ext}`

    const admin = createSupabaseAdmin()
    const { data: signed, error: signError } = await admin.storage.from(UPLOAD_BUCKET).createSignedUploadUrl(path)
    if (signError || !signed?.signedUrl) {
      // Clear diagnostics (no secrets): bucket + path + storage error message/status.
      const e = signError as (Error & { statusCode?: string | number; status?: number }) | null
      console.error("[upload/sign] createSignedUploadUrl error", JSON.stringify({
        bucket: UPLOAD_BUCKET,
        originalFilename,
        sanitizedFilename: `${safeBase}.${ext}`,
        contentType,
        assetType,
        path,
        message: e?.message ?? "(no message)",
        statusCode: e?.statusCode ?? e?.status ?? null,
      }))
      return NextResponse.json({ error: `Could not create the upload URL (bucket: ${UPLOAD_BUCKET}).` }, { status: 500 })
    }

    const { data: pub } = admin.storage.from(UPLOAD_BUCKET).getPublicUrl(path)

    // Best-effort usage tracking (same pattern as /api/upload) — declared size; never blocks the upload.
    try {
      await recordStorageAsset({
        userId,
        bucket: UPLOAD_BUCKET,
        path,
        sizeBytes,
        assetType,
        sourceType: "uploaded",
        sourceTable: null,
        sourceId: null,
        metadata: { originalFilename: body.filename ?? null, mimeType: contentType, publicUrl: pub.publicUrl, via: "signed-upload" },
      })
    } catch (trackErr) {
      console.error("[upload/sign] storage tracking failed", trackErr instanceof Error ? trackErr.message : trackErr)
    }

    return NextResponse.json({ signedUrl: signed.signedUrl, token: signed.token, path, publicUrl: pub.publicUrl })
  } catch (err) {
    console.error("[upload/sign] unexpected error", err)
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 })
  }
}
