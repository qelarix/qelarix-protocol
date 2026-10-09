// Solana cluster this deployment serves. Features that depend on it (credit campaigns, payments)
// stay disabled when NEXT_PUBLIC_SOLANA_CLUSTER is missing or invalid: no implicit default.

export const SOLANA_CLUSTERS = ["devnet", "mainnet-beta"] as const
export type SolanaCluster = (typeof SOLANA_CLUSTERS)[number]

const PUBLIC_RPC_URLS: Record<SolanaCluster, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
}

export function parseSolanaCluster(value: string | undefined): SolanaCluster | null {
  return SOLANA_CLUSTERS.find((cluster) => cluster === value) ?? null
}

export function getSolanaCluster(): SolanaCluster | null {
  return parseSolanaCluster(process.env.NEXT_PUBLIC_SOLANA_CLUSTER)
}

/** Server-side RPC endpoint. SOLANA_RPC_URL may carry an API key, so it is never NEXT_PUBLIC. */
export function getSolanaRpcUrl(cluster: SolanaCluster): string {
  return process.env.SOLANA_RPC_URL || PUBLIC_RPC_URLS[cluster]
}
