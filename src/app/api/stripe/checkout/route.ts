import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

type CheckoutBody = {
  priceId?: string
  planId?: string
  userId: string
  mode: "subscription" | "payment"
}

const PLAN_TO_PRICE_ENV: Record<string, string> = {
  starter: "STRIPE_PRICE_STARTER",
  pro: "STRIPE_PRICE_PRO",
  business: "STRIPE_PRICE_BUSINESS",
  ultra: "STRIPE_PRICE_ULTRA", // STRIPE_PRICE_ULTRA=price_XXX — set in .env.local
  topup_500: "STRIPE_PRICE_TOPUP_500",
  topup_1500: "STRIPE_PRICE_TOPUP_1500",
  topup_5000: "STRIPE_PRICE_TOPUP_5000",
  topup_10000: "STRIPE_PRICE_TOPUP_10000",
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CheckoutBody
    const { userId, mode } = body

    if (!userId || !mode) {
      return NextResponse.json({ error: "userId and mode are required" }, { status: 400 })
    }

    if (!["subscription", "payment"].includes(mode)) {
      return NextResponse.json({ error: "mode must be 'subscription' or 'payment'" }, { status: 400 })
    }

    // Resolve priceId from either direct priceId or planId mapping
    let priceId = body.priceId
    if (!priceId && body.planId) {
      const envKey = PLAN_TO_PRICE_ENV[body.planId]
      if (!envKey) {
        return NextResponse.json({ error: "Invalid planId" }, { status: 400 })
      }
      priceId = process.env[envKey]
    }

    if (!priceId) {
      return NextResponse.json({ error: "priceId or valid planId is required" }, { status: 400 })
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
    const admin = createSupabaseAdmin()

    // Fetch user auth record for email
    const { data: authData } = await admin.auth.admin.getUserById(userId)
    if (!authData?.user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    // Get or create Stripe customer
    const profileResult = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single()
    const profileData = profileResult.data as { stripe_customer_id: string | null } | null

    let customerId = profileData?.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: authData.user.email,
        metadata: { userId },
      })
      customerId = customer.id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin.from("profiles") as any).update({ stripe_customer_id: customerId }).eq("id", userId)
    }

    // Fetch price metadata from Stripe (credits, plan name)
    const price = await stripe.prices.retrieve(priceId)
    const credits = price.metadata?.credits ?? "0"
    const plan = price.metadata?.plan ?? "free"
    const type = mode === "subscription" ? "subscription" : "topup"

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      payment_method_types: ["card"],
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${appUrl}/?canceled=true`,
      metadata: { userId, credits, plan, type },
    }

    if (mode === "subscription") {
      sessionParams.subscription_data = {
        metadata: { userId, credits, plan },
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error("[stripe/checkout]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
