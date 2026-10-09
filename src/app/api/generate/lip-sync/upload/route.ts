import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationEpoch } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"

fal.config({ credentials: process.env.FAL_KEY })

const MAX_FACE_BYTES = 50 * 1024 * 1024
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

const FACE_MIME = new Set([
  "image/jpeg", "image/png", "image/webp",
  "video/mp4", "video/quicktime", "video/webm", "video/x-msvideo",
])
const AUDIO_MIME = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/ogg", "audio/aac", "audio/mp4", "audio/webm",
])

function isFaceFile(file: File) {
  if (FACE_MIME.has(file.type)) return true
  return /\.(jpg|jpeg|png|webp|mp4|mov|webm|avi)$/i.test(file.name)
}

function isAudioFile(file: File) {
  if (AUDIO_MIME.has(file.type)) return true
  return /\.(mp3|wav|ogg|aac|m4a)$/i.test(file.name)
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
    const gate = await checkGenerationEpoch()
    if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

    const formData = await req.formData()
    const file = formData.get("file")
    const type = formData.get("type") as string

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file attached" }, { status: 400 })
    }

    if (type === "face") {
      if (!isFaceFile(file)) {
        return NextResponse.json(
          { error: "Dozvoljeni formati za lice: JPG, PNG, WebP, MP4, MOV, WebM" },
          { status: 400 },
        )
      }
      if (file.size > MAX_FACE_BYTES) {
        return NextResponse.json({ error: "Face file must not exceed 50 MB" }, { status: 400 })
      }
    } else if (type === "audio") {
      if (!isAudioFile(file)) {
        return NextResponse.json(
          { error: "Dozvoljeni formati za audio: MP3, WAV, OGG, AAC, M4A" },
          { status: 400 },
        )
      }
      if (file.size > MAX_AUDIO_BYTES) {
        return NextResponse.json({ error: "Audio file must not exceed 20 MB" }, { status: 400 })
      }
    } else {
      return NextResponse.json({ error: "Type must be 'face' or 'audio'" }, { status: 400 })
    }

    const url = await fal.storage.upload(file)
    return NextResponse.json({ url })
  } catch (err) {
    console.error("[lip-sync/upload]", err)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
