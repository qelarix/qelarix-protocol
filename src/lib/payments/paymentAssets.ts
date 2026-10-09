// Payment assets are configuration rows (payment_assets): USDC, SOL, QLX and any approved partner
// token are added or changed without code. A row only becomes payable when it is enabled, approved,
// complete and matches the deployment cluster; anything malformed is ignored (fails closed).
import { isAddress } from "@solana/kit"
import type { SolanaCluster } from "@/lib/solanaCluster"

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
/** Pyth receiver program that owns verified on-chain price update accounts. */
export const PYTH_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"

export type PaymentAssetKind = "spl-token" | "native-sol"

export type PriceSourceConfig =
  /** Fixed 1 asset unit = 1 USD (USDC). */
  | { kind: "usd-peg" }
  /** Pyth price update account read from chain, e.g. SOL/USD. */
  | { kind: "pyth-account"; account: string; feedId: string; maxAgeSecs: number; maxConfidenceBps: number }

export interface PaymentAsset {
  id: string
  cluster: SolanaCluster
  symbol: string
  kind: PaymentAssetKind
  mint: string | null
  tokenProgram: string | null
  decimals: number
  /** Wallet that receives payments; SPL payments go to its associated token account. */
  treasury: string
  priceSource: PriceSourceConfig
  quoteTtlSecs: number
  sortOrder: number
}

export interface PaymentAssetRow {
  id: string
  cluster: string
  symbol: string
  kind: string
  mint: string | null
  token_program: string | null
  decimals: number
  treasury_address: string
  price_source: unknown
  quote_ttl_secs: number
  is_enabled: boolean
  approved_by: string | null
  approved_at: string | null
  sort_order: number
}

const FEED_ID_PATTERN = /^[0-9a-f]{64}$/

function parsePriceSource(value: unknown): PriceSourceConfig | null {
  const source = value as Record<string, unknown> | null
  if (source?.kind === "usd-peg") return { kind: "usd-peg" }
  if (source?.kind === "pyth-account") {
    const { account, feedId, maxAgeSecs, maxConfidenceBps } = source
    if (
      typeof account === "string" && isAddress(account) &&
      typeof feedId === "string" && FEED_ID_PATTERN.test(feedId) &&
      typeof maxAgeSecs === "number" && maxAgeSecs > 0 && maxAgeSecs <= 300 &&
      typeof maxConfidenceBps === "number" && maxConfidenceBps > 0 && maxConfidenceBps <= 500
    ) {
      return { kind: "pyth-account", account, feedId, maxAgeSecs, maxConfidenceBps }
    }
  }
  return null
}

/** The payable asset described by a row, or null when it is disabled, unapproved or invalid. */
export function toPayableAsset(row: PaymentAssetRow, cluster: SolanaCluster): PaymentAsset | null {
  if (!row.is_enabled || !row.approved_by || !row.approved_at || row.cluster !== cluster) return null
  if (!isAddress(row.treasury_address)) return null
  if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 18) return null
  if (!Number.isInteger(row.quote_ttl_secs) || row.quote_ttl_secs < 30 || row.quote_ttl_secs > 3600) return null
  const priceSource = parsePriceSource(row.price_source)
  if (!priceSource) return null

  if (row.kind === "native-sol") {
    if (row.mint !== null || row.token_program !== null || row.decimals !== 9) return null
  } else if (row.kind === "spl-token") {
    if (!row.mint || !isAddress(row.mint)) return null
    if (row.token_program !== TOKEN_PROGRAM && row.token_program !== TOKEN_2022_PROGRAM) return null
  } else {
    return null
  }

  return {
    id: row.id,
    cluster,
    symbol: row.symbol,
    kind: row.kind,
    mint: row.mint,
    tokenProgram: row.token_program,
    decimals: row.decimals,
    treasury: row.treasury_address,
    priceSource,
    quoteTtlSecs: row.quote_ttl_secs,
    sortOrder: row.sort_order,
  }
}

export function payableAssets(rows: PaymentAssetRow[], cluster: SolanaCluster): PaymentAsset[] {
  return rows
    .map((row) => toPayableAsset(row, cluster))
    .filter((asset): asset is PaymentAsset => asset !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
}
