import { NextRequest, NextResponse } from "next/server"
import { checkCronAuthorization } from "@/lib/cronAuth"
import { defaultPaymentEngineDeps } from "@/lib/payments/paymentEngine"
import { paymentErrorResponse } from "@/lib/payments/paymentErrorResponse"
import { recoverPayments } from "@/lib/payments/paymentRecovery"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Background QLC payment recovery (Vercel Cron, every minute): settles payments that landed without
// a confirm and retries pending QLC deliveries. See src/lib/payments/paymentRecovery.ts.
export async function GET(req: NextRequest) {
  const auth = checkCronAuthorization(req.headers.get("authorization"))
  if (auth === "not_configured") return NextResponse.json({ error: "Cron is not configured" }, { status: 503 })
  if (auth !== "ok") return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const result = await recoverPayments(await defaultPaymentEngineDeps())
    if (result.status === "ok" && result.stuckDeliveries.length > 0) console.error("[payments/recovery] stuck QLC deliveries", result.stuckDeliveries)
    return NextResponse.json(result)
  } catch (err) {
    return paymentErrorResponse("recovery", err)
  }
}
