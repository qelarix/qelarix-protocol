// Database side of QLC generation billing (server only): thin adapter over the functions of
// supabase/proposed/20261006000001_qlc_generation_billing.sql. Every state change is a compare-and-set
// in the database, so a repeated call (retry, duplicate poll, concurrent request) reports the current
// state instead of changing it twice.
import type { SupabaseClient } from "@supabase/supabase-js"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import type { SolanaCluster } from "@/lib/solanaCluster"

export type QlcChargeStatus = "pending" | "charged" | "settled" | "refund_pending" | "refunded" | "charge_failed" | "closed"

export interface QlcEpochState {
  id: number
  status: "active" | "paused"
  limitAmount: bigint
  reservedAmount: bigint
  pauseReason: "budget_exhausted" | "owner" | null
}

export type ReserveResult =
  | { status: "reserved"; seq: bigint; epochId: number; remaining: bigint }
  | { status: "existing"; chargeStatus: QlcChargeStatus; seq: bigint; epochId: number; amount: bigint; wallet: string }
  | { status: "paused" | "budget_exhausted" | "no_epoch" | "invalid_request" }

export interface QlcChargeRecord {
  generationId: string
  userId: string | null
  wallet: string
  amount: bigint
  seq: bigint
  status: QlcChargeStatus
  releaseRequested: boolean
  updatedAt: string
}

export interface QlcChargeStore {
  currentEpoch(cluster: SolanaCluster): Promise<QlcEpochState | null>
  reserve(input: { generationId: string; cluster: SolanaCluster; userId: string; wallet: string; amount: bigint; minSeq: bigint }): Promise<ReserveResult>
  reassignSeq(generationId: string, minSeq: bigint): Promise<{ status: string; seq?: bigint }>
  markCharged(generationId: string, signature: string | null): Promise<{ status: string; chargeStatus?: QlcChargeStatus; releaseRequested?: boolean }>
  fail(generationId: string, error: string): Promise<{ status: string }>
  settle(generationId: string): Promise<{ status: string; chargeStatus?: QlcChargeStatus }>
  beginRefund(generationId: string): Promise<{ status: string; chargeStatus?: QlcChargeStatus; wallet?: string; seq?: bigint; amount?: bigint }>
  markRefunded(generationId: string, signature: string | null): Promise<{ status: string }>
  markClosed(generationId: string, signature: string | null): Promise<{ status: string }>
  recordError(generationId: string, error: string): Promise<void>
  /**
   * Charges the recovery job looks at, oldest first: every pending / charged / refund_pending charge, then
   * settled / refunded ones last updated before `closeBefore` (ready to close). Recent final charges are
   * left out so they never crowd open ones out of a batch.
   */
  listOpen(cluster: SolanaCluster, limit: number, closeBefore: Date): Promise<QlcChargeRecord[]>
  /**
   * Status of the generations behind charges (completed / failed / pending / processing / missing).
   * Cinema Studio lip-sync jobs are charged under their cinema_lip_sync_jobs id.
   */
  generationStatuses(generationIds: string[]): Promise<Map<string, string>>
}

type Json = Record<string, unknown>
const big = (value: unknown): bigint => BigInt(String(value ?? 0))

export function createSupabaseQlcChargeStore(client: SupabaseClient = createSupabaseAdmin() as unknown as SupabaseClient): QlcChargeStore {
  async function call(fn: string, args: Json): Promise<Json> {
    const { data, error } = await client.rpc(fn, args)
    if (error) throw new Error(`${fn} failed: ${error.message}`)
    return (data ?? {}) as Json
  }

  return {
    async currentEpoch(cluster) {
      const { data, error } = await client
        .from("qlc_generation_epochs")
        .select("id, status, limit_amount, reserved_amount, pause_reason")
        .eq("cluster", cluster)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`qlc_generation_epochs query failed: ${error.message}`)
      if (!data) return null
      const row = data as { id: number; status: "active" | "paused"; limit_amount: unknown; reserved_amount: unknown; pause_reason: QlcEpochState["pauseReason"] }
      return { id: Number(row.id), status: row.status, limitAmount: big(row.limit_amount), reservedAmount: big(row.reserved_amount), pauseReason: row.pause_reason }
    },

    async reserve(input) {
      const r = await call("reserve_qlc_generation_charge", {
        p_generation_id: input.generationId,
        p_cluster: input.cluster,
        p_user_id: input.userId,
        p_wallet: input.wallet,
        p_amount: input.amount.toString(),
        p_min_seq: input.minSeq.toString(),
      })
      if (r.status === "reserved") return { status: "reserved", seq: big(r.seq), epochId: Number(r.epochId), remaining: big(r.remaining) }
      if (r.status === "existing") {
        return { status: "existing", chargeStatus: r.chargeStatus as QlcChargeStatus, seq: big(r.seq), epochId: Number(r.epochId), amount: big(r.amount), wallet: String(r.wallet) }
      }
      return { status: r.status as "paused" | "budget_exhausted" | "no_epoch" | "invalid_request" }
    },

    async reassignSeq(generationId, minSeq) {
      const r = await call("reassign_qlc_charge_seq", { p_generation_id: generationId, p_min_seq: minSeq.toString() })
      return { status: String(r.status), ...(r.seq !== undefined ? { seq: big(r.seq) } : {}) }
    },

    async markCharged(generationId, signature) {
      const r = await call("mark_qlc_charge_charged", { p_generation_id: generationId, p_signature: signature })
      return { status: String(r.status), chargeStatus: r.chargeStatus as QlcChargeStatus | undefined, releaseRequested: r.releaseRequested === true }
    },

    async fail(generationId, error) {
      const r = await call("fail_qlc_charge", { p_generation_id: generationId, p_error: error })
      return { status: String(r.status) }
    },

    async settle(generationId) {
      const r = await call("settle_qlc_charge", { p_generation_id: generationId })
      return { status: String(r.status), chargeStatus: r.chargeStatus as QlcChargeStatus | undefined }
    },

    async beginRefund(generationId) {
      const r = await call("begin_qlc_charge_refund", { p_generation_id: generationId })
      return {
        status: String(r.status),
        chargeStatus: r.chargeStatus as QlcChargeStatus | undefined,
        ...(r.wallet ? { wallet: String(r.wallet) } : {}),
        ...(r.seq !== undefined && r.seq !== null ? { seq: big(r.seq) } : {}),
        ...(r.amount !== undefined && r.amount !== null ? { amount: big(r.amount) } : {}),
      }
    },

    async markRefunded(generationId, signature) {
      const r = await call("mark_qlc_charge_refunded", { p_generation_id: generationId, p_signature: signature })
      return { status: String(r.status) }
    },

    async markClosed(generationId, signature) {
      const r = await call("mark_qlc_charge_closed", { p_generation_id: generationId, p_signature: signature })
      return { status: String(r.status) }
    },

    async recordError(generationId, error) {
      await call("record_qlc_charge_error", { p_generation_id: generationId, p_error: error })
    },

    async listOpen(cluster, limit, closeBefore) {
      const columns = "generation_id, user_id, wallet_address, amount, seq, status, release_requested, updated_at"
      const open = await client
        .from("qlc_charges")
        .select(columns)
        .eq("cluster", cluster)
        .in("status", ["pending", "charged", "refund_pending"])
        .order("updated_at", { ascending: true })
        .limit(limit)
      if (open.error) throw new Error(`qlc_charges query failed: ${open.error.message}`)
      const rows = (open.data ?? []) as Json[]
      if (rows.length < limit) {
        const closable = await client
          .from("qlc_charges")
          .select(columns)
          .eq("cluster", cluster)
          .in("status", ["settled", "refunded"])
          .lt("updated_at", closeBefore.toISOString())
          .order("updated_at", { ascending: true })
          .limit(limit - rows.length)
        if (closable.error) throw new Error(`qlc_charges query failed: ${closable.error.message}`)
        rows.push(...((closable.data ?? []) as Json[]))
      }
      return rows.map((row) => ({
        generationId: String(row.generation_id),
        userId: (row.user_id as string | null) ?? null,
        wallet: String(row.wallet_address),
        amount: big(row.amount),
        seq: big(row.seq),
        status: row.status as QlcChargeStatus,
        releaseRequested: row.release_requested === true,
        updatedAt: String(row.updated_at),
      }))
    },

    async generationStatuses(generationIds) {
      const statuses = new Map<string, string>()
      if (generationIds.length === 0) return statuses
      const { data, error } = await client.from("generations").select("id, status").in("id", generationIds)
      if (error) throw new Error(`generations query failed: ${error.message}`)
      for (const row of (data ?? []) as { id: string; status: string }[]) statuses.set(row.id, row.status)
      const rest = generationIds.filter((id) => !statuses.has(id))
      if (rest.length > 0) {
        const jobs = await client.from("cinema_lip_sync_jobs").select("id, status").in("id", rest)
        if (jobs.error) throw new Error(`cinema_lip_sync_jobs query failed: ${jobs.error.message}`)
        for (const row of (jobs.data ?? []) as { id: string; status: string }[]) statuses.set(row.id, row.status)
      }
      return statuses
    },
  }
}
