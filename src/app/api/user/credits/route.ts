import { NextResponse } from "next/server"
import { getServerAuthUser } from "@/lib/authSession"
import { getGenerationBalance } from "@/lib/billing/generationBilling"

// The balance generations are paid from: database credits, or the wallet's on-chain QLC once
// generation billing is on chain (GENERATION_BILLING=qlc). See src/lib/billing/generationBilling.ts.
export async function GET() {
  try {
    const authUser = await getServerAuthUser()
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    return NextResponse.json({ credits: await getGenerationBalance(authUser) })
  } catch (err) {
    console.error("[credits]", err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "Failed to fetch credits" }, { status: 500 })
  }
}
