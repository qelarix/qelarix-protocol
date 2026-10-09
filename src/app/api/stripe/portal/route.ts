import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export async function POST(req: NextRequest) {
  try {
    const { userId } = (await req.json()) as { userId: string }

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 })
    }

    const admin = createSupabaseAdmin()

    const profileResult = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single()
    const profileData = profileResult.data as { stripe_customer_id: string | null } | null

    if (!profileData?.stripe_customer_id) {
      return NextResponse.json({ error: "No Stripe customer found for this user" }, { status: 404 })
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"

    const session = await stripe.billingPortal.sessions.create({
      customer: profileData.stripe_customer_id,
      return_url: `${appUrl}/dashboard`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error("[stripe/portal]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
