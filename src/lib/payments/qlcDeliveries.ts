// QLC delivery pipeline shared by every source (purchases, leaderboard rewards, campaigns, grants).
// Each delivery has one stable key, e.g. "payment:<intent id>". The database row and the on-chain
// receipt both derive from it (delivery id = sha256(key)), so a delivery can be retried any number of
// times and is executed at most once; the QLC program refuses a second receipt for the same id.
import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Address } from "@solana/kit"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import type { SolanaCluster } from "@/lib/solanaCluster"
import { DeliveryKind } from "@/lib/qlc/generated"
import type { DeliveryResult } from "@/lib/qlc/qlcOperator"

export type DeliverySourceKind = "purchase" | "reward" | "grant" | "campaign"

const PROGRAM_KIND: Record<DeliverySourceKind, DeliveryKind> = {
  purchase: DeliveryKind.Purchase,
  reward: DeliveryKind.Reward,
  grant: DeliveryKind.Grant,
  campaign: DeliveryKind.Campaign,
}

export interface QlcDeliveryRecord {
  id: string
  deliveryKey: string
  walletAddress: string
  qlcAmount: bigint
  kind: DeliverySourceKind
  status: "pending" | "delivered"
  txSignature: string | null
  fromVault: bigint | null
  minted: bigint | null
  attempts: number
  lastError: string | null
}

export type DeliveryOutcome =
  | { status: "delivered"; signature: string | null; fromVault: bigint; minted: bigint }
  | { status: "pending"; error: string }

/** The subset of the QLC operator a delivery needs (see src/lib/qlc/qlcOperator.ts). */
export interface QlcDeliverer {
  deliver(input: { deliveryId: Uint8Array; wallet: Address; amount: bigint; kind: DeliveryKind }): Promise<DeliveryResult>
}

export interface DeliveryStore {
  markDelivered(id: string, result: { signature: string | null; fromVault: bigint; minted: bigint }): Promise<void>
  recordAttempt(id: string, error: string): Promise<void>
}

export function deliveryIdFor(deliveryKey: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(deliveryKey, "utf8").digest())
}

/**
 * Executes a pending delivery on chain (or recognizes it as already executed) and records it. A
 * delivery that cannot run yet (not a member, suspended, RPC or program error) stays pending with
 * the reason recorded; the payment recovery job retries it (src/lib/payments/paymentRecovery.ts).
 */
export async function processDelivery(record: QlcDeliveryRecord, deps: { qlc: QlcDeliverer | null; store: DeliveryStore }): Promise<DeliveryOutcome> {
  if (record.status === "delivered") {
    return { status: "delivered", signature: record.txSignature, fromVault: record.fromVault ?? BigInt(0), minted: record.minted ?? BigInt(0) }
  }
  if (!deps.qlc) {
    await deps.store.recordAttempt(record.id, "qlc_not_configured")
    return { status: "pending", error: "qlc_not_configured" }
  }
  try {
    const result = await deps.qlc.deliver({
      deliveryId: deliveryIdFor(record.deliveryKey),
      wallet: record.walletAddress as Address,
      amount: record.qlcAmount,
      kind: PROGRAM_KIND[record.kind],
    })
    if (result.status === "not_member" || result.status === "member_suspended") {
      await deps.store.recordAttempt(record.id, result.status)
      return { status: "pending", error: result.status }
    }
    const signature = result.status === "delivered" ? result.signature : record.txSignature
    await deps.store.markDelivered(record.id, { signature, fromVault: result.fromVault, minted: result.minted })
    return { status: "delivered", signature, fromVault: result.fromVault, minted: result.minted }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    await deps.store.recordAttempt(record.id, message)
    return { status: "pending", error: message }
  }
}

interface DeliveryRow {
  id: string
  delivery_key: string
  wallet_address: string
  qlc_amount: number | string
  kind: DeliverySourceKind
  status: "pending" | "delivered"
  tx_signature: string | null
  from_vault: number | string | null
  minted: number | string | null
  attempts: number
  last_error: string | null
}

export const DELIVERY_COLUMNS = "id, delivery_key, wallet_address, qlc_amount, kind, status, tx_signature, from_vault, minted, attempts, last_error"

export function toDeliveryRecord(row: DeliveryRow): QlcDeliveryRecord {
  return {
    id: row.id,
    deliveryKey: row.delivery_key,
    walletAddress: row.wallet_address,
    qlcAmount: BigInt(row.qlc_amount),
    kind: row.kind,
    status: row.status,
    txSignature: row.tx_signature,
    fromVault: row.from_vault === null ? null : BigInt(row.from_vault),
    minted: row.minted === null ? null : BigInt(row.minted),
    attempts: row.attempts,
    lastError: row.last_error,
  }
}

export function createSupabaseDeliveryStore(client: SupabaseClient = createSupabaseAdmin() as unknown as SupabaseClient): DeliveryStore & {
  getDelivery(id: string): Promise<QlcDeliveryRecord | null>
  listDueDeliveries(cluster: SolanaCluster, limit: number): Promise<QlcDeliveryRecord[]>
  listPendingForWallet(cluster: SolanaCluster, wallet: string, limit: number): Promise<QlcDeliveryRecord[]>
} {
  return {
    async listPendingForWallet(cluster, wallet, limit) {
      const { data, error } = await client
        .from("qlc_deliveries")
        .select(DELIVERY_COLUMNS)
        .eq("cluster", cluster)
        .eq("wallet_address", wallet)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(limit)
      if (error) throw new Error(`qlc_deliveries query failed: ${error.message}`)
      return ((data ?? []) as DeliveryRow[]).map(toDeliveryRecord)
    },
    async listDueDeliveries(cluster, limit) {
      // next_attempt_at is set by record_qlc_delivery_attempt (backoff); NULL = never attempted.
      const { data, error } = await client
        .from("qlc_deliveries")
        .select(DELIVERY_COLUMNS)
        .eq("cluster", cluster)
        .eq("status", "pending")
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
        .order("next_attempt_at", { ascending: true, nullsFirst: true })
        .limit(limit)
      if (error) throw new Error(`qlc_deliveries query failed: ${error.message}`)
      return ((data ?? []) as DeliveryRow[]).map(toDeliveryRecord)
    },
    async getDelivery(id) {
      const { data, error } = await client.from("qlc_deliveries").select(DELIVERY_COLUMNS).eq("id", id).maybeSingle()
      if (error) throw new Error(`qlc_deliveries query failed: ${error.message}`)
      return data ? toDeliveryRecord(data as DeliveryRow) : null
    },
    async markDelivered(id, result) {
      const { error } = await client
        .from("qlc_deliveries")
        .update({
          status: "delivered",
          tx_signature: result.signature,
          from_vault: result.fromVault.toString(),
          minted: result.minted.toString(),
          delivered_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", id)
        .eq("status", "pending")
      if (error) throw new Error(`qlc_deliveries update failed: ${error.message}`)
    },
    async recordAttempt(id, message) {
      const { error } = await client.rpc("record_qlc_delivery_attempt", { p_delivery_id: id, p_error: message })
      if (error) throw new Error(`record_qlc_delivery_attempt failed: ${error.message}`)
    },
  }
}
