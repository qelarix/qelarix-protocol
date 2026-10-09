import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { generationBillingMode } from "@/lib/billing/generationBilling"
import { deliverPendingQlc } from "@/lib/billing/qlcGrantDelivery"
import { claimDevnetBetaCredits } from "@/lib/creditCampaigns/grantService"

// Automatic Devnet beta claim, called once after wallet sign-in. Devnet only (disabled on any other
// cluster) and limited to the Devnet test campaigns of the billing mode: database credits before the
// QLC cutover, 500 on-chain QLC per wallet after it. Idempotent like /api/credits/claim; the request body
// is ignored and the server decides campaign, eligibility and amount. In QLC mode the granted delivery
// runs at once when the wallet is already a member; otherwise it stays pending until the wallet enables QLC.
export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const billing = generationBillingMode()
    const result = await claimDevnetBetaCredits(authUser, undefined, billing)
    let delivery: { delivered: number; pending: number } | null = null
    if (billing === "qlc" && result.status === "ok" && authUser.walletAddress && result.grants.some((g) => g.deliveryId)) {
      delivery = await deliverPendingQlc(result.cluster, authUser.walletAddress).catch(() => null)
    }
    return NextResponse.json({ ...result, billing, delivery })
  } catch (err) {
    console.error("[credits/claim/devnet-beta]", err)
    return NextResponse.json({ error: "Credit claim failed" }, { status: 500 })
  }
}
