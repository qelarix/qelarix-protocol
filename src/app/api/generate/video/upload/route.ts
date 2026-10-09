import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationEpoch } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"

fal.config({ credentials: process.env.FAL_KEY })

const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

export async function POST(req: NextRequest) {
  try {
    // ── Auth ──
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
    const gate = await checkGenerationEpoch()
    if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

    const formData = await req.formData()
    const file = formData.get("file")

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file attached" }, { status: 400 })
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Dozvoljeni formati: JPG, PNG, WebP, GIF" },
        { status: 400 },
      )
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: "Image must not exceed 10 MB" }, { status: 400 })
    }

    const url = await fal.storage.upload(file)
    return NextResponse.json({ url })
  } catch (err) {
    console.error("[generate/video/upload]", err)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
