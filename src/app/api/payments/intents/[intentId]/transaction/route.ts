import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { createPaymentTransaction, defaultPaymentEngineDeps } from "@/lib/payments/paymentEngine"
import { paymentErrorResponse } from "@/lib/payments/paymentErrorResponse"

// A fresh unsigned transfer (new blockhash) for one of the user's open quotes.
export async function POST(req: NextRequest, { params }: { params: { intentId: string } }) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    return NextResponse.json(await createPaymentTransaction(authUser, params.intentId, await defaultPaymentEngineDeps()))
  } catch (err) {
    return paymentErrorResponse("transaction", err)
  }
}
