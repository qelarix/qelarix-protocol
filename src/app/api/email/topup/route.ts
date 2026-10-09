import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import { getUserById } from "@/lib/supabase/admin"
import { CreditPurchaseEmail } from "@/emails/CreditPurchaseEmail"
import * as React from "react"

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { userId, credits, amount, currency } = body as {
      userId: string
      credits: number
      amount: number
      currency?: string
    }

    if (!userId || credits == null || amount == null) {
      return NextResponse.json({ error: "userId, credits and amount are required" }, { status: 400 })
    }

    if (credits <= 0 || amount <= 0) {
      return NextResponse.json({ error: "credits and amount must be positive" }, { status: 400 })
    }

    const user = await getUserById(userId)
    if (!user || !user.email) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "Qelarix <noreply@qelarix.ai>",
      to: user.email,
      subject: `💳 Purchase successful — ${credits.toLocaleString()} credits added!`,
      react: React.createElement(CreditPurchaseEmail, {
        name: user.name,
        credits,
        amount,
        currency: currency ?? "EUR",
      }),
    })

    if (error) {
      console.error("[email/topup]", error)
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[email/topup]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
