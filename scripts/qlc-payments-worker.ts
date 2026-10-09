/**
 * QLC payment recovery worker: the same job as the /api/cron/qlc-payments cron route, as a
 * long-running process for hosts without Vercel Cron. Settles payments that landed without a
 * confirm and retries pending QLC deliveries (src/lib/payments/paymentRecovery.ts).
 *
 * Usage: npm run worker:qlc-payments   (tsx --env-file .env.local loads .env.local)
 * Optional: QLC_RECOVERY_INTERVAL_SECS (default 60, minimum 15).
 * Running it next to the cron route is safe: settlement and delivery are exactly-once.
 */
import { defaultPaymentEngineDeps } from "../src/lib/payments/paymentEngine"
import { recoverPayments } from "../src/lib/payments/paymentRecovery"

const intervalSecs = Math.max(15, Number(process.env.QLC_RECOVERY_INTERVAL_SECS) || 60)
let stopping = false
let wake: (() => void) | null = null

function stop() {
  stopping = true
  wake?.()
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[qlc-payments-worker] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    process.exit(1)
  }
  console.log(`[qlc-payments-worker] running every ${intervalSecs}s`)
  while (!stopping) {
    try {
      const result = await recoverPayments(await defaultPaymentEngineDeps())
      if (result.status === "disabled") {
        console.log(`[qlc-payments-worker] payments disabled (${result.reason})`)
      } else {
        const { intentsChecked, intentsSettled, intentsClosed, deliveriesAttempted, deliveriesDelivered, stuckDeliveries } = result
        console.log(`[qlc-payments-worker] ${new Date().toISOString()}`, { intentsChecked, intentsSettled, intentsClosed, deliveriesAttempted, deliveriesDelivered })
        if (stuckDeliveries.length > 0) console.error("[qlc-payments-worker] stuck QLC deliveries", stuckDeliveries)
      }
    } catch (err) {
      console.error("[qlc-payments-worker] run failed", err)
    }
    if (stopping) break
    await new Promise<void>((resolve) => {
      wake = resolve
      setTimeout(resolve, intervalSecs * 1000)
    })
  }
  console.log("[qlc-payments-worker] stopped")
}

void main()
