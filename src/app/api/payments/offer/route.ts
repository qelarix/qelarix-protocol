import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { defaultPaymentEngineDeps, getPaymentOffer } from "@/lib/payments/paymentEngine"
import { paymentErrorResponse } from "@/lib/payments/paymentErrorResponse"
import { resolvePricingRegion } from "@/lib/payments/qlcPricing"

export const dynamic = "force-dynamic"

// QLC packs (canonical USD values) and payable assets for the signed-in wallet user, read at request time.
export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    return NextResponse.json(await getPaymentOffer(authUser, resolvePricingRegion(req.headers), await defaultPaymentEngineDeps()))
  } catch (err) {
    return paymentErrorResponse("offer", err)
  }
}
