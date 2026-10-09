// Background recovery for QLC generation charges (GENERATION_BILLING=qlc), run by
// /api/cron/qlc-generations. Every step is idempotent: database compare-and-set transitions plus the
// on-chain charge receipt as the source of truth.
//   1. pending (charge outcome unknown): receipt present → charged (refunded at once when the
//      generation already failed or a release was requested); receipt still absent once the charge can
//      no longer land → charge_failed (the epoch reservation is released, nothing moved).
//   2. refund_pending → the refund is retried.
//   3. charged: generation completed → settled; failed → refunded; still running past the timeout →
//      the generation is marked failed and refunded.
//   4. settled / refunded long enough → the receipt is closed (rent back to the operator; the charge
//      number stays used forever).
import type { Address } from "@solana/kit"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { releaseGenerationCharge, type GenerationBillingDeps } from "./generationBilling"

/** A charge whose call failed is resolved after its blockhash can no longer land. */
export const CHARGE_UNKNOWN_MS = 3 * 60 * 1000
/** A charged generation that is neither completed nor failed by then is failed and refunded. */
export const GENERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000
/** Final receipts are closed after this grace period. */
export const CLOSE_AFTER_MS = 24 * 60 * 60 * 1000
const BATCH = 50

export interface BillingRecoveryDeps extends GenerationBillingDeps {
  now(): Date
  markGenerationFailed(generationId: string): Promise<void>
}

export interface BillingRecoveryResult {
  status: "ok" | "disabled"
  charged: number
  chargeFailed: number
  settled: number
  refunded: number
  timedOut: number
  closed: number
  errors: string[]
}

export async function markGenerationFailedInDb(generationId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createSupabaseAdmin() as any
  await admin.from("generations").update({ status: "failed" }).eq("id", generationId).not("status", "in", "(completed,failed)")
  // Cinema Studio lip-sync jobs are charged under their own id (see qlcChargeStore.generationStatuses).
  await admin.from("cinema_lip_sync_jobs").update({ status: "failed", error_message: "Generation timed out" }).eq("id", generationId).not("status", "in", "(completed,failed)")
}

export async function recoverGenerationCharges(deps: BillingRecoveryDeps): Promise<BillingRecoveryResult> {
  const result: BillingRecoveryResult = { status: "ok", charged: 0, chargeFailed: 0, settled: 0, refunded: 0, timedOut: 0, closed: 0, errors: [] }
  if (deps.mode !== "qlc" || !deps.cluster) return { ...result, status: "disabled" }
  const chain = await deps.chain()
  if (!chain) return { ...result, status: "disabled" }

  const now = deps.now().getTime()
  const charges = await deps.charges.listOpen(deps.cluster, BATCH, new Date(now - CLOSE_AFTER_MS))
  const generations = await deps.charges.generationStatuses(charges.map((c) => c.generationId))
  const age = (updatedAt: string) => now - Date.parse(updatedAt)

  for (const charge of charges) {
    const wallet = charge.wallet as Address
    const generation = generations.get(charge.generationId) ?? "missing"
    try {
      if (charge.status === "pending") {
        if (age(charge.updatedAt) < CHARGE_UNKNOWN_MS) continue
        const receipt = await chain.chargeReceipt({ wallet, seq: charge.seq })
        if (receipt.exists) {
          await deps.charges.markCharged(charge.generationId, null)
          result.charged++
          // The request that charged already answered "not confirmed", so its provider never ran.
          await releaseGenerationCharge({ generationId: charge.generationId, reason: "charge confirmed after the request gave up" }, deps)
          result.refunded++
        } else {
          await deps.charges.fail(charge.generationId, "charge did not land")
          result.chargeFailed++
        }
        continue
      }
      if (charge.status === "refund_pending") {
        await releaseGenerationCharge({ generationId: charge.generationId, reason: "refund retry" }, deps)
        result.refunded++
        continue
      }
      if (charge.status === "charged") {
        if (generation === "completed") {
          await deps.charges.settle(charge.generationId)
          result.settled++
        } else if (generation === "failed") {
          await releaseGenerationCharge({ generationId: charge.generationId, reason: "generation failed" }, deps)
          result.refunded++
        } else if (age(charge.updatedAt) >= GENERATION_TIMEOUT_MS) {
          await deps.markGenerationFailed(charge.generationId)
          await releaseGenerationCharge({ generationId: charge.generationId, reason: "generation timed out" }, deps)
          result.timedOut++
        }
        continue
      }
      if ((charge.status === "settled" || charge.status === "refunded") && age(charge.updatedAt) >= CLOSE_AFTER_MS) {
        const signature = await chain.closeCharge({ wallet, seq: charge.seq })
        await deps.charges.markClosed(charge.generationId, signature)
        result.closed++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`${charge.generationId}: ${message.slice(0, 200)}`)
      await deps.charges.recordError(charge.generationId, message).catch(() => {})
    }
  }
  return result
}
