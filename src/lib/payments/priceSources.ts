// Price sources turn the canonical USD value of a QLC pack into an exact payment amount. Every
// source is checked before use (owner, feed, verification, freshness, confidence); a quote is only
// issued from a fresh, trusted price, and the snapshot is stored with the quote.
import type { SolanaRpcCall } from "@/lib/solanaRpc"
import { PYTH_RECEIVER_PROGRAM, type PriceSourceConfig } from "./paymentAssets"
import { USD_DECIMALS, pow10 } from "./tokenAmount"

export interface PriceQuote {
  /** USD per 1 whole asset unit = price × 10^expo. */
  price: bigint
  expo: number
  source: string
  snapshot: Record<string, string | number>
}

export class PriceUnavailableError extends Error {
  name = "PriceUnavailableError"
}

/** Anchor discriminator of Pyth's PriceUpdateV2 account (sha256("account:PriceUpdateV2")[0..8]). */
const PRICE_UPDATE_V2_DISCRIMINATOR = "22f123639d7ef4cd"
const VERIFICATION_FULL = 1

interface AccountInfoResult {
  value: { owner: string; data: [string, string] } | null
}

/** Reads and checks a Pyth PriceUpdateV2 account. */
async function pythAccountQuote(rpc: SolanaRpcCall, config: Extract<PriceSourceConfig, { kind: "pyth-account" }>, now: Date): Promise<PriceQuote> {
  const { value } = await rpc<AccountInfoResult>("getAccountInfo", [config.account, { encoding: "base64", commitment: "confirmed" }])
  if (!value || value.owner !== PYTH_RECEIVER_PROGRAM) throw new PriceUnavailableError("Price account missing or not owned by the Pyth receiver")
  const data = Buffer.from(value.data[0], "base64")
  if (data.subarray(0, 8).toString("hex") !== PRICE_UPDATE_V2_DISCRIMINATOR) throw new PriceUnavailableError("Not a Pyth price update account")

  let offset = 8 + 32 // discriminator + write authority
  const verification = data[offset]
  if (verification !== VERIFICATION_FULL) throw new PriceUnavailableError("Price update is not fully verified")
  offset += 1
  const feedId = data.subarray(offset, offset + 32).toString("hex")
  offset += 32
  const price = data.readBigInt64LE(offset)
  offset += 8
  const conf = data.readBigUInt64LE(offset)
  offset += 8
  const expo = data.readInt32LE(offset)
  offset += 4
  const publishTime = Number(data.readBigInt64LE(offset))

  if (feedId !== config.feedId) throw new PriceUnavailableError("Price feed does not match the configured feed")
  if (price <= BigInt(0)) throw new PriceUnavailableError("Price is not positive")
  const age = Math.floor(now.getTime() / 1000) - publishTime
  if (age > config.maxAgeSecs || age < -30) throw new PriceUnavailableError(`Price is stale (${age}s old)`)
  if (conf * BigInt(10_000) > price * BigInt(config.maxConfidenceBps)) throw new PriceUnavailableError("Price confidence band is too wide")

  return {
    price,
    expo,
    source: `pyth:${config.feedId}`,
    snapshot: { account: config.account, feedId, price: price.toString(), conf: conf.toString(), expo, publishTime, ageSecs: age },
  }
}

export async function quotePrice(config: PriceSourceConfig, rpc: SolanaRpcCall, now: Date): Promise<PriceQuote> {
  if (config.kind === "usd-peg") return { price: BigInt(1), expo: 0, source: "usd-peg", snapshot: { price: "1", expo: 0 } }
  return pythAccountQuote(rpc, config, now)
}

/**
 * Exact payment amount (asset base units) for a USD value, rounded up so Qelarix is never paid
 * less than the pack value: ceil(usdMicros × 10^(decimals − 6 − expo) / price).
 */
export function paymentAmountFor(usdMicros: bigint, decimals: number, quote: Pick<PriceQuote, "price" | "expo">): bigint {
  const exponent = decimals - USD_DECIMALS - quote.expo
  const numerator = exponent >= 0 ? usdMicros * pow10(exponent) : usdMicros
  const denominator = exponent >= 0 ? quote.price : quote.price * pow10(-exponent)
  return (numerator + denominator - BigInt(1)) / denominator
}
