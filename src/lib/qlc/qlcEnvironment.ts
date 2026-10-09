// QLC operator for this deployment (server only). Configured by:
//   QLC_MINT_ADDRESS        the cluster's QLC mint
//   QLC_OPERATOR_SECRET_KEY JSON byte array of the operator keypair: a relayer / fee payer with no
//                           token authority. Never commit it, log it or store it anywhere else.
//   SOLANA_RPC_URL / SOLANA_WS_URL (optional) server RPC endpoints
// QLC runs only on PAYMENT_CLUSTERS. The program self-check (initialized, same mint, same operator)
// runs once per process; until it passes, QLC delivery is unavailable and no payment is quoted.
import { address, createKeyPairSignerFromBytes, createSolanaRpc, createSolanaRpcSubscriptions, isAddress } from "@solana/kit"
import { PAYMENT_CLUSTERS } from "@/lib/payments/paymentConfig"
import { getSolanaRpcUrl, parseSolanaCluster } from "@/lib/solanaCluster"
import { createQlcOperator, type QlcOperator } from "./qlcOperator"

export type QlcEnvironmentResult =
  | { enabled: true; operator: QlcOperator; spendAuthority: string; mint: string }
  | { enabled: false; reason: "cluster_not_enabled" | "qlc_not_configured" | "qlc_self_check_failed" }

let cached: Promise<QlcEnvironmentResult> | null = null

function websocketUrlFor(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws")
}

async function resolve(env: Record<string, string | undefined>): Promise<QlcEnvironmentResult> {
  const cluster = parseSolanaCluster(env.NEXT_PUBLIC_SOLANA_CLUSTER)
  if (!cluster || !PAYMENT_CLUSTERS.includes(cluster)) return { enabled: false, reason: "cluster_not_enabled" }
  const mint = env.QLC_MINT_ADDRESS?.trim()
  const secret = env.QLC_OPERATOR_SECRET_KEY?.trim()
  if (!mint || !isAddress(mint) || !secret) return { enabled: false, reason: "qlc_not_configured" }

  let bytes: Uint8Array
  try {
    const parsed = JSON.parse(secret) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 64) return { enabled: false, reason: "qlc_not_configured" }
    bytes = Uint8Array.from(parsed as number[])
  } catch {
    return { enabled: false, reason: "qlc_not_configured" }
  }

  const httpUrl = env.SOLANA_RPC_URL || getSolanaRpcUrl(cluster)
  const operator = createQlcOperator({
    rpc: createSolanaRpc(httpUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(env.SOLANA_WS_URL || websocketUrlFor(httpUrl)),
    operator: await createKeyPairSignerFromBytes(bytes),
    mint: address(mint),
  })
  try {
    await operator.selfCheck()
  } catch (err) {
    console.error("[qlc] self-check failed:", err instanceof Error ? err.message : err)
    return { enabled: false, reason: "qlc_self_check_failed" }
  }
  const { findSpendAuthorityPda } = await import("./generated")
  const [spendAuthority] = await findSpendAuthorityPda()
  return { enabled: true, operator, spendAuthority, mint }
}

/** The deployment's QLC operator; resolved once per process (a failed check is retried next call). */
export function getQlcEnvironment(env: Record<string, string | undefined> = process.env): Promise<QlcEnvironmentResult> {
  if (!cached) {
    cached = resolve(env).then((result) => {
      if (!result.enabled && result.reason === "qlc_self_check_failed") cached = null
      return result
    })
  }
  return cached
}
