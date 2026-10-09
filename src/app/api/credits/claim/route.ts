import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { claimCampaignCredits } from "@/lib/creditCampaigns/grantService"

// Claims every open credit campaign the signed-in user is eligible for. Idempotent: repeated
// calls never grant twice. The request body is ignored; the server decides campaign, eligibility
// and amount.
export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    return NextResponse.json(await claimCampaignCredits(authUser))
  } catch (err) {
    console.error("[credits/claim]", err)
    return NextResponse.json({ error: "Credit claim failed" }, { status: 500 })
  }
}
