import { NextRequest, NextResponse } from "next/server"
import type { Address } from "@solana/kit"
import { getRequestAuthUser } from "@/lib/authSession"
import { MAX_ALLOWANCE_QLC, parseAllowance } from "@/lib/billing/qlcAllowance"
import { getQlcEnvironment } from "@/lib/qlc/qlcEnvironment"

export const dynamic = "force-dynamic"

// Builds the signed-in wallet's QLC allowance transaction for the wallet to sign and send:
//   { action: "approve", amount?: QLC }  "Enable QLC" (register_member if needed + finite approve) or a new allowance
//   { action: "revoke" }                 removes the whole allowance
// The wallet always comes from the session, never from the request. Qelarix pays the fee and any rent: the
// operator is fee payer and has signed; the wallet signs in its own wallet app. Nothing is sent here.
export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!authUser.walletAddress) return NextResponse.json({ error: "Sign in with your Solana wallet to use QLC." }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { action?: string; amount?: unknown }
  try {
    const qlc = await getQlcEnvironment()
    if (!qlc.enabled) return NextResponse.json({ error: "QLC is not available right now." }, { status: 503 })
    const wallet = authUser.walletAddress as Address

    if (body.action === "revoke") {
      return NextResponse.json({ transaction: await qlc.operator.revokeTransaction(wallet) })
    }
    if (body.action === "approve") {
      const allowance = parseAllowance(body.amount)
      if (allowance === null) {
        return NextResponse.json({ error: `Choose an allowance between 0.05 and ${MAX_ALLOWANCE_QLC.toLocaleString("en-US")} QLC (steps of 0.05).` }, { status: 400 })
      }
      const transaction = await qlc.operator.allowanceTransaction({ wallet, spendAuthority: qlc.spendAuthority as Address, allowance })
      return NextResponse.json({ transaction, allowance: allowance.toString() })
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (err) {
    console.error("[qlc/allowance]", err)
    return NextResponse.json({ error: "Solana network is unavailable. Please try again." }, { status: 503 })
  }
}
