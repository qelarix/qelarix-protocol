import { NextRequest, NextResponse } from "next/server"
import { resolvePaymentDeployment } from "@/lib/payments/paymentConfig"
import { createSupabasePaymentStore } from "@/lib/payments/paymentEngine"
import { resolvePricingRegion, selectOfferedPacks } from "@/lib/payments/qlcPricing"

export const dynamic = "force-dynamic"

// Public, read-only list of the QLC packs offered on this deployment, for the Pricing page before
// sign-in. It returns only public catalogue data (amount, USD value, label); quotes and payments
// still go through the authenticated /api/payments/offer and /api/payments/intents routes.
export async function GET(req: NextRequest) {
  const deployment = resolvePaymentDeployment()
  if (!deployment.enabled) return NextResponse.json({ status: "disabled" })

  try {
    const { cluster } = deployment.deployment
    const rows = await createSupabasePaymentStore().listPricePacks(cluster)
    const packs = selectOfferedPacks(rows, { cluster, region: resolvePricingRegion(req.headers), now: new Date() }).map((pack) => ({
      id: pack.id,
      qlcAmount: pack.qlcAmount.toString(),
      usdValueMicros: pack.usdValueMicros.toString(),
      listUsdValueMicros: pack.listUsdValueMicros?.toString() ?? null,
      label: pack.label,
      highlighted: pack.highlighted,
    }))
    return NextResponse.json({ status: "ok", cluster, packs })
  } catch (err) {
    console.error("[payments/packs]", err instanceof Error ? err.message : err)
    return NextResponse.json({ status: "unavailable" }, { status: 503 })
  }
}
