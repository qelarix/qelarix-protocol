import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { confirmPayment, defaultPaymentEngineDeps } from "@/lib/payments/paymentEngine"
import { paymentErrorResponse } from "@/lib/payments/paymentErrorResponse"

// Verifies the payment for one of the user's quotes on chain, settles it once and delivers the QLC.
// The optional signature only says which transaction to check; every value is verified from chain.
// Idempotent: repeating it after success returns the same result and retries a pending delivery.
export async function POST(req: NextRequest, { params }: { params: { intentId: string } }) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { signature?: unknown } | null
  const signature = typeof body?.signature === "string" ? body.signature : null
  try {
    return NextResponse.json(await confirmPayment(authUser, params.intentId, signature, await defaultPaymentEngineDeps()))
  } catch (err) {
    return paymentErrorResponse("confirm", err)
  }
}
