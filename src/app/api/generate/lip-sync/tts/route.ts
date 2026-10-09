import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationEpoch } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"

fal.config({ credentials: process.env.FAL_KEY })

const TTS_ENDPOINT = "fal-ai/kokoro"
const MAX_POLL = 40
const POLL_INTERVAL_MS = 1000

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // Devnet test-epoch gate (QLC mode): no provider call while testing is paused. Unpriced: nothing is charged.
    const gate = await checkGenerationEpoch()
    if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status })

    const body = (await req.json()) as { text?: string; voice?: string }
    const text = body.text?.trim()
    if (!text) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 })
    }
    if (text.length > 500) {
      return NextResponse.json({ error: "Text must not exceed 500 characters" }, { status: 400 })
    }

    const queued = await fal.queue.submit(TTS_ENDPOINT, {
      input: { prompt: text, voice: body.voice ?? "af_alloy" },
    })
    const requestId = queued.request_id

    for (let i = 0; i < MAX_POLL; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

      let status: { status: string }
      try {
        status = await fal.queue.status(TTS_ENDPOINT, { requestId, logs: false })
      } catch {
        continue
      }

      if (status.status === "COMPLETED") {
        const result = await fal.queue.result(TTS_ENDPOINT, { requestId })
        const data = result.data as Record<string, unknown>

        const audioUrl =
          (data.audio as { url?: string } | undefined)?.url ??
          (data.audio_file as { url?: string } | undefined)?.url ??
          (typeof data.audio_url === "string" ? data.audio_url : null)

        if (!audioUrl) {
          return NextResponse.json({ error: "TTS did not return an audio URL" }, { status: 500 })
        }
        return NextResponse.json({ audio_url: audioUrl })
      }

      if (status.status === "FAILED" || status.status === "CANCELLED") {
        return NextResponse.json({ error: "TTS generation failed" }, { status: 500 })
      }
    }

    return NextResponse.json({ error: "TTS timed out — please try again" }, { status: 504 })
  } catch (err) {
    console.error("[lip-sync/tts]", err)
    return NextResponse.json({ error: "TTS error" }, { status: 500 })
  }
}
