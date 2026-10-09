import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import { getUserById } from "@/lib/supabase/admin"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { GenerationCompleteEmail, type GenerationType } from "@/emails/GenerationCompleteEmail"
import * as React from "react"

const resend = new Resend(process.env.RESEND_API_KEY)

const VALID_TYPES: GenerationType[] = ["video", "image", "audio"]

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { userId, generationId } = body as { userId: string; generationId: string }

    if (!userId || !generationId) {
      return NextResponse.json({ error: "userId and generationId are required" }, { status: 400 })
    }

    const [user, generationResult] = await Promise.all([
      getUserById(userId),
      createSupabaseAdmin()
        .from("generations")
        .select("type, prompt, credits_used")
        .eq("id", generationId)
        .eq("user_id", userId)
        .single(),
    ])

    if (!user || !user.email) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const gen = generationResult.data as { type: string; prompt: string; credits_used: number } | null
    if (generationResult.error || !gen) {
      return NextResponse.json({ error: "Generation not found" }, { status: 404 })
    }
    const generationType = VALID_TYPES.includes(gen.type as GenerationType)
      ? (gen.type as GenerationType)
      : "image"

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "Qelarix <noreply@qelarix.ai>",
      to: user.email,
      subject: `✅ Your generation is ready!`,
      react: React.createElement(GenerationCompleteEmail, {
        name: user.name,
        generationType,
        prompt: gen.prompt,
        generationId,
        creditsUsed: gen.credits_used,
      }),
    })

    if (error) {
      console.error("[email/generation-complete]", error)
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[email/generation-complete]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
