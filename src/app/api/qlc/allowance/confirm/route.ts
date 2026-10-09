import { NextRequest, NextResponse } from "next/server"
import type { Address } from "@solana/kit"
import { getRequestAuthUser } from "@/lib/authSession"
import { deliverPendingQlc } from "@/lib/billing/qlcGrantDelivery"
import { TRANSACTION_SIGNATURE_PATTERN } from "@/lib/payments/paymentEngine"
import { getQlcEnvironment } from "@/lib/qlc/qlcEnvironment"
import { getSolanaCluster, getSolanaRpcUrl } from "@/lib/solanaCluster"
import { createSolanaRpcCall } from "@/lib/solanaRpc"

export const dynamic = "force-dynamic"

// After the wallet sent its allowance transaction: waits for it to be confirmed on chain, runs the
// wallet's pending QLC deliveries (e.g. the Devnet 500 QLC grant, which needs membership) and returns the
// on-chain state. Nothing is trusted from the client except the signature to look up.
export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!authUser.walletAddress) return NextResponse.json({ error: "Sign in with your Solana wallet to use QLC." }, { status: 403 })

  const { signature } = (await req.json().catch(() => ({}))) as { signature?: string }
  if (!signature || !TRANSACTION_SIGNATURE_PATTERN.test(signature)) return NextResponse.json({ error: "Invalid signature" }, { status: 400 })

  try {
    const cluster = getSolanaCluster()
    const qlc = await getQlcEnvironment()
    if (!cluster || !qlc.enabled) return NextResponse.json({ error: "QLC is not available right now." }, { status: 503 })

    const rpc = createSolanaRpcCall(process.env.SOLANA_RPC_URL || getSolanaRpcUrl(cluster))
    const { value } = await rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])
    const status = value[0]
    if (!status || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) {
      return NextResponse.json({ status: "pending" }, { status: 202 })
    }
    if (status.err) return NextResponse.json({ status: "failed", error: "The transaction failed on chain. Nothing changed." }, { status: 409 })

    const wallet = authUser.walletAddress as Address
    const delivery = await deliverPendingQlc(cluster, wallet).catch(() => null)
    const [member, balance] = await Promise.all([qlc.operator.member(wallet), qlc.operator.balance(wallet, qlc.spendAuthority as Address)])
    return NextResponse.json({
      status: "confirmed",
      member: member.exists && !member.suspended,
      amount: balance.amount.toString(),
      allowance: balance.allowance.toString(),
      delivery,
    })
  } catch (err) {
    console.error("[qlc/allowance/confirm]", err)
    return NextResponse.json({ error: "Solana network is unavailable. Please try again." }, { status: 503 })
  }
}
