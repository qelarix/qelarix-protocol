import { NextResponse } from "next/server"
import { SolanaRpcError } from "@/lib/solanaRpc"
import { PaymentClusterMismatchError } from "./paymentEngine"

/** Maps unexpected payment errors to responses. RPC and network problems never grant or refuse a payment. */
export function paymentErrorResponse(scope: string, err: unknown): NextResponse {
  console.error(`[payments/${scope}]`, err)
  if (err instanceof SolanaRpcError || err instanceof PaymentClusterMismatchError) {
    return NextResponse.json({ status: "unavailable", error: "Solana network is unavailable. Please try again." }, { status: 503 })
  }
  return NextResponse.json({ status: "error", error: "Payment request failed" }, { status: 500 })
}
