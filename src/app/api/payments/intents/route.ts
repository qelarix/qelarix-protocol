import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createPaymentIntent, defaultPaymentEngineDeps } from "@/lib/payments/paymentEngine"
import { paymentErrorResponse } from "@/lib/payments/paymentErrorResponse"
import { resolvePricingRegion } from "@/lib/payments/qlcPricing"

// Quotes one pack in one payment asset and returns the unsigned transfer for the user's wallet.
// Only the pack id and asset id are read from the body; price, amount and treasury are decided here.
export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { packId?: unknown; assetId?: unknown } | null
  try {
    return NextResponse.json(
      await createPaymentIntent(authUser, { packId: body?.packId, assetId: body?.assetId }, resolvePricingRegion(req.headers), await defaultPaymentEngineDeps()),
    )
  } catch (err) {
    return paymentErrorResponse("intents", err)
  }
}
