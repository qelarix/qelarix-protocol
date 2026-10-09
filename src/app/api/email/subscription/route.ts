import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import { getUserById } from "@/lib/supabase/admin"
import { SubscriptionConfirmEmail, type SubscriptionPlan } from "@/emails/SubscriptionConfirmEmail"
import * as React from "react"

const resend = new Resend(process.env.RESEND_API_KEY)

const VALID_PLANS: SubscriptionPlan[] = ["starter", "pro", "ultra", "business"]

const PLAN_LABELS: Record<SubscriptionPlan, string> = {
  starter: "Starter",
  pro: "Pro",
  ultra: "Ultra",
  business: "Business",
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { userId, plan } = body as { userId: string; plan: string }

    if (!userId || !plan) {
      return NextResponse.json({ error: "userId and plan are required" }, { status: 400 })
    }

    if (!VALID_PLANS.includes(plan as SubscriptionPlan)) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 })
    }

    const validPlan = plan as SubscriptionPlan

    const user = await getUserById(userId)
    if (!user || !user.email) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "Qelarix <noreply@qelarix.ai>",
      to: user.email,
      subject: `✅ Your ${PLAN_LABELS[validPlan]} plan is active!`,
      react: React.createElement(SubscriptionConfirmEmail, { name: user.name, plan: validPlan }),
    })

    if (error) {
      console.error("[email/subscription]", error)
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[email/subscription]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
