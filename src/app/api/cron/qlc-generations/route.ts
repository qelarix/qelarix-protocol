import { NextRequest, NextResponse } from "next/server"
import { checkCronAuthorization } from "@/lib/cronAuth"
import { defaultGenerationBillingDeps } from "@/lib/billing/generationBilling"
import { markGenerationFailedInDb, recoverGenerationCharges } from "@/lib/billing/billingRecovery"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Background recovery of QLC generation charges (GENERATION_BILLING=qlc): resolves unconfirmed charges,
// retries refunds, settles or refunds charged generations and closes final receipts. Disabled in credits
// mode. See src/lib/billing/billingRecovery.ts.
export async function GET(req: NextRequest) {
  const auth = checkCronAuthorization(req.headers.get("authorization"))
  if (auth === "not_configured") return NextResponse.json({ error: "Cron is not configured" }, { status: 503 })
  if (auth !== "ok") return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const result = await recoverGenerationCharges({ ...defaultGenerationBillingDeps(), now: () => new Date(), markGenerationFailed: markGenerationFailedInDb })
    if (result.errors.length > 0) console.error("[billing/recovery]", result.errors)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[billing/recovery]", err)
    return NextResponse.json({ error: "Recovery failed" }, { status: 500 })
  }
}
