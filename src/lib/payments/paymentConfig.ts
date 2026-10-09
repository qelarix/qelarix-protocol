// Payment deployment settings (server only). Payments run only on clusters listed here; there is
// no default that could point a deployment at the wrong network. Assets, prices and treasuries are
// runtime configuration in the database (payment_assets, qlc_price_packs), never code.
import { getSolanaRpcUrl, parseSolanaCluster, type SolanaCluster } from "@/lib/solanaCluster"
import { walletChainFor } from "@/lib/walletSignIn"

/** Clusters where payments are enabled. Mainnet is enabled in a dedicated launch task. */
export const PAYMENT_CLUSTERS: readonly SolanaCluster[] = ["devnet"]

/** The RPC endpoint must report this genesis hash, so a misconfigured RPC URL cannot mix networks. */
export const CLUSTER_GENESIS_HASHES: Record<SolanaCluster, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
}

/** Payments count only once their transaction is finalized. */
export const PAYMENT_COMMITMENT = "finalized"
/** Open (pending, unexpired) quotes one user may hold at a time. */
export const MAX_OPEN_INTENTS_PER_USER = 5
/** A transaction built before the quote expired can still land until its blockhash expires. */
export const SETTLEMENT_GRACE_MS = 5 * 60 * 1000

export interface PaymentDeployment {
  cluster: SolanaCluster
  chain: `solana:${string}`
  rpcUrl: string
  genesisHash: string
}

export type PaymentDeploymentResult =
  | { enabled: true; deployment: PaymentDeployment }
  | { enabled: false; reason: "cluster_not_configured" | "cluster_not_enabled" }

export function resolvePaymentDeployment(env: Record<string, string | undefined> = process.env): PaymentDeploymentResult {
  const cluster = parseSolanaCluster(env.NEXT_PUBLIC_SOLANA_CLUSTER)
  if (!cluster) return { enabled: false, reason: "cluster_not_configured" }
  if (!PAYMENT_CLUSTERS.includes(cluster)) return { enabled: false, reason: "cluster_not_enabled" }
  return {
    enabled: true,
    deployment: {
      cluster,
      chain: walletChainFor(cluster),
      rpcUrl: env.SOLANA_RPC_URL || getSolanaRpcUrl(cluster),
      genesisHash: CLUSTER_GENESIS_HASHES[cluster],
    },
  }
}
