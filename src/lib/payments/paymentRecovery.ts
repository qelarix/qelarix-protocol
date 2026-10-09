// Background recovery for QLC purchases, so delivery never depends on the buyer's browser calling
// confirm again. Each run (1) looks up every pending quote's payment on chain and settles it when it
// landed, closing quotes that can no longer be paid, and (2) retries every pending QLC delivery whose
// backoff has elapsed. Run by the cron route /api/cron/qlc-payments and by
// scripts/qlc-payments-worker.ts. Safe to run concurrently with confirms and with itself: settlement
// locks the quote row, and the on-chain receipt executes each delivery at most once.
import { SETTLEMENT_GRACE_MS } from "./paymentConfig"
import { ensureCluster, verifyAndSettle, type PaymentEngineDeps } from "./paymentEngine"
import { processDelivery } from "./qlcDeliveries"

/** Deliveries that failed this often are reported as stuck; they keep being retried (hourly at most). */
export const STUCK_DELIVERY_ATTEMPTS = 5

export interface RecoveryLimits {
  intents: number
  deliveries: number
}

export const DEFAULT_RECOVERY_LIMITS: RecoveryLimits = { intents: 25, deliveries: 10 }

export interface RecoveryReport {
  intentsChecked: number
  intentsSettled: number
  intentsClosed: number
  deliveriesAttempted: number
  deliveriesDelivered: number
  stuckDeliveries: { id: string; attempts: number; error: string }[]
}

export type RecoveryResult = { status: "disabled"; reason: string } | ({ status: "ok" } & RecoveryReport)

export async function recoverPayments(deps: PaymentEngineDeps, limits: RecoveryLimits = DEFAULT_RECOVERY_LIMITS): Promise<RecoveryResult> {
  if (!deps.deployment.enabled) return { status: "disabled", reason: deps.deployment.reason }
  const { deployment } = deps.deployment
  const { store } = deps
  await ensureCluster(deployment, deps.rpc)
  const report: RecoveryReport = { intentsChecked: 0, intentsSettled: 0, intentsClosed: 0, deliveriesAttempted: 0, deliveriesDelivered: 0, stuckDeliveries: [] }

  // 1. Payments that landed but were never confirmed. Settling enqueues the delivery for step 2.
  for (const intent of await store.listPendingIntents(deployment.cluster, limits.intents)) {
    if (!intent.userId) continue
    report.intentsChecked++
    const result = await verifyAndSettle(intent, intent.userId, null, deps)
    if (result.status === "settled") {
      report.intentsSettled++
      continue
    }
    // A payment counts only if it landed before the quote expired, so once the grace period is over
    // a lookup that found nothing is final. A closed quote can still be settled by a later confirm.
    const cutoff = new Date(deps.now().getTime() - SETTLEMENT_GRACE_MS)
    if (intent.expiresAt < cutoff && (await store.closeExpiredIntent(intent.id, cutoff))) report.intentsClosed++
  }

  // 2. Paid but undelivered QLC, oldest retry first.
  for (const record of await store.listDueDeliveries(deployment.cluster, limits.deliveries)) {
    report.deliveriesAttempted++
    const outcome = await processDelivery(record, { qlc: deps.qlc, store })
    if (outcome.status === "delivered") {
      report.deliveriesDelivered++
    } else if (record.attempts + 1 >= STUCK_DELIVERY_ATTEMPTS) {
      report.stuckDeliveries.push({ id: record.id, attempts: record.attempts + 1, error: outcome.error })
    }
  }
  return { status: "ok", ...report }
}
