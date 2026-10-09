// Executes a wallet's pending QLC deliveries (e.g. the Devnet 500 QLC grant) right away instead of
// waiting for the recovery job. The program delivers only to members, so a wallet that has not enabled
// QLC yet keeps them pending; they run as soon as the wallet's "Enable QLC" transaction is confirmed.
// Each delivery stays exactly-once (one on-chain receipt per delivery key; src/lib/payments/qlcDeliveries.ts).
import { createSupabaseDeliveryStore, processDelivery, type QlcDeliverer } from "@/lib/payments/qlcDeliveries"
import { getQlcEnvironment } from "@/lib/qlc/qlcEnvironment"
import type { SolanaCluster } from "@/lib/solanaCluster"

export interface PendingDeliveryResult {
  delivered: number
  pending: number
}

export async function deliverPendingQlc(
  cluster: SolanaCluster,
  wallet: string,
  deps: { qlc: QlcDeliverer | null; store: ReturnType<typeof createSupabaseDeliveryStore> } | null = null,
): Promise<PendingDeliveryResult> {
  const resolved = deps ?? (await (async () => {
    const qlc = await getQlcEnvironment()
    return { qlc: qlc.enabled ? qlc.operator : null, store: createSupabaseDeliveryStore() }
  })())
  const records = await resolved.store.listPendingForWallet(cluster, wallet, 10)
  const result: PendingDeliveryResult = { delivered: 0, pending: 0 }
  for (const record of records) {
    const outcome = await processDelivery(record, { qlc: resolved.qlc, store: resolved.store })
    if (outcome.status === "delivered") result.delivered++
    else result.pending++
  }
  return result
}
