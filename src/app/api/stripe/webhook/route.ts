import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import type { Plan } from "@/types/database"

// Raw body is required for Stripe signature verification.
// Next.js App Router provides req.text() for this purpose.
export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get("stripe-signature")

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 })
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err) {
    console.error("[stripe/webhook] Signature verification failed:", err)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  const admin = createSupabaseAdmin()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as any
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const { userId, credits, plan, type } = session.metadata ?? {}
        if (!userId) break

        const creditsNum = parseInt(credits ?? "0", 10)

        if (creditsNum > 0) {
          const paymentIntentId =
            typeof session.payment_intent === "string" ? session.payment_intent : null

          await db.rpc("add_credits", {
            p_user_id: userId,
            p_amount: creditsNum,
            p_type: type === "topup" ? "topup" : "subscription",
            p_desc:
              type === "topup"
                ? `Purchase of ${creditsNum} credits`
                : `Aktiviran ${plan ?? "plan"} plan`,
            ...(paymentIntentId ? { p_stripe_payment_intent_id: paymentIntentId } : {}),
          })
        }

        // Override credits for business (10000cr) and ultra (3500cr) plans
        const finalCredits = plan === "business" ? 10000 : plan === "ultra" ? 3500 : creditsNum

        // Update plan for subscription purchases
        if (type === "subscription" && plan && plan !== "free") {
          const planCreditsUpdate = (plan === "business" || plan === "ultra") ? { plan: plan as Plan, subscription_status: "active", credits: finalCredits } : { plan: plan as Plan, subscription_status: "active" }
          await db
            .from("profiles")
            .update(planCreditsUpdate)
            .eq("id", userId)

          fetch(`${appUrl}/api/email/subscription`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, plan }),
          }).catch((e) => console.error("[stripe/webhook] subscription email failed:", e))

          fetch(`${appUrl}/api/unlimited`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: userId, plan }),
          }).catch((e) => console.error("[stripe/webhook] unlimited activation failed:", e))
        }

        // Send topup confirmation email
        if (type === "topup") {
          const amountTotal = session.amount_total ? session.amount_total / 100 : 0
          fetch(`${appUrl}/api/email/topup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, credits: creditsNum, amount: amountTotal }),
          }).catch((e) => console.error("[stripe/webhook] topup email failed:", e))
        }

        break
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription
        const userId = sub.metadata?.userId
        if (!userId) break

        const plan = (sub.items.data[0]?.price.metadata?.plan ?? "free") as Plan
        // In Stripe v22, current_period_end lives on SubscriptionItem
        const periodEndRaw =
          (sub.items.data[0] as unknown as { current_period_end?: number })?.current_period_end
        const periodEnd = periodEndRaw
          ? new Date(periodEndRaw * 1000).toISOString()
          : null

        await db
          .from("profiles")
          .update({
            plan,
            stripe_subscription_id: sub.id,
            subscription_status: sub.status,
            subscription_period_end: periodEnd,
          })
          .eq("id", userId)

        fetch(`${appUrl}/api/unlimited`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, plan }),
        }).catch((e) => console.error("[stripe/webhook] unlimited activation failed:", e))

        break
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription
        const userId = sub.metadata?.userId
        if (!userId) break

        await db
          .from("profiles")
          .update({
            plan: "free",
            subscription_status: "canceled",
            stripe_subscription_id: null,
            subscription_period_end: null,
          })
          .eq("id", userId)

        // Give 100 free credits on downgrade
        await db.rpc("add_credits", {
          p_user_id: userId,
          p_amount: 100,
          p_type: "bonus",
          p_desc: "Remaining credits after subscription cancellation",
        })

        break
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id
        if (!customerId) break

        const profileResult = await db
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single()
        const profileData = profileResult?.data as { id: string } | null

        if (profileData?.id) {
          fetch(`${appUrl}/api/email/payment-failed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: profileData.id }),
          }).catch((e) => console.error("[stripe/webhook] payment-failed email failed:", e))
        }

        break
      }
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error("[stripe/webhook] Handler error:", err)
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 })
  }
}
