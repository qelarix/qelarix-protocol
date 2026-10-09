// Central generation billing (server only). Every paid generation route uses exactly these steps and
// never reads or changes a balance itself (enforced by scripts/generation-billing-check.ts):
//
//   checkGenerationFunds     before the generation row is created: cheap checks, no side effects
//   reserveGenerationCharge  after the generation id exists and BEFORE the provider is called
//   settleGenerationCharge   the generation succeeded
//   releaseGenerationCharge  the generation failed or timed out
//
// One financial authority per deployment, chosen by GENERATION_BILLING:
//   credits (default, pre-cutover): legacy database credits. Pre-check, then deduct exactly once on
//     success (deduct_credits); nothing is charged before success, so a failure needs no refund.
//   qlc (Devnet cutover): on-chain QLC is the balance. The cost is reserved atomically against the
//     current test epoch (global budget; a request that does not fit pauses testing for everyone),
//     then charged from the member's approved allowance into the Program Vault (program `charge`,
//     confirmed) before the provider is called. Success settles the charge; failure refunds it
//     exactly once (program `refund`, no burn). profiles.credits is never read or changed.
//
// The amount is the generation's cost in credits from the unified price list (src/lib/credits.ts,
// stored as generations.credits_used); 1 credit = 1 QLC = 100 base units (2 decimals, 0.05 step).
// Exemptions (internal wallets, active unlimited periods) exist in credits mode only. QLC mode has no
// exemption: every wallet is charged and counts toward the test epoch, and a generation without a
// positive QLC price is refused before the provider.
//
// Provider calls without an approved QLC price (LLM helpers, text-to-speech inputs, provider uploads)
// are not charged but still pass checkGenerationEpoch first, so a paused epoch stops every provider call.
import type { Address } from "@solana/kit"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuthUser } from "@/lib/authSession"
import { PAYMENT_CLUSTERS } from "@/lib/payments/paymentConfig"
import {
  QELARIX_QLC_ERROR__ALLOWANCE_TOO_LOW,
  QELARIX_QLC_ERROR__ALREADY_REFUNDED,
  QELARIX_QLC_ERROR__AMOUNT_ABOVE_LIMIT,
  QELARIX_QLC_ERROR__CHARGE_SEQUENCE_USED,
  QELARIX_QLC_ERROR__INVALID_AMOUNT,
  QELARIX_QLC_ERROR__MEMBER_SUSPENDED,
  QELARIX_QLC_ERROR__PAUSED,
  QELARIX_QLC_ERROR__WRONG_TOKEN_ACCOUNT,
} from "@/lib/qlc/generated"
import { getQlcEnvironment } from "@/lib/qlc/qlcEnvironment"
import { qlcProgramErrorCode, type QlcBalance, type QlcChargeReceiptState, type QlcLimits, type QlcMemberState } from "@/lib/qlc/qlcOperator"
import { formatQlc } from "@/lib/qlc/qlcProgram"
import { getSolanaCluster, type SolanaCluster } from "@/lib/solanaCluster"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { DEVNET_PAUSED_DETAIL, DEVNET_PAUSED_MESSAGE } from "./billingMessages"
import { createSupabaseQlcChargeStore, type QlcChargeStore, type QlcEpochState } from "./qlcChargeStore"

export { DEVNET_PAUSED_DETAIL, DEVNET_PAUSED_MESSAGE }

export type GenerationBillingMode = "credits" | "qlc"

/** Token program error "insufficient funds" (the member's balance is below the charge). */
const TOKEN_INSUFFICIENT_FUNDS = 1
const MAX_CHARGE_ATTEMPTS = 3

export type BillingRefusal = { ok: false; status: number; code: string; error: string }
export type BillingResult = { ok: true } | BillingRefusal

export interface BillingRequest {
  user: Pick<AuthUser, "id" | "walletAddress">
  /** Cost in credits (= whole QLC) from the unified price list. */
  credits: number
  /** Credits mode only: internal wallet or active unlimited period is not charged. Ignored in QLC mode. */
  exempt?: boolean
}

/** Legacy database credits (pre-cutover mode). */
export interface LegacyCreditStore {
  balance(userId: string): Promise<number>
  /** Compare-and-set generations.credits_deducted false → true; only the winner deducts. */
  claimDeduction(generationId: string): Promise<boolean>
  deduct(userId: string, credits: number, description: string): Promise<boolean>
}

/** The subset of the QLC operator billing needs (src/lib/qlc/qlcOperator.ts). */
export interface QlcBillingChain {
  spendAuthority: Address
  member(wallet: Address): Promise<QlcMemberState>
  balance(wallet: Address, spendAuthority: Address): Promise<QlcBalance>
  limits(): Promise<QlcLimits>
  charge(input: { wallet: Address; seq: bigint; amount: bigint }): Promise<string>
  refund(input: { wallet: Address; seq: bigint }): Promise<string>
  chargeReceipt(input: { wallet: Address; seq: bigint }): Promise<QlcChargeReceiptState>
  closeCharge(input: { wallet: Address; seq: bigint }): Promise<string>
}

export interface GenerationBillingDeps {
  mode: GenerationBillingMode
  cluster: SolanaCluster | null
  credits: LegacyCreditStore
  charges: QlcChargeStore
  /** The QLC operator, or null when QLC is not configured on this deployment. */
  chain(): Promise<QlcBillingChain | null>
}

export function generationBillingMode(env: Record<string, string | undefined> = process.env): GenerationBillingMode {
  return env.GENERATION_BILLING?.trim() === "qlc" ? "qlc" : "credits"
}

/** Cost in credits → QLC base units (1 credit = 1 QLC = 100 base units). */
export function qlcAmountFor(credits: number): bigint {
  if (!Number.isInteger(credits) || credits <= 0) throw new RangeError(`Generation cost must be a positive whole number of credits (got ${credits})`)
  return BigInt(credits) * BigInt(100)
}

const refuse = (status: number, code: string, error: string): BillingRefusal => ({ ok: false, status, code, error })
const paused = () => refuse(503, "devnet_paused", `${DEVNET_PAUSED_MESSAGE} ${DEVNET_PAUSED_DETAIL}`)
const OK: BillingResult = { ok: true }

/** Credits mode: exempt users and zero-cost requests are not charged. */
function creditsBillable(request: BillingRequest): boolean {
  return !request.exempt && Number.isFinite(request.credits) && request.credits > 0
}

/** QLC mode: every generation needs a positive whole-QLC price; anything else fails closed. */
function qlcPriceRefusal(request: BillingRequest): BillingRefusal | null {
  return Number.isInteger(request.credits) && request.credits > 0
    ? null
    : refuse(500, "price_unavailable", "This generation has no QLC price. Nothing was charged.")
}

/** An epoch admits generations while it is active and has budget left. */
export function epochAcceptsGenerations(epoch: Pick<QlcEpochState, "status" | "limitAmount" | "reservedAmount"> | null): boolean {
  return !!epoch && epoch.status === "active" && epoch.reservedAmount < epoch.limitAmount
}

export function createSupabaseLegacyCreditStore(client: SupabaseClient = createSupabaseAdmin() as unknown as SupabaseClient): LegacyCreditStore {
  return {
    async balance(userId) {
      const { data } = await client.from("profiles").select("credits").eq("id", userId).maybeSingle()
      return (data as { credits: number } | null)?.credits ?? 0
    },
    async claimDeduction(generationId) {
      const { data } = await client
        .from("generations")
        .update({ credits_deducted: true })
        .eq("id", generationId)
        .eq("credits_deducted", false)
        .select("id")
        .maybeSingle()
      return !!data
    },
    async deduct(userId, credits, description) {
      const { data } = await client.rpc("deduct_credits", { p_user_id: userId, p_amount: credits, p_desc: description })
      return data === true
    },
  }
}

let defaultDeps: GenerationBillingDeps | null = null

export function defaultGenerationBillingDeps(): GenerationBillingDeps {
  defaultDeps ??= {
    mode: generationBillingMode(),
    cluster: getSolanaCluster(),
    credits: createSupabaseLegacyCreditStore(),
    charges: createSupabaseQlcChargeStore(),
    async chain() {
      const qlc = await getQlcEnvironment()
      if (!qlc.enabled) return null
      return { spendAuthority: qlc.spendAuthority as Address, ...qlc.operator }
    },
  }
  return defaultDeps
}

type QlcContext = { refusal: BillingRefusal } | { refusal: null; chain: QlcBillingChain; cluster: SolanaCluster; wallet: Address }

/** QLC mode needs an enabled payment cluster and a configured operator; anything else refuses. */
async function qlcContext(request: BillingRequest, deps: GenerationBillingDeps): Promise<QlcContext> {
  if (!deps.cluster || !PAYMENT_CLUSTERS.includes(deps.cluster)) {
    return { refusal: refuse(503, "qlc_unavailable", "QLC billing is not available on this deployment.") }
  }
  if (!request.user.walletAddress) return { refusal: refuse(403, "wallet_required", "Sign in with your Solana wallet to use QLC.") }
  const chain = await deps.chain()
  if (!chain) return { refusal: refuse(503, "qlc_unavailable", "QLC is not available right now. Please try again later.") }
  return { refusal: null, chain, cluster: deps.cluster, wallet: request.user.walletAddress as Address }
}

function chargeRefusal(code: number | null): BillingRefusal | null {
  switch (code) {
    case QELARIX_QLC_ERROR__ALLOWANCE_TOO_LOW:
      return refuse(402, "qlc_allowance_low", "Your QLC spending limit is lower than this generation costs.")
    case TOKEN_INSUFFICIENT_FUNDS:
      return refuse(402, "insufficient_qlc", "Not enough QLC for this generation.")
    case QELARIX_QLC_ERROR__PAUSED:
      return refuse(503, "qlc_paused", "QLC is paused right now. Please try again later.")
    case QELARIX_QLC_ERROR__MEMBER_SUSPENDED:
      return refuse(403, "member_suspended", "This wallet cannot use QLC right now.")
    case QELARIX_QLC_ERROR__AMOUNT_ABOVE_LIMIT:
    case QELARIX_QLC_ERROR__INVALID_AMOUNT:
      return refuse(503, "charge_above_limit", "This generation is above the current QLC charge limit.")
    case QELARIX_QLC_ERROR__WRONG_TOKEN_ACCOUNT:
      return refuse(409, "qlc_account_mismatch", "Your QLC account could not be verified.")
    default:
      return null
  }
}

/**
 * The global test-epoch gate for provider calls that are not charged (no approved QLC price). QLC mode:
 * refuses before any provider call unless the cluster's current epoch is active and has budget left;
 * nothing is charged or reserved. Credits mode: always open. Priced generations are gated by
 * checkGenerationFunds and, atomically, by reserveGenerationCharge (which pauses a full epoch).
 */
export async function checkGenerationEpoch(deps: GenerationBillingDeps = defaultGenerationBillingDeps()): Promise<BillingResult> {
  if (deps.mode === "credits") return OK
  if (!deps.cluster || !PAYMENT_CLUSTERS.includes(deps.cluster)) {
    return refuse(503, "qlc_unavailable", "QLC billing is not available on this deployment.")
  }
  try {
    return epochAcceptsGenerations(await deps.charges.currentEpoch(deps.cluster)) ? OK : paused()
  } catch (err) {
    console.error("[billing] epoch check failed", err instanceof Error ? err.message : err)
    return refuse(503, "qlc_unavailable", "QLC is not available right now. Please try again later.")
  }
}

/** Before the generation row is created. No side effects. */
export async function checkGenerationFunds(request: BillingRequest, deps: GenerationBillingDeps = defaultGenerationBillingDeps()): Promise<BillingResult> {
  if (deps.mode === "credits") {
    if (!creditsBillable(request)) return OK
    const balance = await deps.credits.balance(request.user.id)
    return balance < request.credits ? refuse(402, "insufficient_credits", `Insufficient credits. Need ${request.credits}, have ${balance}.`) : OK
  }

  const priceRefusal = qlcPriceRefusal(request)
  if (priceRefusal) return priceRefusal
  const amount = qlcAmountFor(request.credits)
  const context = await qlcContext(request, deps)
  if (context.refusal) return context.refusal
  const { chain, cluster, wallet } = context

  // The epoch decides first. Whether this request still fits is decided atomically by the reservation,
  // which also pauses the epoch for everyone when it does not fit (a refusal here would not pause it).
  const epoch = await deps.charges.currentEpoch(cluster)
  if (!epoch || epoch.status !== "active") return paused()

  const [limits, member, balance] = await Promise.all([chain.limits(), chain.member(wallet), chain.balance(wallet, chain.spendAuthority)])
  if (limits.paused) return refuse(503, "qlc_paused", "QLC is paused right now. Please try again later.")
  if (amount > limits.maxChargeAmount) {
    return refuse(503, "charge_above_limit", `This option costs ${formatQlc(amount)} QLC. During the devnet test, one creation can cost up to ${formatQlc(limits.maxChargeAmount)} QLC. Choose a shorter duration or a lower resolution. Nothing was charged.`)
  }
  if (!member.exists || !balance.exists || balance.frozen) return refuse(402, "qlc_setup_required", "QLC spending is not enabled for this wallet yet.")
  if (member.suspended) return refuse(403, "member_suspended", "This wallet cannot use QLC right now.")
  if (balance.amount < amount) return refuse(402, "insufficient_qlc", `Not enough QLC. Need ${formatQlc(amount)}, have ${formatQlc(balance.amount)}.`)
  if (balance.allowance < amount) return refuse(402, "qlc_allowance_low", "Your QLC spending limit is lower than this generation costs.")
  return OK
}

/**
 * After the generation id exists, before the provider is called. QLC mode: reserves the cost in the
 * current epoch and charges it on chain, confirmed; the provider may run only when this returns ok.
 * Credits mode: nothing to do (charged on success). On a refusal the caller marks the generation failed.
 */
export async function reserveGenerationCharge(
  request: BillingRequest & { generationId: string },
  deps: GenerationBillingDeps = defaultGenerationBillingDeps(),
): Promise<BillingResult> {
  if (deps.mode === "credits") return OK

  const priceRefusal = qlcPriceRefusal(request)
  if (priceRefusal) return priceRefusal
  const amount = qlcAmountFor(request.credits)
  const context = await qlcContext(request, deps)
  if (context.refusal) return context.refusal
  const { chain, cluster, wallet } = context

  const member = await chain.member(wallet)
  if (!member.exists) return refuse(402, "qlc_setup_required", "QLC spending is not enabled for this wallet yet.")

  const reservation = await deps.charges.reserve({
    generationId: request.generationId, cluster, userId: request.user.id, wallet, amount, minSeq: member.lastChargeSeq + BigInt(1),
  })
  let seq: bigint
  if (reservation.status === "reserved") {
    seq = reservation.seq
  } else if (reservation.status === "existing") {
    // The same generation was reserved before (internal retry): never charge it twice.
    if (reservation.chargeStatus === "charged" || reservation.chargeStatus === "settled") return OK
    if (reservation.chargeStatus !== "pending") return refuse(409, "charge_closed", "This generation's QLC charge is already closed.")
    seq = reservation.seq
  } else if (reservation.status === "invalid_request") {
    return refuse(500, "billing_error", "QLC billing failed. Please try again.")
  } else {
    return paused()
  }

  for (let attempt = 1; attempt <= MAX_CHARGE_ATTEMPTS; attempt++) {
    try {
      const signature = await chain.charge({ wallet, seq, amount })
      await deps.charges.markCharged(request.generationId, signature)
      return OK
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
      const code = qlcProgramErrorCode(err)
      // The receipt is the source of truth: the charge may have landed although the call failed.
      const receipt = await chain.chargeReceipt({ wallet, seq }).catch(() => null)
      if (receipt?.exists && receipt.amount === amount) {
        await deps.charges.markCharged(request.generationId, null)
        return OK
      }
      if (code === QELARIX_QLC_ERROR__CHARGE_SEQUENCE_USED && attempt < MAX_CHARGE_ATTEMPTS) {
        // A later charge of this wallet landed first: take a higher number and try again.
        const latest = await chain.member(wallet)
        const reassigned = await deps.charges.reassignSeq(request.generationId, latest.lastChargeSeq + BigInt(1))
        if (reassigned.status !== "reassigned" || reassigned.seq === undefined) break
        seq = reassigned.seq
        continue
      }
      const refusal = chargeRefusal(code)
      if (refusal) {
        // Definitive refusal: nothing moved and no provider ran, so the reservation is released.
        await deps.charges.fail(request.generationId, message)
        return refusal
      }
      // Unknown outcome (network, timeout, expired blockhash): keep the reservation, ask for a refund if
      // the charge lands later, and let the recovery job settle the record (src/lib/billing/billingRecovery.ts).
      await deps.charges.recordError(request.generationId, message)
      await deps.charges.beginRefund(request.generationId)
      return refuse(503, "charge_unconfirmed", "The QLC charge could not be confirmed. Nothing was generated; please try again.")
    }
  }
  await deps.charges.recordError(request.generationId, "charge sequence could not be assigned")
  await deps.charges.beginRefund(request.generationId)
  return refuse(503, "charge_unconfirmed", "The QLC charge could not be confirmed. Nothing was generated; please try again.")
}

/**
 * The generation succeeded. Credits mode: deducts exactly once ("generation-row" uses the
 * generations.credits_deducted compare-and-set; "this-request" is for synchronous routes that settle
 * before the row exists). QLC mode: finalizes the charge (charged → settled). Returns false only when a
 * credits-mode deduction was refused (balance spent meanwhile).
 */
export async function settleGenerationCharge(
  request: BillingRequest & { generationId: string; description: string; once: "generation-row" | "this-request" },
  deps: GenerationBillingDeps = defaultGenerationBillingDeps(),
): Promise<boolean> {
  if (deps.mode === "credits") {
    if (!creditsBillable(request)) return true
    if (request.once === "generation-row" && !(await deps.credits.claimDeduction(request.generationId))) return true
    return deps.credits.deduct(request.user.id, request.credits, request.description)
  }
  // QLC mode has no exemption, so every successful generation has a charge record; a missing one means
  // the generation was started before the QLC cutover (nothing to settle) and is logged.
  const result = await deps.charges.settle(request.generationId)
  if (result.status === "unknown_charge" || (result.status === "unchanged" && result.chargeStatus !== "settled" && result.chargeStatus !== "closed")) {
    console.error("[billing] settle on a generation without a charged QLC charge", request.generationId, result)
  }
  return true
}

/**
 * The generation failed or timed out. QLC mode: refunds the charge exactly once (repeating is a no-op;
 * an unconfirmed charge is refunded by the recovery job once it lands). Credits mode: nothing was charged.
 */
export async function releaseGenerationCharge(
  input: { generationId: string; reason: string },
  deps: GenerationBillingDeps = defaultGenerationBillingDeps(),
): Promise<void> {
  if (deps.mode === "credits") return
  const started = await deps.charges.beginRefund(input.generationId)
  const inProgress = started.status === "refund_pending" || (started.status === "unchanged" && started.chargeStatus === "refund_pending")
  if (!inProgress || !started.wallet || started.seq === undefined) return
  const chain = await deps.chain()
  if (!chain) {
    await deps.charges.recordError(input.generationId, `refund deferred (${input.reason}): QLC unavailable`)
    return
  }
  try {
    const signature = await chain.refund({ wallet: started.wallet as Address, seq: started.seq })
    await deps.charges.markRefunded(input.generationId, signature)
  } catch (err) {
    if (qlcProgramErrorCode(err) === QELARIX_QLC_ERROR__ALREADY_REFUNDED) {
      await deps.charges.markRefunded(input.generationId, null)
      return
    }
    await deps.charges.recordError(input.generationId, `refund failed (${input.reason}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The balance shown to the user (header, Studio pre-checks): database credits, or on-chain QLC in QLC mode. */
export async function getGenerationBalance(
  user: Pick<AuthUser, "id" | "walletAddress">,
  deps: GenerationBillingDeps = defaultGenerationBillingDeps(),
): Promise<number> {
  if (deps.mode === "credits") return deps.credits.balance(user.id)
  if (!user.walletAddress) return 0
  const chain = await deps.chain()
  if (!chain) return 0
  const balance = await chain.balance(user.walletAddress as Address, chain.spendAuthority)
  return Number(balance.amount) / 100
}
