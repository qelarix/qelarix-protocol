// Owner CLI for the QLC generation test epochs (supabase/proposed/20261006000001_qlc_generation_billing.sql).
// Authorization is possession of the project's service-role key (.env.local). Nothing here is automatic:
// a paused epoch stays paused until the owner opens a new one, and earlier epochs are never changed.
//
//   npx tsx --env-file .env.local scripts/qlc-epoch.ts status                 read-only: every epoch, newest first
//   npx tsx --env-file .env.local scripts/qlc-epoch.ts open --limit 15000 --reason "<why>" --operator <name> [--key <unique>]
//                                                                             OWNER MUTATION: opens a new epoch (QLC, whole units)
//   npx tsx --env-file .env.local scripts/qlc-epoch.ts pause --operator <name> --note "<why>"
//                                                                             OWNER MUTATION: pauses the active epoch now
//
// The cluster is the deployment's NEXT_PUBLIC_SOLANA_CLUSTER. Repeating `open` with the same --key returns
// the same epoch instead of opening a second one.
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { formatQlc } from "../src/lib/qlc/qlcProgram"
import { getSolanaCluster } from "../src/lib/solanaCluster"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const command = process.argv[2]
  const cluster = getSolanaCluster()
  if (!cluster) throw new Error("NEXT_PUBLIC_SOLANA_CLUSTER is not configured")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  if (command === "status") {
    const { data, error } = await db.from("qlc_generation_epoch_totals").select("*").eq("cluster", cluster).order("epoch_id", { ascending: false })
    if (error) throw new Error(error.message)
    if (!data?.length) {
      console.log(`${cluster}: no epoch opened yet (QLC generation stays paused until the owner opens one)`)
      return
    }
    for (const e of data as Record<string, unknown>[]) {
      console.log(
        `epoch ${e.epoch_id}  ${String(e.status).toUpperCase()}  reserved ${formatQlc(String(e.reserved_amount))} / ${formatQlc(String(e.limit_amount))} QLC` +
          `  remaining ${formatQlc(String(e.remaining_amount))}  refunded ${formatQlc(String(e.refunded_amount))}  released ${formatQlc(String(e.released_amount))}` +
          `  reservations ${e.reservations}  settled ${e.settled_count}  refunded ${e.refunded_count}  open ${e.open_count}  pending ${e.pending_count}  failed ${e.charge_failed_count}` +
          `\n  opened ${e.opened_at} by ${e.opened_by} (${e.open_reason})` +
          (e.paused_at ? `\n  paused ${e.paused_at} by ${e.paused_by}: ${e.pause_reason}${e.rejected_amount ? ` (request of ${formatQlc(String(e.rejected_amount))} QLC did not fit)` : ""}` : ""),
      )
    }
    return
  }

  if (command === "open") {
    const limitQlc = Number(arg("limit"))
    const reason = arg("reason")
    const operator = arg("operator")
    if (!Number.isFinite(limitQlc) || limitQlc <= 0 || !reason || !operator) throw new Error("open needs --limit <QLC> --reason <text> --operator <name>")
    const limit = BigInt(Math.round(limitQlc * 100))
    if (limit % BigInt(5) !== BigInt(0)) throw new Error("the limit must be a multiple of 0.05 QLC")
    const { data, error } = await db.rpc("open_qlc_generation_epoch", {
      p_cluster: cluster, p_limit: limit.toString(), p_opened_by: operator, p_reason: reason, p_request_key: arg("key") ?? `epoch:${randomUUID()}`,
    })
    if (error) throw new Error(error.message)
    console.log(JSON.stringify(data))
    return
  }

  if (command === "pause") {
    const operator = arg("operator")
    if (!operator) throw new Error("pause needs --operator <name>")
    const { data, error } = await db.rpc("pause_qlc_generation_epoch", { p_cluster: cluster, p_paused_by: operator, p_note: arg("note") ?? null })
    if (error) throw new Error(error.message)
    console.log(JSON.stringify(data))
    return
  }

  throw new Error("usage: qlc-epoch.ts status | open --limit <QLC> --reason <text> --operator <name> [--key <unique>] | pause --operator <name> [--note <text>]")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
