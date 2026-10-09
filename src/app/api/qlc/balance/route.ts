import { NextRequest, NextResponse } from "next/server"
import type { Address } from "@solana/kit"
import { getRequestAuthUser } from "@/lib/authSession"
import { defaultGenerationBillingDeps, epochAcceptsGenerations, generationBillingMode } from "@/lib/billing/generationBilling"
import { DEFAULT_ALLOWANCE_QLC, MAX_ALLOWANCE_QLC } from "@/lib/billing/qlcAllowance"
import { getQlcEnvironment } from "@/lib/qlc/qlcEnvironment"
import { getSolanaCluster } from "@/lib/solanaCluster"

export const dynamic = "force-dynamic"

// The signed-in wallet's on-chain QLC balance (the authoritative balance), spend allowance and
// membership, plus the billing mode and (QLC mode) whether the Devnet test epoch accepts generations.
export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!authUser.walletAddress) return NextResponse.json({ status: "wallet_required" })

  try {
    const qlc = await getQlcEnvironment()
    if (!qlc.enabled) return NextResponse.json({ status: "disabled", reason: qlc.reason })
    const wallet = authUser.walletAddress as Address
    const [balance, member] = await Promise.all([qlc.operator.balance(wallet, qlc.spendAuthority as Address), qlc.operator.member(wallet)])
    const billing = generationBillingMode()
    const cluster = getSolanaCluster()
    const epoch = billing === "qlc" && cluster ? await defaultGenerationBillingDeps().charges.currentEpoch(cluster).catch(() => null) : null
    return NextResponse.json({
      status: "ok",
      mint: qlc.mint,
      tokenAccount: balance.tokenAccount,
      amount: balance.amount.toString(),
      allowance: balance.allowance.toString(),
      frozen: balance.frozen,
      member: member.exists && !member.suspended,
      billing,
      generationOpen: billing === "qlc" ? epochAcceptsGenerations(epoch) : null,
      allowanceDefault: DEFAULT_ALLOWANCE_QLC,
      allowanceMax: MAX_ALLOWANCE_QLC,
    })
  } catch (err) {
    console.error("[qlc/balance]", err)
    return NextResponse.json({ status: "unavailable", error: "Solana network is unavailable. Please try again." }, { status: 503 })
  }
}
