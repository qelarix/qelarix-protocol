import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import { getUserById } from "@/lib/supabase/admin"
import { PaymentFailedEmail } from "@/emails/PaymentFailedEmail"
import * as React from "react"

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { userId } = body as { userId: string }

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 })
    }

    const user = await getUserById(userId)
    if (!user || !user.email) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "Qelarix <noreply@qelarix.ai>",
      to: user.email,
      subject: "⚠️ Payment failed — please update your card",
      react: React.createElement(PaymentFailedEmail, { name: user.name }),
    })

    if (error) {
      console.error("[email/payment-failed]", error)
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[email/payment-failed]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
