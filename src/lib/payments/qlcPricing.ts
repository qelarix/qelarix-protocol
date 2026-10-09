// QLC pricing is runtime configuration stored in qlc_price_packs (one row per pack, per cluster).
// Each pack has one canonical USD value; the payment amount in any asset is derived from it at quote
// time. Discounts, temporary offers, regional prices and mainnet prices are rows, read again for
// every offer and quote. QLC amounts are base units (2 decimals) on the 0.05 QLC step.
import type { SolanaCluster } from "@/lib/solanaCluster"
import { isQlcStep } from "@/lib/qlc/qlcProgram"

export interface PricePackRow {
  id: string
  cluster: string
  qlc_amount: number | string
  usd_value_micros: number | string
  list_usd_value_micros: number | string | null
  label: string
  badge: string | null
  highlighted: boolean
  region: string | null
  replaces_pack_id: string | null
  offer: string | null
  sort_order: number
  is_active: boolean
  starts_at: string | null
  ends_at: string | null
}

export interface QlcPricePack {
  id: string
  /** QLC base units (2 decimals). */
  qlcAmount: bigint
  /** Canonical pack value in USD micro-dollars (6 decimals). */
  usdValueMicros: bigint
  /** Regular value shown struck through while the pack is discounted. */
  listUsdValueMicros: bigint | null
  label: string
  badge: string | null
  highlighted: boolean
  offer: string | null
}

const REGION_PATTERN = /^[A-Z]{2}$/

function isLive(row: PricePackRow, cluster: SolanaCluster, now: number): boolean {
  return (
    row.cluster === cluster &&
    row.is_active &&
    (!row.starts_at || Date.parse(row.starts_at) <= now) &&
    (!row.ends_at || Date.parse(row.ends_at) > now)
  )
}

/**
 * Packs offered right now. Rows must be live (active, inside their time window, this cluster).
 * A visitor from a region with its own live packs sees only those; everyone else sees the
 * region-less packs. A live row hides the pack named in its replaces_pack_id.
 */
export function selectOfferedPacks(
  rows: PricePackRow[],
  { cluster, region, now }: { cluster: SolanaCluster; region: string | null; now: Date },
): QlcPricePack[] {
  const time = now.getTime()
  const live = rows.filter((row) => isLive(row, cluster, time) && isQlcStep(BigInt(row.qlc_amount)) && BigInt(row.usd_value_micros) > BigInt(0))
  const regional = region ? live.filter((row) => row.region === region) : []
  const selected = regional.length > 0 ? regional : live.filter((row) => row.region === null)
  const replaced = new Set(selected.flatMap((row) => (row.replaces_pack_id ? [row.replaces_pack_id] : [])))

  return selected
    .filter((row) => !replaced.has(row.id))
    .sort((a, b) => a.sort_order - b.sort_order || Number(BigInt(a.qlc_amount) - BigInt(b.qlc_amount)) || a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      qlcAmount: BigInt(row.qlc_amount),
      usdValueMicros: BigInt(row.usd_value_micros),
      listUsdValueMicros: row.list_usd_value_micros === null ? null : BigInt(row.list_usd_value_micros),
      label: row.label,
      badge: row.badge,
      highlighted: row.highlighted,
      offer: row.offer,
    }))
}

/**
 * Visitor region for regional pricing, taken only from the trusted platform header named in
 * PRICING_REGION_HEADER (such as x-vercel-ip-country). Unset → no regional pricing.
 */
export function resolvePricingRegion(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const headerName = env.PRICING_REGION_HEADER?.trim()
  if (!headerName) return null
  const value = headers.get(headerName)?.trim().toUpperCase() ?? ""
  return REGION_PATTERN.test(value) ? value : null
}
