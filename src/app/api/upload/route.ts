import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { recordStorageAsset } from "@/lib/storageUsage"

// Images + videos. Videos were always intended here (see the assetType "video" branch below) but were
// missing from the allowlist — which broke every video-file upload (Video Tools / Video Extend) with
// "Unsupported file type". Adding video types is purely additive: image behavior is unchanged.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"]
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB (unchanged)
const MAX_VIDEO_SIZE = 100 * 1024 * 1024 // 100MB (matches the Video Tools / Video Extend UI copy)

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
  }

  const file = formData.get("file") as File | null
  const folder = (formData.get("folder") as string) ?? "uploads"

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
  const isImage = ALLOWED_IMAGE_TYPES.includes(file.type)
  const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type)
  if (!isImage && !isVideo) {
    return NextResponse.json({ error: "Unsupported file type. Use JPEG, PNG, WebP, GIF or MP4, MOV, WebM." }, { status: 400 })
  }
  const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE
  if (file.size > maxSize) {
    return NextResponse.json({ error: `File too large. Max ${isVideo ? "100MB" : "10MB"}.` }, { status: 400 })
  }

  const ext = file.name.split(".").pop() ?? (isVideo ? "mp4" : "jpg")
  const path = `${folder}/${authUser.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const buffer = new Uint8Array(await file.arrayBuffer())

  const supabase = createSupabaseAdmin()
  const { error } = await supabase.storage.from("media").upload(path, buffer, {
    contentType: file.type,
    upsert: false,
  })

  if (error) {
    console.error("Upload error:", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }

  const { data } = supabase.storage.from("media").getPublicUrl(path)

  // Best-effort: record the stored asset for global storage usage (Phase 3A).
  // Never block or fail the upload if tracking fails.
  try {
    const assetType = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
      ? "video"
      : file.type.startsWith("audio/")
      ? "audio"
      : "upload"
    await recordStorageAsset({
      userId: authUser.id,
      bucket: "media",
      path,
      sizeBytes: file.size,
      assetType,
      sourceType: "uploaded",
      sourceTable: null,
      sourceId: null,
      metadata: {
        originalFilename: file.name,
        mimeType: file.type,
        publicUrl: data.publicUrl,
      },
    })
  } catch (trackErr) {
    console.error(
      "[upload] storage tracking failed",
      trackErr instanceof Error ? trackErr.message : trackErr,
    )
  }

  return NextResponse.json({ url: data.publicUrl, path })
}
