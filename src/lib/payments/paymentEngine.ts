// Generic QLC payment engine: one quote / verification / settlement flow for every payment asset
// (USDC, SOL, future QLX and approved partner tokens), converging on the exactly-once QLC delivery
// pipeline. The server decides everything: the pack's canonical USD value, the asset, its trusted
// price, the exact payment amount, treasury and expiry. QLC is delivered on chain only after the
// finalized payment has been verified and settled in the database (settle_payment_intent).
//
// The payment transaction also carries register_member for the payer (idempotent): the wallet's
// signature on its own payment is its membership consent, and the operator's partial signature pays
// the member-account rent. Either both the payment and the membership happen, or neither does, so a
// paid purchase can always be delivered.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { createSolanaRpcCall, type SolanaRpcCall } from "@/lib/solanaRpc"
import type { SolanaCluster } from "@/lib/solanaCluster"
import { getQlcEnvironment } from "@/lib/qlc/qlcEnvironment"
import type { QlcLimits } from "@/lib/qlc/qlcOperator"
import { adapterFor, type ExpectedPayment, type ParsedTransaction, type PaymentRejection, type VerifiedPayment } from "./adapters"
import { createPaymentReference } from "./paymentReference"
import { payableAssets, type PaymentAsset, type PaymentAssetKind, type PaymentAssetRow } from "./paymentAssets"
import {
  MAX_OPEN_INTENTS_PER_USER,
  PAYMENT_COMMITMENT,
  SETTLEMENT_GRACE_MS,
  resolvePaymentDeployment,
  type PaymentDeployment,
  type PaymentDeploymentResult,
} from "./paymentConfig"
import { PriceUnavailableError, paymentAmountFor, quotePrice } from "./priceSources"
import { selectOfferedPacks, type PricePackRow } from "./qlcPricing"
import { DELIVERY_COLUMNS, createSupabaseDeliveryStore, processDelivery, toDeliveryRecord, type DeliveryOutcome, type DeliveryStore, type QlcDeliverer, type QlcDeliveryRecord } from "./qlcDeliveries"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
export const TRANSACTION_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/

export interface PaymentIntent {
  id: string
  userId: string | null
  walletAddress: string
  cluster: string
  packId: string
  offer: string | null
  qlcAmount: bigint
  usdValueMicros: bigint
  assetId: string
  assetSymbol: string
  assetKind: PaymentAssetKind
  mint: string | null
  tokenProgram: string | null
  decimals: number
  paymentAmount: bigint
  treasury: string
  destinationAccount: string
  priceSource: string
  priceSnapshot: Record<string, string | number>
  quotedAt: Date
  expiresAt: Date
  reference: string
  /** "expired": closed by the recovery job after a final lookup found no payment; still settleable. */
  status: "pending" | "paid" | "expired"
  txSignature: string | null
  deliveryId: string | null
}

export type NewPaymentIntent = Omit<PaymentIntent, "id" | "status" | "txSignature" | "deliveryId">

export type SettleStatus =
  | "paid"
  | "already_paid"
  | "intent_already_paid"
  | "unknown_intent"
  | "invalid_request"
  | "cluster_mismatch"
  | "payer_mismatch"
  | "asset_mismatch"
  | "destination_mismatch"
  | "amount_mismatch"
  | "reference_mismatch"
  | "expired"
  | "signature_used"

export interface SettleOutcome {
  status: SettleStatus
  deliveryId?: string
  signature?: string
}

export interface PaymentStore extends DeliveryStore {
  listPricePacks(cluster: SolanaCluster): Promise<PricePackRow[]>
  listPaymentAssets(cluster: SolanaCluster): Promise<PaymentAssetRow[]>
  countOpenIntents(userId: string, now: Date): Promise<number>
  createIntent(intent: NewPaymentIntent): Promise<PaymentIntent>
  getIntent(intentId: string): Promise<PaymentIntent | null>
  getDelivery(deliveryId: string): Promise<QlcDeliveryRecord | null>
  settle(intent: PaymentIntent, userId: string, payment: VerifiedPayment): Promise<SettleOutcome>
  /** Pending quotes of a cluster, oldest first (for the recovery job). */
  listPendingIntents(cluster: SolanaCluster, limit: number): Promise<PaymentIntent[]>
  /** Marks a still-pending quote that expired before `cutoff` as expired; false if it changed meanwhile. */
  closeExpiredIntent(intentId: string, cutoff: Date): Promise<boolean>
  /** Pending deliveries of a cluster whose retry time has come, most overdue first. */
  listDueDeliveries(cluster: SolanaCluster, limit: number): Promise<QlcDeliveryRecord[]>
}

/** What the payment engine needs from the QLC operator (see src/lib/qlc/qlcOperator.ts). */
export interface QlcPaymentOperator extends QlcDeliverer {
  /** register_member for the wallet, operator-signed (as a signer of the instruction); the wallet co-signs. */
  membershipInstruction(wallet: Address): Promise<Instruction>
  /** The program's current delivery limits, read live from chain. */
  limits(): Promise<QlcLimits>
}

export interface PaymentEngineDeps {
  deployment: PaymentDeploymentResult
  store: PaymentStore
  rpc: SolanaRpcCall
  /** Null when QLC delivery is not available on this deployment: no payment is quoted then. */
  qlc: QlcPaymentOperator | null
  now: () => Date
  newReference: () => string
}

export class PaymentClusterMismatchError extends Error {
  name = "PaymentClusterMismatchError"
}

export async function defaultPaymentEngineDeps(): Promise<PaymentEngineDeps> {
  const deployment = resolvePaymentDeployment()
  const qlc = await getQlcEnvironment()
  return {
    deployment,
    store: createSupabasePaymentStore(),
    rpc: createSolanaRpcCall(deployment.enabled ? deployment.deployment.rpcUrl : ""),
    qlc: qlc.enabled ? qlc.operator : null,
    now: () => new Date(),
    newReference: createPaymentReference,
  }
}

// ── Results ──────────────────────────────────────────────────────────────────

export interface OfferedPack {
  id: string
  qlcAmount: string
  usdValueMicros: string
  listUsdValueMicros: string | null
  label: string
  badge: string | null
  highlighted: boolean
}

export interface OfferedAsset {
  id: string
  symbol: string
  kind: PaymentAssetKind
  decimals: number
}

export interface IntentSummary {
  id: string
  packId: string
  qlcAmount: string
  usdValueMicros: string
  asset: OfferedAsset
  paymentAmount: string
  expiresAt: string
}

type Disabled = { status: "disabled"; reason: string }

export type OfferResult =
  | Disabled
  | { status: "wallet_required" }
  | { status: "ok"; cluster: SolanaCluster; chain: string; packs: OfferedPack[]; assets: OfferedAsset[] }

export type CreateIntentResult =
  | Disabled
  | { status: "wallet_required" | "unknown_pack" | "unknown_asset" | "too_many_open_intents" | "treasury_not_ready" | "insufficient_sol" | "price_unavailable" }
  | { status: "insufficient_funds"; symbol: string; decimals: number; required: string; available: string }
  | { status: "ok"; intent: IntentSummary; transaction: string }

export type TransactionResult =
  | Disabled
  | { status: "unknown_intent" | "paid" | "expired" | "unknown_asset" | "unknown_pack" | "qlc_unavailable" }
  | { status: "ok"; intent: IntentSummary; transaction: string }

export type DeliveryState = { status: "delivered"; signature: string | null; fromVault: string; minted: string } | { status: "pending" }

export type ConfirmResult =
  | Disabled
  | { status: "unknown_intent" | "invalid_signature" | "pending" | "expired" }
  | { status: "paid"; intentId: string; qlcAmount: string; signature: string; delivery: DeliveryState }
  | { status: "intent_already_paid"; signature: string | null }
  | { status: "failed"; reason: PaymentRejection | SettleStatus }

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A pack is sold only if it can always be delivered under the program's current on-chain limits: at
 * most the per-delivery limit and at most the newly minted QLC allowed per window (the vault may hold
 * no inventory). Limits are read live, so offers follow every update_config automatically.
 */
export function isDeliverable(qlcAmount: bigint, limits: QlcLimits): boolean {
  return qlcAmount <= limits.maxDeliveryAmount && qlcAmount <= limits.mintWindowCap
}

type LimitsResult = { status: "ok"; limits: QlcLimits } | Disabled

/** Current limits, or why nothing can be sold right now (limits unreadable, or the program is paused). */
async function sellableLimits(qlc: QlcPaymentOperator): Promise<LimitsResult> {
  let limits: QlcLimits
  try {
    limits = await qlc.limits()
  } catch (err) {
    console.error("[payments] QLC limits unavailable:", err instanceof Error ? err.message : err)
    return { status: "disabled", reason: "qlc_unavailable" }
  }
  return limits.paused ? { status: "disabled", reason: "qlc_paused" } : { status: "ok", limits }
}

const genesisChecked = new Set<string>()

export async function ensureCluster(deployment: PaymentDeployment, rpc: SolanaRpcCall): Promise<void> {
  if (genesisChecked.has(deployment.rpcUrl)) return
  if ((await rpc<string>("getGenesisHash", [])) !== deployment.genesisHash) {
    throw new PaymentClusterMismatchError(`RPC endpoint is not ${deployment.cluster}`)
  }
  genesisChecked.add(deployment.rpcUrl)
}

function offeredAsset(asset: Pick<PaymentAsset, "id" | "symbol" | "kind" | "decimals">): OfferedAsset {
  return { id: asset.id, symbol: asset.symbol, kind: asset.kind, decimals: asset.decimals }
}

function summarize(intent: PaymentIntent): IntentSummary {
  return {
    id: intent.id,
    packId: intent.packId,
    qlcAmount: intent.qlcAmount.toString(),
    usdValueMicros: intent.usdValueMicros.toString(),
    asset: { id: intent.assetId, symbol: intent.assetSymbol, kind: intent.assetKind, decimals: intent.decimals },
    paymentAmount: intent.paymentAmount.toString(),
    expiresAt: intent.expiresAt.toISOString(),
  }
}

async function payableAsset(deps: PaymentEngineDeps, cluster: SolanaCluster, assetId: string): Promise<PaymentAsset | null> {
  return payableAssets(await deps.store.listPaymentAssets(cluster), cluster).find((asset) => asset.id === assetId) ?? null
}

async function loadOwnIntent(user: AuthUser, intentId: string, cluster: SolanaCluster, store: PaymentStore): Promise<PaymentIntent | null> {
  if (!user.walletAddress || !UUID_PATTERN.test(intentId)) return null
  const intent = await store.getIntent(intentId)
  if (!intent || intent.userId !== user.id || intent.walletAddress !== user.walletAddress || intent.cluster !== cluster) return null
  return intent
}

/**
 * The payment transaction for a stored quote: [register_member, transfer], fee paid by the payer,
 * partially signed by the operator. Base64 wire format with an empty signature slot for the payer.
 */
async function buildTransaction(intent: PaymentIntent, asset: PaymentAsset, rpc: SolanaRpcCall, qlc: QlcPaymentOperator): Promise<string> {
  const payer = intent.walletAddress as Address
  const [{ value }, membership, transfer] = await Promise.all([
    rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]),
    qlc.membershipInstruction(payer),
    adapterFor(intent.assetKind).transferInstruction({
      asset,
      payer: intent.walletAddress,
      destinationAccount: intent.destinationAccount,
      amount: intent.paymentAmount,
      reference: intent.reference,
    }),
  ])
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: value.blockhash as Blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstructions([membership, transfer], m),
  )
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message))
}

export async function deliveryState(deliveryId: string | null | undefined, deps: PaymentEngineDeps): Promise<DeliveryState> {
  if (!deliveryId) return { status: "pending" }
  const record = await deps.store.getDelivery(deliveryId)
  if (!record) return { status: "pending" }
  const outcome: DeliveryOutcome = await processDelivery(record, { qlc: deps.qlc, store: deps.store })
  return outcome.status === "delivered"
    ? { status: "delivered", signature: outcome.signature, fromVault: outcome.fromVault.toString(), minted: outcome.minted.toString() }
    : { status: "pending" }
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Packs and payable assets currently offered to the signed-in wallet user. */
export async function getPaymentOffer(user: AuthUser, region: string | null, deps: PaymentEngineDeps): Promise<OfferResult> {
  if (!deps.deployment.enabled) return { status: "disabled", reason: deps.deployment.reason }
  if (!deps.qlc) return { status: "disabled", reason: "qlc_unavailable" }
  if (!user.walletAddress) return { status: "wallet_required" }
  const sellable = await sellableLimits(deps.qlc)
  if (sellable.status !== "ok") return sellable
  const { limits } = sellable
  const { cluster, chain } = deps.deployment.deployment
  const [packRows, assetRows] = await Promise.all([deps.store.listPricePacks(cluster), deps.store.listPaymentAssets(cluster)])
  const assets = payableAssets(assetRows, cluster)
  if (assets.length === 0) return { status: "disabled", reason: "no_payment_assets" }
  return {
    status: "ok",
    cluster,
    chain,
    assets: assets.map(offeredAsset),
    packs: selectOfferedPacks(packRows, { cluster, region, now: deps.now() }).filter((pack) => isDeliverable(pack.qlcAmount, limits)).map((pack) => ({
      id: pack.id,
      qlcAmount: pack.qlcAmount.toString(),
      usdValueMicros: pack.usdValueMicros.toString(),
      listUsdValueMicros: pack.listUsdValueMicros?.toString() ?? null,
      label: pack.label,
      badge: pack.badge,
      highlighted: pack.highlighted,
    })),
  }
}

/**
 * Quotes one pack in one asset at the current trusted price and returns the unsigned transfer for
 * the user's wallet. Nothing is delivered here.
 */
export async function createPaymentIntent(
  user: AuthUser,
  input: { packId: unknown; assetId: unknown },
  region: string | null,
  deps: PaymentEngineDeps,
): Promise<CreateIntentResult> {
  if (!deps.deployment.enabled) return { status: "disabled", reason: deps.deployment.reason }
  if (!deps.qlc) return { status: "disabled", reason: "qlc_unavailable" }
  const wallet = user.walletAddress
  if (!wallet) return { status: "wallet_required" }
  if (typeof input.packId !== "string" || !ID_PATTERN.test(input.packId)) return { status: "unknown_pack" }
  if (typeof input.assetId !== "string" || !ID_PATTERN.test(input.assetId)) return { status: "unknown_asset" }

  const { deployment } = deps.deployment
  const { store, rpc } = deps
  await ensureCluster(deployment, rpc)
  const sellable = await sellableLimits(deps.qlc)
  if (sellable.status !== "ok") return sellable
  const now = deps.now()
  const pack = selectOfferedPacks(await store.listPricePacks(deployment.cluster), { cluster: deployment.cluster, region, now }).find(
    (p) => p.id === input.packId,
  )
  if (!pack || !isDeliverable(pack.qlcAmount, sellable.limits)) return { status: "unknown_pack" }
  const asset = await payableAsset(deps, deployment.cluster, input.assetId)
  if (!asset) return { status: "unknown_asset" }
  if ((await store.countOpenIntents(user.id, now)) >= MAX_OPEN_INTENTS_PER_USER) return { status: "too_many_open_intents" }

  let quote
  try {
    quote = await quotePrice(asset.priceSource, rpc, now)
  } catch (err) {
    if (err instanceof PriceUnavailableError) return { status: "price_unavailable" }
    throw err
  }
  const paymentAmount = paymentAmountFor(pack.usdValueMicros, asset.decimals, quote)
  const adapter = adapterFor(asset.kind)
  const destinationAccount = await adapter.destinationAccount(asset)
  const preflight = await adapter.preflight(rpc, asset, wallet, destinationAccount, paymentAmount)
  if (preflight.status === "destination_not_ready") return { status: "treasury_not_ready" }
  if (preflight.status === "insufficient_sol") return { status: "insufficient_sol" }
  if (preflight.status === "insufficient_funds") {
    return { status: "insufficient_funds", symbol: asset.symbol, decimals: asset.decimals, required: preflight.required.toString(), available: preflight.available.toString() }
  }

  const intent = await store.createIntent({
    userId: user.id,
    walletAddress: wallet,
    cluster: deployment.cluster,
    packId: pack.id,
    offer: pack.offer,
    qlcAmount: pack.qlcAmount,
    usdValueMicros: pack.usdValueMicros,
    assetId: asset.id,
    assetSymbol: asset.symbol,
    assetKind: asset.kind,
    mint: asset.mint,
    tokenProgram: asset.tokenProgram,
    decimals: asset.decimals,
    paymentAmount,
    treasury: asset.treasury,
    destinationAccount,
    priceSource: quote.source,
    priceSnapshot: quote.snapshot,
    quotedAt: now,
    expiresAt: new Date(now.getTime() + asset.quoteTtlSecs * 1000),
    reference: deps.newReference(),
  })
  return { status: "ok", intent: summarize(intent), transaction: await buildTransaction(intent, asset, rpc, deps.qlc) }
}

/** A fresh unsigned transfer (new blockhash) for an open quote, e.g. after a declined signature. */
export async function createPaymentTransaction(user: AuthUser, intentId: string, deps: PaymentEngineDeps): Promise<TransactionResult> {
  if (!deps.deployment.enabled) return { status: "disabled", reason: deps.deployment.reason }
  const { deployment } = deps.deployment
  const intent = await loadOwnIntent(user, intentId, deployment.cluster, deps.store)
  if (!intent) return { status: "unknown_intent" }
  if (intent.status === "paid") return { status: "paid" }
  if (intent.status === "expired" || deps.now() >= intent.expiresAt) return { status: "expired" }
  if (!deps.qlc) return { status: "qlc_unavailable" }
  // A pack the program can no longer deliver (limits lowered, program paused) takes no further payments.
  const sellable = await sellableLimits(deps.qlc)
  if (sellable.status !== "ok") return sellable
  if (!isDeliverable(intent.qlcAmount, sellable.limits)) return { status: "unknown_pack" }
  // An asset disabled after the quote takes no further payments.
  const asset = await payableAsset(deps, deployment.cluster, intent.assetId)
  if (!asset) return { status: "unknown_asset" }
  await ensureCluster(deployment, deps.rpc)
  return { status: "ok", intent: summarize(intent), transaction: await buildTransaction(intent, asset, deps.rpc, deps.qlc) }
}

export type SettlementResult =
  | { status: "settled"; signature: string; deliveryId: string | null }
  | { status: "intent_already_paid"; signature: string | null }
  | { status: "failed"; reason: PaymentRejection | SettleStatus }
  /** No finalized payment for this quote (yet). */
  | { status: "not_found" }

/**
 * Finds the quote's payment on chain (that one signature, or by the quote reference), verifies it
 * against the stored quote and settles it once. Shared by the buyer's confirm and the recovery job;
 * the caller must already have checked the cluster (ensureCluster).
 */
export async function verifyAndSettle(intent: PaymentIntent, userId: string, signature: string | null, deps: PaymentEngineDeps): Promise<SettlementResult> {
  const { store, rpc } = deps
  const adapter = adapterFor(intent.assetKind)
  const expected: ExpectedPayment = {
    payer: intent.walletAddress,
    treasury: intent.treasury,
    destinationAccount: intent.destinationAccount,
    amount: intent.paymentAmount,
    reference: intent.reference,
    mint: intent.mint,
    tokenProgram: intent.tokenProgram,
    decimals: intent.decimals,
  }
  const candidates = signature
    ? [signature]
    : (await rpc<{ signature: string }[]>("getSignaturesForAddress", [intent.reference, { commitment: PAYMENT_COMMITMENT, limit: 20 }])).map((row) => row.signature)

  let rejection: PaymentRejection | null = null
  for (const candidate of candidates) {
    const tx = await rpc<ParsedTransaction | null>("getTransaction", [
      candidate,
      { commitment: PAYMENT_COMMITMENT, encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ])
    const verification = adapter.verify(candidate, tx, expected)
    if (verification.status === "not_found") continue
    if (verification.status === "rejected") {
      rejection ??= verification.reason
      continue
    }
    const outcome = await store.settle(intent, userId, verification.payment)
    if (outcome.status === "paid" || outcome.status === "already_paid") return { status: "settled", signature: candidate, deliveryId: outcome.deliveryId ?? null }
    if (outcome.status === "intent_already_paid") return { status: "intent_already_paid", signature: outcome.signature ?? null }
    return { status: "failed", reason: outcome.status }
  }
  return rejection ? { status: "failed", reason: rejection } : { status: "not_found" }
}

/**
 * Verifies the payment for a quote, settles it once and delivers the QLC. With a signature only that
 * transaction is checked; without one the quote reference is looked up on chain. Safe to repeat:
 * a paid quote returns its original result and retries a pending delivery.
 */
export async function confirmPayment(user: AuthUser, intentId: string, signature: string | null, deps: PaymentEngineDeps): Promise<ConfirmResult> {
  if (!deps.deployment.enabled) return { status: "disabled", reason: deps.deployment.reason }
  if (signature !== null && !TRANSACTION_SIGNATURE_PATTERN.test(signature)) return { status: "invalid_signature" }
  const { deployment } = deps.deployment
  const { store, rpc } = deps
  const intent = await loadOwnIntent(user, intentId, deployment.cluster, store)
  if (!intent) return { status: "unknown_intent" }

  if (intent.status === "paid") {
    if (signature && signature !== intent.txSignature) return { status: "intent_already_paid", signature: intent.txSignature }
    return { status: "paid", intentId: intent.id, qlcAmount: intent.qlcAmount.toString(), signature: intent.txSignature!, delivery: await deliveryState(intent.deliveryId, deps) }
  }

  await ensureCluster(deployment, rpc)
  const result = await verifyAndSettle(intent, user.id, signature, deps)
  if (result.status === "settled") {
    return { status: "paid", intentId: intent.id, qlcAmount: intent.qlcAmount.toString(), signature: result.signature, delivery: await deliveryState(result.deliveryId, deps) }
  }
  if (result.status !== "not_found") return result
  return deps.now().getTime() > intent.expiresAt.getTime() + SETTLEMENT_GRACE_MS ? { status: "expired" } : { status: "pending" }
}

// ── Supabase store ───────────────────────────────────────────────────────────

interface IntentRow {
  id: string
  user_id: string | null
  wallet_address: string
  cluster: string
  pack_id: string
  offer: string | null
  qlc_amount: number | string
  usd_value_micros: number | string
  payment_asset_id: string
  payment_asset_symbol: string
  payment_asset_kind: PaymentAssetKind
  payment_mint: string | null
  payment_token_program: string | null
  payment_decimals: number
  payment_amount: number | string
  treasury_address: string
  destination_account: string
  price_source: string
  price_snapshot: Record<string, string | number>
  quoted_at: string
  expires_at: string
  reference: string
  status: "pending" | "paid" | "expired"
  tx_signature: string | null
  delivery_id: string | null
}

const INTENT_COLUMNS =
  "id, user_id, wallet_address, cluster, pack_id, offer, qlc_amount, usd_value_micros, payment_asset_id, payment_asset_symbol, payment_asset_kind, payment_mint, payment_token_program, payment_decimals, payment_amount, treasury_address, destination_account, price_source, price_snapshot, quoted_at, expires_at, reference, status, tx_signature, delivery_id"

function toIntent(row: IntentRow): PaymentIntent {
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    cluster: row.cluster,
    packId: row.pack_id,
    offer: row.offer,
    qlcAmount: BigInt(row.qlc_amount),
    usdValueMicros: BigInt(row.usd_value_micros),
    assetId: row.payment_asset_id,
    assetSymbol: row.payment_asset_symbol,
    assetKind: row.payment_asset_kind,
    mint: row.payment_mint,
    tokenProgram: row.payment_token_program,
    decimals: row.payment_decimals,
    paymentAmount: BigInt(row.payment_amount),
    treasury: row.treasury_address,
    destinationAccount: row.destination_account,
    priceSource: row.price_source,
    priceSnapshot: row.price_snapshot,
    quotedAt: new Date(row.quoted_at),
    expiresAt: new Date(row.expires_at),
    reference: row.reference,
    status: row.status,
    txSignature: row.tx_signature,
    deliveryId: row.delivery_id,
  }
}

export function createSupabasePaymentStore(client: SupabaseClient = createSupabaseAdmin() as unknown as SupabaseClient): PaymentStore {
  const deliveries = createSupabaseDeliveryStore(client)
  return {
    ...deliveries,

    async listPricePacks(cluster) {
      const { data, error } = await client.from("qlc_price_packs").select("*").eq("cluster", cluster).eq("is_active", true)
      if (error) throw new Error(`qlc_price_packs query failed: ${error.message}`)
      return (data ?? []) as PricePackRow[]
    },

    async listPaymentAssets(cluster) {
      const { data, error } = await client.from("payment_assets").select("*").eq("cluster", cluster).eq("is_enabled", true)
      if (error) throw new Error(`payment_assets query failed: ${error.message}`)
      return (data ?? []) as PaymentAssetRow[]
    },

    async countOpenIntents(userId, now) {
      const { count, error } = await client
        .from("payment_intents")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pending")
        .gt("expires_at", now.toISOString())
      if (error) throw new Error(`payment_intents count failed: ${error.message}`)
      return count ?? 0
    },

    async createIntent(intent) {
      const { data, error } = await client
        .from("payment_intents")
        .insert({
          user_id: intent.userId,
          wallet_address: intent.walletAddress,
          cluster: intent.cluster,
          pack_id: intent.packId,
          offer: intent.offer,
          qlc_amount: intent.qlcAmount.toString(),
          usd_value_micros: intent.usdValueMicros.toString(),
          payment_asset_id: intent.assetId,
          payment_asset_symbol: intent.assetSymbol,
          payment_asset_kind: intent.assetKind,
          payment_mint: intent.mint,
          payment_token_program: intent.tokenProgram,
          payment_decimals: intent.decimals,
          payment_amount: intent.paymentAmount.toString(),
          treasury_address: intent.treasury,
          destination_account: intent.destinationAccount,
          price_source: intent.priceSource,
          price_snapshot: intent.priceSnapshot,
          quoted_at: intent.quotedAt.toISOString(),
          expires_at: intent.expiresAt.toISOString(),
          reference: intent.reference,
        })
        .select(INTENT_COLUMNS)
        .single()
      if (error) throw new Error(`payment_intents insert failed: ${error.message}`)
      return toIntent(data as IntentRow)
    },

    async getIntent(intentId) {
      const { data, error } = await client.from("payment_intents").select(INTENT_COLUMNS).eq("id", intentId).maybeSingle()
      if (error) throw new Error(`payment_intents query failed: ${error.message}`)
      return data ? toIntent(data as IntentRow) : null
    },

    async getDelivery(deliveryId) {
      const { data, error } = await client.from("qlc_deliveries").select(DELIVERY_COLUMNS).eq("id", deliveryId).maybeSingle()
      if (error) throw new Error(`qlc_deliveries query failed: ${error.message}`)
      return data ? toDeliveryRecord(data as Parameters<typeof toDeliveryRecord>[0]) : null
    },

    async listPendingIntents(cluster, limit) {
      const { data, error } = await client
        .from("payment_intents")
        .select(INTENT_COLUMNS)
        .eq("cluster", cluster)
        .eq("status", "pending")
        .order("quoted_at", { ascending: true })
        .limit(limit)
      if (error) throw new Error(`payment_intents query failed: ${error.message}`)
      return ((data ?? []) as IntentRow[]).map(toIntent)
    },

    async closeExpiredIntent(intentId, cutoff) {
      const { data, error } = await client
        .from("payment_intents")
        .update({ status: "expired" })
        .eq("id", intentId)
        .eq("status", "pending")
        .lt("expires_at", cutoff.toISOString())
        .select("id")
      if (error) throw new Error(`payment_intents update failed: ${error.message}`)
      return (data ?? []).length === 1
    },

    async settle(intent, userId, payment) {
      const { data, error } = await client.rpc("settle_payment_intent", {
        p_intent_id: intent.id,
        p_user_id: userId,
        p_cluster: intent.cluster,
        p_tx_signature: payment.signature,
        p_payer: payment.payer,
        p_payment_mint: payment.mint,
        p_treasury_address: payment.treasury,
        p_destination_account: payment.destinationAccount,
        p_payment_amount: payment.amount.toString(),
        p_reference: payment.reference,
        p_tx_slot: payment.slot,
        p_tx_block_time: payment.blockTime.toISOString(),
      })
      if (error) throw new Error(`settle_payment_intent failed: ${error.message}`)
      return data as SettleOutcome
    },
  }
}
