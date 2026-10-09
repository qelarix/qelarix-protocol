// Offline checks for central generation billing (src/lib/billing/generationBilling.ts): both billing
// modes, the QLC reserve → charge → settle / refund lifecycle, idempotency, the global test-epoch
// budget under concurrency, refunds never reopening the budget, background recovery, source guards over
// every generation route, and the maximum single charge (evidence for the program's max_charge_amount).
// No network, no database, no chain: the charge store and the program are in-memory models of
// supabase/proposed/20261006000001_qlc_generation_billing.sql and the qelarix_qlc `charge` / `refund`
// instructions. Database-level guarantees (row locks, privileges, rollback) are covered by
// scripts/qlc-billing-db-check.mjs.
//
//   npm run check:generation-billing
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { Address } from "@solana/kit"
import { recoverGenerationCharges, CHARGE_UNKNOWN_MS, CLOSE_AFTER_MS, GENERATION_TIMEOUT_MS, type BillingRecoveryDeps } from "../src/lib/billing/billingRecovery"
import {
  DEVNET_PAUSED_MESSAGE,
  checkGenerationEpoch,
  checkGenerationFunds,
  epochAcceptsGenerations,
  generationBillingMode,
  getGenerationBalance,
  qlcAmountFor,
  releaseGenerationCharge,
  reserveGenerationCharge,
  settleGenerationCharge,
  type BillingRequest,
  type GenerationBillingDeps,
  type LegacyCreditStore,
  type QlcBillingChain,
} from "../src/lib/billing/generationBilling"
import type { QlcChargeRecord, QlcChargeStatus, QlcChargeStore, QlcEpochState, ReserveResult } from "../src/lib/billing/qlcChargeStore"
import { DEFAULT_ALLOWANCE_QLC, MAX_ALLOWANCE_QLC, parseAllowance } from "../src/lib/billing/qlcAllowance"
import { AUDIO_MODELS, resolveAudioCredits } from "../src/lib/audio-models"
import { CREDITS, VIDEO_PRICES } from "../src/lib/credits"
import { IMAGE_MODELS } from "../src/lib/image-models"
import {
  QELARIX_QLC_ERROR__ALLOWANCE_TOO_LOW,
  QELARIX_QLC_ERROR__ALREADY_REFUNDED,
  QELARIX_QLC_ERROR__AMOUNT_ABOVE_LIMIT,
  QELARIX_QLC_ERROR__CHARGE_SEQUENCE_USED,
  QELARIX_QLC_ERROR__MEMBER_SUSPENDED,
  QELARIX_QLC_ERROR__PAUSED,
} from "../src/lib/qlc/generated"
import type { SolanaCluster } from "../src/lib/solanaCluster"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
const section = (title: string) => console.log(`\n── ${title} ──`)
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

const CLUSTER: SolanaCluster = "devnet"
const EPOCH_LIMIT = BigInt(1_500_000) // 15,000.00 QLC
const MAX_CHARGE = BigInt(120_000) // the recommended cap (see the max-charge section)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
let walletCounter = 0
function newWallet(): string {
  let n = ++walletCounter
  let suffix = ""
  while (n > 0) { suffix = B58[n % 58] + suffix; n = Math.floor(n / 58) }
  return ("Wa11et" + suffix).padEnd(44, "1")
}
let idCounter = 0
const newId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`

// ── In-memory model of the charge store (mirrors the proposed SQL functions) ─────────────────────
interface Epoch { id: number; cluster: SolanaCluster; status: "active" | "paused"; limit: bigint; reserved: bigint; released: bigint; refunded: bigint; reservations: number; requestKey: string; pauseReason: "budget_exhausted" | "owner" | null; rejected: bigint | null }
interface Charge { generationId: string; epochId: number; cluster: SolanaCluster; userId: string; wallet: string; amount: bigint; seq: bigint; status: QlcChargeStatus; releaseRequested: boolean; updatedAt: number; outcome: "settled" | "refunded" | null }

class FakeChargeStore implements QlcChargeStore {
  epochs: Epoch[] = []
  charges = new Map<string, Charge>()
  lastSeq = new Map<string, bigint>()
  generations = new Map<string, string>()
  calls: string[] = []
  /** Admission order: "admit" | "exhausted" (the request that paused the epoch) | "paused". */
  events: string[] = []
  now = Date.now()
  /** Models the epoch row lock (SELECT … FOR UPDATE). `unlocked` is a negative control only. */
  private lock: Promise<void> = Promise.resolve()
  constructor(private readonly options: { unlocked?: boolean } = {}) {}

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.options.unlocked) return fn()
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise<void>((resolve) => (release = resolve))
    await previous
    try { return await fn() } finally { release() }
  }
  private current(cluster: SolanaCluster) {
    return [...this.epochs].reverse().find((e) => e.cluster === cluster) ?? null
  }
  open(limit: bigint, requestKey: string): { status: string; epochId?: number } {
    const same = this.epochs.find((e) => e.requestKey === requestKey)
    if (same) return { status: "already_opened", epochId: same.id }
    if (this.epochs.some((e) => e.cluster === CLUSTER && e.status === "active")) return { status: "already_active" }
    const epoch: Epoch = { id: this.epochs.length + 1, cluster: CLUSTER, status: "active", limit, reserved: BigInt(0), released: BigInt(0), refunded: BigInt(0), reservations: 0, requestKey, pauseReason: null, rejected: null }
    this.epochs.push(epoch)
    return { status: "opened", epochId: epoch.id }
  }
  pauseByOwner(): string {
    const epoch = this.epochs.find((e) => e.cluster === CLUSTER && e.status === "active")
    if (!epoch) return "no_active_epoch"
    epoch.status = "paused"
    epoch.pauseReason = "owner"
    return "paused"
  }

  async currentEpoch(cluster: SolanaCluster): Promise<QlcEpochState | null> {
    this.calls.push("currentEpoch")
    await tick()
    const e = this.current(cluster)
    return e ? { id: e.id, status: e.status, limitAmount: e.limit, reservedAmount: e.reserved, pauseReason: e.pauseReason } : null
  }
  async reserve(input: { generationId: string; cluster: SolanaCluster; userId: string; wallet: string; amount: bigint; minSeq: bigint }): Promise<ReserveResult> {
    this.calls.push("reserve")
    await tick()
    const existing = this.charges.get(input.generationId)
    if (existing) return { status: "existing", chargeStatus: existing.status, seq: existing.seq, epochId: existing.epochId, amount: existing.amount, wallet: existing.wallet }
    return this.locked(async () => {
      const raced = this.charges.get(input.generationId)
      if (raced) return { status: "existing", chargeStatus: raced.status, seq: raced.seq, epochId: raced.epochId, amount: raced.amount, wallet: raced.wallet }
      const epoch = this.current(input.cluster)
      if (!epoch) return { status: "no_epoch" }
      const reserved = epoch.reserved
      await tick() // a context switch inside the critical section: only the lock keeps this atomic
      if (epoch.status === "paused") { this.events.push("paused"); return { status: "paused" } }
      if (reserved + input.amount > epoch.limit) {
        this.events.push("exhausted")
        epoch.status = "paused"
        epoch.pauseReason = "budget_exhausted"
        epoch.rejected = input.amount
        return { status: "budget_exhausted" }
      }
      epoch.reserved = reserved + input.amount
      epoch.reservations++
      this.events.push("admit")
      const key = `${input.cluster}:${input.wallet}`
      const last = this.lastSeq.get(key) ?? BigInt(0)
      const seq = last + BigInt(1) > input.minSeq ? last + BigInt(1) : input.minSeq
      this.lastSeq.set(key, seq)
      this.charges.set(input.generationId, { generationId: input.generationId, epochId: epoch.id, cluster: input.cluster, userId: input.userId, wallet: input.wallet, amount: input.amount, seq, status: "pending", releaseRequested: false, updatedAt: this.now, outcome: null })
      return { status: "reserved", seq, epochId: epoch.id, remaining: epoch.limit - epoch.reserved }
    })
  }
  async reassignSeq(generationId: string, minSeq: bigint) {
    this.calls.push("reassignSeq")
    const c = this.charges.get(generationId)
    if (!c) return { status: "unknown_charge" }
    if (c.status !== "pending") return { status: "not_pending" }
    const key = `${c.cluster}:${c.wallet}`
    const last = this.lastSeq.get(key) ?? BigInt(0)
    const seq = last + BigInt(1) > minSeq ? last + BigInt(1) : minSeq
    this.lastSeq.set(key, seq)
    c.seq = seq
    c.updatedAt = this.now
    return { status: "reassigned", seq }
  }
  async markCharged(generationId: string) {
    this.calls.push("markCharged")
    const c = this.charges.get(generationId)
    if (!c) return { status: "unknown_charge" }
    if (c.status !== "pending") return { status: "unchanged", chargeStatus: c.status, releaseRequested: c.releaseRequested }
    c.status = "charged"
    c.updatedAt = this.now
    return { status: "charged", chargeStatus: "charged" as const, releaseRequested: c.releaseRequested }
  }
  async fail(generationId: string) {
    this.calls.push("fail")
    const c = this.charges.get(generationId)
    if (!c) return { status: "unknown_charge" }
    return this.locked(async () => {
      if (c.status !== "pending") return { status: "unchanged" }
      c.status = "charge_failed"
      c.updatedAt = this.now
      const epoch = this.epochs.find((e) => e.id === c.epochId)!
      epoch.reserved -= c.amount
      epoch.released += c.amount
      return { status: "charge_failed" }
    })
  }
  async settle(generationId: string) {
    this.calls.push("settle")
    const c = this.charges.get(generationId)
    if (!c) return { status: "unknown_charge" }
    if (c.status !== "charged") return { status: "unchanged", chargeStatus: c.status }
    c.status = "settled"
    c.updatedAt = this.now
    return { status: "settled" }
  }
  async beginRefund(generationId: string) {
    this.calls.push("beginRefund")
    const c = this.charges.get(generationId)
    if (!c) return { status: "unknown_charge" }
    if (c.status === "charged") {
      c.status = "refund_pending"
      c.updatedAt = this.now
      return { status: "refund_pending", wallet: c.wallet, seq: c.seq, amount: c.amount }
    }
    if (c.status === "pending") {
      c.releaseRequested = true
      c.updatedAt = this.now
      return { status: "release_requested" }
    }
    return { status: "unchanged", chargeStatus: c.status, wallet: c.wallet, seq: c.seq, amount: c.amount }
  }
  async markRefunded(generationId: string) {
    this.calls.push("markRefunded")
    const c = this.charges.get(generationId)
    if (!c) return { status: "unknown_charge" }
    if (c.status !== "refund_pending") return { status: "unchanged" }
    c.status = "refunded"
    c.updatedAt = this.now
    this.epochs.find((e) => e.id === c.epochId)!.refunded += c.amount // never reopens the budget
    return { status: "refunded" }
  }
  async markClosed(generationId: string) {
    this.calls.push("markClosed")
    const c = this.charges.get(generationId)
    if (!c) return { status: "unknown_charge" }
    if (c.status !== "settled" && c.status !== "refunded") return { status: "unchanged" }
    c.outcome = c.status
    c.status = "closed"
    c.updatedAt = this.now
    return { status: "closed" }
  }
  async recordError(generationId: string) {
    this.calls.push("recordError")
    const c = this.charges.get(generationId)
    if (c) c.updatedAt = this.now
  }
  async listOpen(cluster: SolanaCluster, limit: number, closeBefore: Date): Promise<QlcChargeRecord[]> {
    const rows = Array.from(this.charges.values()).filter((c) => c.cluster === cluster)
    const open = rows.filter((c) => ["pending", "charged", "refund_pending"].includes(c.status)).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit)
    const closable = rows.filter((c) => (c.status === "settled" || c.status === "refunded") && c.updatedAt < closeBefore.getTime()).sort((a, b) => a.updatedAt - b.updatedAt)
    return [...open, ...closable].slice(0, limit).map((c) => ({ generationId: c.generationId, userId: c.userId, wallet: c.wallet, amount: c.amount, seq: c.seq, status: c.status, releaseRequested: c.releaseRequested, updatedAt: new Date(c.updatedAt).toISOString() }))
  }
  async generationStatuses(ids: string[]) {
    return new Map(ids.filter((id) => this.generations.has(id)).map((id) => [id, this.generations.get(id)!]))
  }
}

// ── In-memory model of the program (member ATA → Vault via the spend delegate allowance) ─────────
interface Account { amount: bigint; allowance: bigint; frozen: boolean }
const programError = (code: number) => new Error(`Transaction simulation failed: custom program error: 0x${code.toString(16)}`)

class FakeChain implements QlcBillingChain {
  spendAuthority = "SpendAuthority11111111111111111111111111111" as Address
  members = new Map<string, { exists: boolean; suspended: boolean; lastChargeSeq: bigint }>()
  accounts = new Map<string, Account>()
  receipts = new Map<string, { status: "charged" | "refunded"; amount: bigint }>()
  vault = BigInt(0)
  paused = false
  maxChargeAmount = MAX_CHARGE
  /** Fault injection for the next charge: "lost" = sent but the call failed; "dropped" = never landed. */
  nextChargeFault: "lost" | "dropped" | null = null
  chargeCalls = 0
  /** Charges that actually landed (moved QLC); a rejected duplicate is a call but not a charge. */
  landed = 0
  refundCalls = 0
  closeCalls = 0
  log: string[] = []

  join(wallet: string, amount: bigint, allowance: bigint) {
    this.members.set(wallet, { exists: true, suspended: false, lastChargeSeq: BigInt(0) })
    this.accounts.set(wallet, { amount, allowance, frozen: false })
  }
  async member(wallet: Address) {
    return this.members.get(wallet) ?? { exists: false, suspended: false, lastChargeSeq: BigInt(0) }
  }
  async balance(wallet: Address) {
    const a = this.accounts.get(wallet)
    return { tokenAccount: wallet, exists: !!a, frozen: a?.frozen ?? false, amount: a?.amount ?? BigInt(0), allowance: a?.allowance ?? BigInt(0) }
  }
  async limits() {
    return { maxDeliveryAmount: BigInt(1_000_000), maxChargeAmount: this.maxChargeAmount, mintWindowCap: BigInt(2_000_000), paused: this.paused }
  }
  async charge({ wallet, seq, amount }: { wallet: Address; seq: bigint; amount: bigint }) {
    this.chargeCalls++
    await tick()
    const fault = this.nextChargeFault
    this.nextChargeFault = null
    if (fault === "dropped") throw new Error("block height exceeded")
    const member = this.members.get(wallet)
    const account = this.accounts.get(wallet)
    if (this.paused) throw programError(QELARIX_QLC_ERROR__PAUSED)
    if (!member || !account) throw new Error("AccountNotInitialized")
    if (member.suspended) throw programError(QELARIX_QLC_ERROR__MEMBER_SUSPENDED)
    if (amount > this.maxChargeAmount) throw programError(QELARIX_QLC_ERROR__AMOUNT_ABOVE_LIMIT)
    if (seq <= member.lastChargeSeq) throw programError(QELARIX_QLC_ERROR__CHARGE_SEQUENCE_USED)
    if (account.allowance < amount) throw programError(QELARIX_QLC_ERROR__ALLOWANCE_TOO_LOW)
    if (account.amount < amount) throw programError(1)
    account.amount -= amount
    account.allowance -= amount
    this.vault += amount
    member.lastChargeSeq = seq
    this.receipts.set(`${wallet}:${seq}`, { status: "charged", amount })
    this.landed++
    this.log.push(`charge ${wallet.slice(0, 8)}#${seq} ${amount}`)
    if (fault === "lost") throw new Error("fetch failed: socket hang up")
    return `sig-charge-${seq}`
  }
  async refund({ wallet, seq }: { wallet: Address; seq: bigint }) {
    this.refundCalls++
    await tick()
    const receipt = this.receipts.get(`${wallet}:${seq}`)
    if (!receipt) throw new Error("AccountNotInitialized")
    if (receipt.status === "refunded") throw programError(QELARIX_QLC_ERROR__ALREADY_REFUNDED)
    receipt.status = "refunded"
    this.vault -= receipt.amount
    this.accounts.get(wallet)!.amount += receipt.amount // the allowance is not restored
    this.log.push(`refund ${wallet.slice(0, 8)}#${seq} ${receipt.amount}`)
    return `sig-refund-${seq}`
  }
  async chargeReceipt({ wallet, seq }: { wallet: Address; seq: bigint }) {
    const r = this.receipts.get(`${wallet}:${seq}`)
    return r ? { exists: true as const, status: r.status, amount: r.amount } : { exists: false as const }
  }
  async closeCharge({ wallet, seq }: { wallet: Address; seq: bigint }) {
    this.closeCalls++
    this.receipts.delete(`${wallet}:${seq}`)
    return `sig-close-${seq}`
  }
}

class FakeCredits implements LegacyCreditStore {
  balances = new Map<string, number>()
  claimed = new Set<string>()
  deductions: { userId: string; credits: number }[] = []
  async balance(userId: string) { return this.balances.get(userId) ?? 0 }
  async claimDeduction(generationId: string) {
    await tick()
    if (this.claimed.has(generationId)) return false
    this.claimed.add(generationId)
    return true
  }
  async deduct(userId: string, credits: number) {
    const balance = this.balances.get(userId) ?? 0
    if (balance < credits) return false
    this.balances.set(userId, balance - credits)
    this.deductions.push({ userId, credits })
    return true
  }
}

/** QLC mode must never touch database credits (profiles.credits / deduct_credits). */
const forbiddenCredits: LegacyCreditStore & { touched: number } = {
  touched: 0,
  async balance() { forbiddenCredits.touched++; throw new Error("profiles.credits read in QLC mode") },
  async claimDeduction() { forbiddenCredits.touched++; throw new Error("credits_deducted used in QLC mode") },
  async deduct() { forbiddenCredits.touched++; throw new Error("deduct_credits called in QLC mode") },
}

function qlcDeps(store: FakeChargeStore, chain: FakeChain | null): GenerationBillingDeps {
  return { mode: "qlc", cluster: CLUSTER, credits: forbiddenCredits, charges: store, chain: async () => chain }
}
const userFor = (wallet: string | null): BillingRequest["user"] => ({ id: newId(), walletAddress: wallet })

/** A generation as the routes run it: reserve before the provider, then settle or release. */
async function runGeneration(deps: GenerationBillingDeps, user: BillingRequest["user"], credits: number, outcome: "success" | "failure", provider: string[] = [], exempt = false) {
  const generationId = newId()
  const charge = await reserveGenerationCharge({ user, generationId, credits, exempt }, deps)
  if (!charge.ok) return { generationId, charge }
  provider.push(generationId)
  if (outcome === "success") await settleGenerationCharge({ user, generationId, credits, description: "test", once: "generation-row", exempt }, deps)
  else await releaseGenerationCharge({ generationId, reason: "provider failed" }, deps)
  return { generationId, charge }
}

async function main() {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("Mode selection and amounts")
  check("default billing mode is credits (pre-cutover)", generationBillingMode({}) === "credits")
  check("GENERATION_BILLING=qlc selects QLC billing", generationBillingMode({ GENERATION_BILLING: "qlc" }) === "qlc" && generationBillingMode({ GENERATION_BILLING: " qlc " }) === "qlc")
  check("any other value keeps credits", ["credits", "QLC", "true", ""].every((v) => generationBillingMode({ GENERATION_BILLING: v }) === "credits"))
  check("1 credit = 1 QLC = 100 base units (integer, 0.05 step)", qlcAmountFor(1) === BigInt(100) && qlcAmountFor(1200) === BigInt(120_000) && qlcAmountFor(7) % BigInt(5) === BigInt(0))
  check("fractional, zero or negative costs are rejected", [0, -5, 1.5, NaN].every((v) => { try { qlcAmountFor(v); return false } catch { return true } }))
  check("allowance input: default 50 QLC, finite, 0.05 step, ≤ 10,000 QLC",
    DEFAULT_ALLOWANCE_QLC === 50 && parseAllowance(undefined) === BigInt(5_000) && parseAllowance("12.35") === BigInt(1235) &&
    parseAllowance(MAX_ALLOWANCE_QLC) === BigInt(1_000_000) && [0, -1, 10_000.05, "1.02", "abc", Infinity].every((v) => parseAllowance(v) === null))

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("Credits mode (pre-cutover) keeps the legacy behavior")
  {
    const credits = new FakeCredits()
    const store = new FakeChargeStore()
    const deps: GenerationBillingDeps = { mode: "credits", cluster: CLUSTER, credits, charges: store, chain: async () => { throw new Error("chain used in credits mode") } }
    const user = userFor(newWallet())
    credits.balances.set(user.id, 50)
    const low = await checkGenerationFunds({ user, credits: 60 }, deps)
    check("insufficient credits → 402 insufficient_credits", !low.ok && low.status === 402 && low.code === "insufficient_credits", JSON.stringify(low))
    check("enough credits → ok", (await checkGenerationFunds({ user, credits: 50 }, deps)).ok)
    check("exempt (internal / unlimited) → ok without a balance read", (await checkGenerationFunds({ user: { id: "nobody", walletAddress: null }, credits: 10_000, exempt: true }, deps)).ok)
    const gen = newId()
    check("reserve is a no-op (nothing is charged before success)", (await reserveGenerationCharge({ user, generationId: gen, credits: 20 }, deps)).ok && store.calls.length === 0)
    const settles = await Promise.all([1, 2, 3].map(() => settleGenerationCharge({ user, generationId: gen, credits: 20, description: "x", once: "generation-row" }, deps)))
    check("concurrent status polls deduct exactly once (credits_deducted compare-and-set)", settles.every(Boolean) && credits.deductions.length === 1 && credits.balances.get(user.id) === 30)
    await settleGenerationCharge({ user, generationId: newId(), credits: 10, description: "x", once: "this-request" }, deps)
    check("a synchronous request deducts once on success", credits.deductions.length === 2 && credits.balances.get(user.id) === 20)
    check("a refused deduction reports false (route answers 402)", (await settleGenerationCharge({ user, generationId: newId(), credits: 99, description: "x", once: "this-request" }, deps)) === false)
    await releaseGenerationCharge({ generationId: gen, reason: "x" }, deps)
    check("release is a no-op (nothing was charged)", store.calls.length === 0)
    check("exempt settle never deducts", (await settleGenerationCharge({ user, generationId: newId(), credits: 5, description: "x", once: "this-request", exempt: true }, deps)) && credits.deductions.length === 2)
    check("balance shown = database credits", (await getGenerationBalance(user, deps)) === 20)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("QLC mode: funds check (no side effects, no database credits)")
  {
    const store = new FakeChargeStore()
    const chain = new FakeChain()
    const deps = qlcDeps(store, chain)
    const wallet = newWallet()
    const user = userFor(wallet)
    const noEpoch = await checkGenerationFunds({ user, credits: 10 }, deps)
    check("no epoch opened yet → paused with the locked headline", !noEpoch.ok && noEpoch.status === 503 && noEpoch.code === "devnet_paused" && noEpoch.error.startsWith(DEVNET_PAUSED_MESSAGE), JSON.stringify(noEpoch))
    check("locked headline text", DEVNET_PAUSED_MESSAGE === "Devnet testing is temporarily paused.")
    store.open(EPOCH_LIMIT, "open-1")
    const notMember = await checkGenerationFunds({ user, credits: 10 }, deps)
    check("not a member yet → 402 qlc_setup_required", !notMember.ok && notMember.code === "qlc_setup_required")
    chain.join(wallet, BigInt(50_000), BigInt(50_000))
    check("member with balance and allowance → ok", (await checkGenerationFunds({ user, credits: 500 }, deps)).ok)
    const poor = await checkGenerationFunds({ user, credits: 501 }, deps)
    check("balance too low → 402 insufficient_qlc", !poor.ok && poor.code === "insufficient_qlc", JSON.stringify(poor))
    chain.accounts.get(wallet)!.allowance = BigInt(1000)
    const lowAllowance = await checkGenerationFunds({ user, credits: 20 }, deps)
    check("allowance too low → 402 qlc_allowance_low", !lowAllowance.ok && lowAllowance.code === "qlc_allowance_low")
    chain.accounts.get(wallet)!.allowance = BigInt(50_000)
    chain.maxChargeAmount = BigInt(10_000)
    const above = await checkGenerationFunds({ user, credits: 101 }, deps)
    check("above the program's max_charge_amount → 503 charge_above_limit (devnet today: 100 QLC)", !above.ok && above.code === "charge_above_limit")
    chain.maxChargeAmount = MAX_CHARGE
    chain.paused = true
    check("program paused → 503 qlc_paused", (await checkGenerationFunds({ user, credits: 1 }, deps) as { code?: string }).code === "qlc_paused")
    chain.paused = false
    check("no wallet in the session → 403 wallet_required", (await checkGenerationFunds({ user: { id: "u", walletAddress: null }, credits: 1 }, deps) as { code?: string }).code === "wallet_required")
    check("QLC not configured → 503 qlc_unavailable", (await checkGenerationFunds({ user, credits: 1 }, qlcDeps(store, null)) as { code?: string }).code === "qlc_unavailable")
    check("cluster without payments → 503 qlc_unavailable", (await checkGenerationFunds({ user, credits: 1 }, { ...deps, cluster: null }) as { code?: string }).code === "qlc_unavailable")
    check("the funds check never reserved or charged", !store.calls.includes("reserve") && chain.chargeCalls === 0)
    check("header balance in QLC mode = on-chain QLC (500.00)", (await getGenerationBalance(user, deps)) === 500)
    check("QLC mode never read or changed database credits", forbiddenCredits.touched === 0)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("QLC mode: charge before the provider, settle once, refund once")
  {
    const store = new FakeChargeStore()
    const chain = new FakeChain()
    const deps = qlcDeps(store, chain)
    store.open(EPOCH_LIMIT, "open-1")
    const wallet = newWallet()
    const user = userFor(wallet)
    chain.join(wallet, BigInt(50_000), BigInt(50_000))
    const provider: string[] = []

    const ok = await runGeneration(deps, user, 40, "success", provider)
    const c1 = store.charges.get(ok.generationId)!
    check("success: charged on chain before the provider, then settled", ok.charge.ok && provider.length === 1 && chain.chargeCalls === 1 && c1.status === "settled" && chain.vault === BigInt(4000))
    check("success: the member paid 40.00 QLC from the allowance", chain.accounts.get(wallet)!.amount === BigInt(46_000) && chain.accounts.get(wallet)!.allowance === BigInt(46_000))
    const settleAgain = await settleGenerationCharge({ user, generationId: ok.generationId, credits: 40, description: "x", once: "generation-row" }, deps)
    check("settle is idempotent (repeat poll: no chain call, still settled)", settleAgain && c1.status === "settled" && chain.chargeCalls === 1 && chain.refundCalls === 0)
    await releaseGenerationCharge({ generationId: ok.generationId, reason: "late failure" }, deps)
    check("a settled generation is never refunded", chain.refundCalls === 0 && c1.status === "settled")

    const failed = await runGeneration(deps, user, 40, "failure", provider)
    const c2 = store.charges.get(failed.generationId)!
    check("failure: refunded exactly once, QLC back in the wallet", c2.status === "refunded" && chain.refundCalls === 1 && chain.accounts.get(wallet)!.amount === BigInt(46_000) && chain.vault === BigInt(4000))
    check("failure: the allowance is not restored by a refund (program rule)", chain.accounts.get(wallet)!.allowance === BigInt(42_000))
    await Promise.all([1, 2, 3].map(() => releaseGenerationCharge({ generationId: failed.generationId, reason: "retry" }, deps)))
    check("repeated / concurrent releases do not refund twice", chain.refundCalls === 1 && c2.status === "refunded")
    await settleGenerationCharge({ user, generationId: failed.generationId, credits: 40, description: "x", once: "generation-row" }, deps)
    check("a refunded generation cannot be settled afterwards", c2.status === "refunded")

    const generationId = newId()
    const [a, b] = await Promise.all([1, 2].map(() => reserveGenerationCharge({ user, generationId, credits: 40 }, deps)))
    check("the same generation reserved twice concurrently lands one charge (same sequence number; the duplicate is rejected, the receipt confirms it)",
      a.ok && b.ok && chain.landed === 3 && store.charges.get(generationId)!.status === "charged" && chain.vault === BigInt(8000), `calls=${chain.chargeCalls} landed=${chain.landed}`)
    const callsBefore = chain.chargeCalls
    check("an internal retry of a charged generation is not charged again (no chain call)", (await reserveGenerationCharge({ user, generationId, credits: 40 }, deps)).ok && chain.chargeCalls === callsBefore && chain.landed === 3)
    await settleGenerationCharge({ user, generationId, credits: 40, description: "x", once: "generation-row" }, deps)
    const retry = await runGeneration(deps, user, 40, "success", provider)
    check("a user retry is a new generation and a new charge", retry.charge.ok && chain.landed === 4 && retry.generationId !== generationId)
    const seqs = Array.from(store.charges.values()).filter((c) => c.wallet === wallet).map((c) => Number(c.seq)).sort((x, y) => x - y)
    check("one sequence number per charge of the wallet (1, 2, 3, 4)", seqs.join() === "1,2,3,4", seqs.join())

    // No exemption in QLC mode: routes pass `exempt` for internal wallets and active unlimited periods.
    const internalWallet = newWallet()
    chain.join(internalWallet, BigInt(10_000), BigInt(10_000))
    const internalUser = userFor(internalWallet)
    const reservedBefore = store.epochs[0].reserved
    const internal = await runGeneration(deps, internalUser, 40, "success", provider, true)
    check("internal wallet (exempt flag) in QLC mode: reserved, charged on chain, settled, counted in the epoch",
      internal.charge.ok && store.charges.get(internal.generationId)?.status === "settled" && chain.landed === 5 &&
      chain.accounts.get(internalWallet)!.amount === BigInt(6000) && store.epochs[0].reserved === reservedBefore + BigInt(4000))
    const unlimitedWallet = newWallet()
    chain.join(unlimitedWallet, BigInt(10_000), BigInt(10_000))
    const unlimited = await runGeneration(deps, userFor(unlimitedWallet), 40, "failure", provider, true)
    check("unlimited period (exempt flag) in QLC mode: charged, refunded once on failure, still counted in the epoch",
      unlimited.charge.ok && store.charges.get(unlimited.generationId)?.status === "refunded" && chain.refundCalls === 2 &&
      store.epochs[0].reserved === reservedBefore + BigInt(8000))
    const exemptStranger = userFor(newWallet())
    const strangerFunds = await checkGenerationFunds({ user: exemptStranger, credits: 40, exempt: true }, deps)
    const strangerCharge = await reserveGenerationCharge({ user: exemptStranger, generationId: newId(), credits: 40, exempt: true }, deps)
    check("an exempt wallet without QLC spending is refused like everyone else (no bypass)",
      !strangerFunds.ok && strangerFunds.code === "qlc_setup_required" && !strangerCharge.ok && strangerCharge.code === "qlc_setup_required")
    const poorWallet = newWallet()
    chain.join(poorWallet, BigInt(100), BigInt(100_000))
    const poorFunds = await checkGenerationFunds({ user: userFor(poorWallet), credits: 40, exempt: true }, deps)
    check("an exempt wallet with too little QLC is refused (no bypass)", !poorFunds.ok && poorFunds.code === "insufficient_qlc")
    check("QLC mode never read or changed database credits", forbiddenCredits.touched === 0)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("QLC mode: charge failures")
  {
    const store = new FakeChargeStore()
    const chain = new FakeChain()
    const deps = qlcDeps(store, chain)
    store.open(EPOCH_LIMIT, "open-1")
    const wallet = newWallet()
    const user = userFor(wallet)
    chain.join(wallet, BigInt(10_000), BigInt(2_000))
    const epoch = () => store.epochs[0]

    const refused = await runGeneration(deps, user, 30, "success")
    check("allowance too low on chain → 402, the provider is not called", !refused.charge.ok && (refused.charge as { code: string }).code === "qlc_allowance_low")
    check("a definitive refusal releases the reservation (nothing moved)", store.charges.get(refused.generationId)!.status === "charge_failed" && epoch().reserved === BigInt(0) && epoch().released === BigInt(3000))

    chain.accounts.get(wallet)!.allowance = BigInt(10_000)
    chain.members.get(wallet)!.lastChargeSeq = BigInt(7) // a later charge of this wallet landed first
    const reassigned = await runGeneration(deps, user, 10, "success")
    check("CHARGE_SEQUENCE_USED → a new, higher number is assigned and charged", reassigned.charge.ok && store.charges.get(reassigned.generationId)!.seq === BigInt(8) && store.charges.get(reassigned.generationId)!.status === "settled")

    chain.nextChargeFault = "lost"
    const lost = await runGeneration(deps, user, 10, "success")
    check("charge landed but the call failed: the receipt confirms it, generation proceeds", lost.charge.ok && store.charges.get(lost.generationId)!.status === "settled")

    chain.nextChargeFault = "dropped"
    const dropped = await runGeneration(deps, user, 10, "success")
    const pending = store.charges.get(dropped.generationId)!
    check("unknown outcome → 503 charge_unconfirmed, the provider is not called", !dropped.charge.ok && (dropped.charge as { code: string }).code === "charge_unconfirmed")
    check("unknown outcome keeps the reservation and requests a release", pending.status === "pending" && pending.releaseRequested && epoch().reserved === BigInt(3000))

    chain.accounts.get(wallet)!.frozen = true
    check("frozen account → qlc_setup_required at the funds check", (await checkGenerationFunds({ user, credits: 1 }, deps) as { code?: string }).code === "qlc_setup_required")
    chain.accounts.get(wallet)!.frozen = false
    chain.members.get(wallet)!.suspended = true
    const suspended = await runGeneration(deps, user, 10, "success")
    check("suspended member → refused, reservation released", !suspended.charge.ok && store.charges.get(suspended.generationId)!.status === "charge_failed")
    check("QLC mode never read or changed database credits", forbiddenCredits.touched === 0)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("QLC mode: no price means no generation; universal epoch gate for unpriced provider calls")
  {
    const store = new FakeChargeStore()
    const chain = new FakeChain()
    const deps = qlcDeps(store, chain)
    store.open(EPOCH_LIMIT, "gate-1")
    const wallet = newWallet()
    chain.join(wallet, BigInt(50_000), BigInt(50_000))
    const user = userFor(wallet)
    const unpriced = await Promise.all([0, -4, 1.5, NaN].map(async (credits) => ({
      funds: await checkGenerationFunds({ user, credits }, deps),
      charge: await reserveGenerationCharge({ user, generationId: newId(), credits }, deps),
    })))
    check("a priced route with no / invalid QLC price is refused before the provider (fail closed)",
      unpriced.every((r) => !r.funds.ok && r.funds.code === "price_unavailable" && !r.charge.ok && r.charge.code === "price_unavailable") && store.charges.size === 0 && chain.chargeCalls === 0)
    check("…also for exempt users", !(await checkGenerationFunds({ user, credits: 0, exempt: true }, deps)).ok)

    // The gate every unpriced provider route calls before its provider (src/app/api, see the source guards).
    const provider: string[] = []
    const unpricedRoute = async (d: GenerationBillingDeps) => {
      const gate = await checkGenerationEpoch(d)
      if (!gate.ok) return gate
      provider.push("called")
      return gate
    }
    const credits = new FakeCredits()
    const creditsStore = new FakeChargeStore()
    const creditsMode: GenerationBillingDeps = { mode: "credits", cluster: CLUSTER, credits, charges: creditsStore, chain: async () => null }
    check("credits mode: the gate is open and reads nothing", (await unpricedRoute(creditsMode)).ok && creditsStore.calls.length === 0 && provider.length === 1)
    check("QLC mode, active epoch with budget: open, nothing reserved or charged", (await unpricedRoute(deps)).ok && provider.length === 2 && store.charges.size === 0 && chain.chargeCalls === 0)

    const noEpoch = await unpricedRoute(qlcDeps(new FakeChargeStore(), chain))
    check("no epoch opened → refused with the locked headline, provider not called", !noEpoch.ok && noEpoch.code === "devnet_paused" && noEpoch.error.startsWith(DEVNET_PAUSED_MESSAGE) && provider.length === 2)
    const full = new FakeChargeStore()
    full.open(BigInt(4000), "full")
    await runGeneration(qlcDeps(full, chain), user, 40, "success")
    const exhausted = await unpricedRoute(qlcDeps(full, chain))
    check("exhausted epoch (budget fully reserved, still active) → refused, provider not called",
      full.epochs[0].status === "active" && !epochAcceptsGenerations({ status: "active", limitAmount: full.epochs[0].limit, reservedAmount: full.epochs[0].reserved }) && !exhausted.ok && exhausted.code === "devnet_paused" && provider.length === 2)
    const pausing = await runGeneration(qlcDeps(full, chain), user, 1, "success")
    check("the next priced request on the exhausted epoch pauses it for everyone", !pausing.charge.ok && full.epochs[0].status === "paused" && full.epochs[0].pauseReason === "budget_exhausted")
    store.pauseByOwner()
    const ownerPaused = await unpricedRoute(deps)
    check("owner-paused epoch → refused with the locked headline, provider not called", !ownerPaused.ok && ownerPaused.code === "devnet_paused" && ownerPaused.status === 503 && provider.length === 2)
    const noCluster = await checkGenerationEpoch({ ...deps, cluster: null })
    check("cluster without payments → refused (qlc_unavailable)", !noCluster.ok && noCluster.code === "qlc_unavailable")
    const broken: QlcChargeStore = Object.assign(Object.create(FakeChargeStore.prototype), store, { currentEpoch: async () => { throw new Error("database unavailable") } })
    const down = await checkGenerationEpoch({ ...deps, charges: broken })
    check("epoch store unavailable → refused 503 (fail closed), provider not called", !down.ok && down.status === 503 && down.code === "qlc_unavailable" && provider.length === 2)
    check("the gate never charged, reserved or touched database credits (the one charge here is the priced generation)", chain.chargeCalls === 1 && store.charges.size === 0 && forbiddenCredits.touched === 0, `chargeCalls=${chain.chargeCalls}`)
  }

  section("Background recovery (cron /api/cron/qlc-generations)")
  {
    const store = new FakeChargeStore()
    const chain = new FakeChain()
    const base = qlcDeps(store, chain)
    store.open(EPOCH_LIMIT, "open-1")
    const wallet = newWallet()
    const user = userFor(wallet)
    chain.join(wallet, BigInt(100_000), BigInt(100_000))
    let now = Date.now()
    const failedInDb: string[] = []
    const deps: BillingRecoveryDeps = { ...base, now: () => new Date(now), markGenerationFailed: async (id) => { failedInDb.push(id); store.generations.set(id, "failed") } }
    const advance = (ms: number) => { now += ms; store.now = now }

    // A: unknown outcome, never landed → charge_failed after the blockhash window, reservation released.
    chain.nextChargeFault = "dropped"
    const a = await runGeneration(base, user, 10, "success")
    // B: unknown outcome reported, but the charge landed → charged, then refunded (its provider never ran).
    chain.nextChargeFault = "dropped"
    const b = newId()
    await reserveGenerationCharge({ user, generationId: b, credits: 10 }, base)
    const bCharge = store.charges.get(b)!
    await chain.charge({ wallet: wallet as Address, seq: bCharge.seq, amount: bCharge.amount }) // lands late
    // C: charged, generation completed but never polled → settled.
    const c = newId(); await reserveGenerationCharge({ user, generationId: c, credits: 10 }, base); store.generations.set(c, "completed")
    // D: charged, generation failed but never polled → refunded.
    const d = newId(); await reserveGenerationCharge({ user, generationId: d, credits: 10 }, base); store.generations.set(d, "failed")
    // E: charged, still running past the timeout → failed + refunded.
    const e = newId(); await reserveGenerationCharge({ user, generationId: e, credits: 10 }, base); store.generations.set(e, "processing")

    let result = await recoverGenerationCharges(deps)
    check("young pending charges are left alone (blockhash may still land)", store.charges.get(a.generationId)!.status === "pending" && store.charges.get(b)!.status === "pending")
    check("charged + completed → settled; charged + failed → refunded", store.charges.get(c)!.status === "settled" && store.charges.get(d)!.status === "refunded", JSON.stringify(result))
    check("charged + still running before the timeout → untouched", store.charges.get(e)!.status === "charged")
    advance(CHARGE_UNKNOWN_MS + 1000)
    const reservedBefore = store.epochs[0].reserved
    result = await recoverGenerationCharges(deps)
    check("pending, receipt absent → charge_failed and the reservation is released", store.charges.get(a.generationId)!.status === "charge_failed" && store.epochs[0].reserved === reservedBefore - BigInt(1000))
    check("pending, receipt present → charged then refunded at once", store.charges.get(b)!.status === "refunded" && chain.receipts.get(`${wallet}:${bCharge.seq}`)?.status === "refunded", JSON.stringify(result))
    advance(GENERATION_TIMEOUT_MS)
    result = await recoverGenerationCharges(deps)
    check("charged past the timeout → generation marked failed and refunded", store.charges.get(e)!.status === "refunded" && failedInDb.includes(e), JSON.stringify(result))
    const refundsBefore = chain.refundCalls
    await recoverGenerationCharges(deps)
    check("a second recovery run changes nothing (idempotent)", chain.refundCalls === refundsBefore)
    advance(CLOSE_AFTER_MS + 1000)
    result = await recoverGenerationCharges(deps)
    check("settled / refunded receipts are closed after the grace period", [c, d, e, b].every((id) => store.charges.get(id)!.status === "closed") && result.closed === 4, JSON.stringify(result))
    check("closed charges keep their outcome", store.charges.get(c)!.outcome === "settled" && store.charges.get(d)!.outcome === "refunded")

    // Recent final charges never crowd open ones out of a batch.
    const crowd = new FakeChargeStore()
    crowd.open(EPOCH_LIMIT, "crowd")
    const crowdChain = new FakeChain()
    const crowdWallet = newWallet()
    crowdChain.join(crowdWallet, BigInt(10_000_000), BigInt(10_000_000))
    for (let i = 0; i < 60; i++) await runGeneration(qlcDeps(crowd, crowdChain), userFor(crowdWallet), 1, "success")
    crowd.now += 1000
    const stuck = newId()
    await reserveGenerationCharge({ user: userFor(crowdWallet), generationId: stuck, credits: 1 }, qlcDeps(crowd, crowdChain))
    crowd.generations.set(stuck, "completed")
    await recoverGenerationCharges({ ...qlcDeps(crowd, crowdChain), now: () => new Date(crowd.now), markGenerationFailed: async () => {} })
    check("60 recent settled charges do not starve an open charge in a 50-row batch", crowd.charges.get(stuck)!.status === "settled")
    check("recovery never touched database credits", forbiddenCredits.touched === 0)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("15,000.00 QLC test epoch: atomic, concurrency-safe, paused for everyone")
  async function stampede(store: FakeChargeStore, requests: number, creditsFor: (i: number) => number, exemptFor: (i: number) => boolean = () => false) {
    const chain = new FakeChain()
    const deps = qlcDeps(store, chain)
    const users = Array.from({ length: requests }, () => {
      const wallet = newWallet()
      chain.join(wallet, BigInt(1_000_000), BigInt(1_000_000))
      return userFor(wallet)
    })
    const results = await Promise.all(users.map((user, i) => runGeneration(deps, user, creditsFor(i), "success", [], exemptFor(i))))
    return { chain, results }
  }
  {
    // 500 simultaneous 40 QLC generations = 20,000 QLC of demand against a 15,000 QLC budget.
    const store = new FakeChargeStore()
    store.open(EPOCH_LIMIT, "stampede")
    const { chain, results } = await stampede(store, 500, () => 40)
    const admitted = results.filter((r) => r.charge.ok).length
    const epoch = store.epochs[0]
    check("500 concurrent 40 QLC requests: exactly 375 admitted (375 × 40 = 15,000)", admitted === 375 && epoch.reserved === EPOCH_LIMIT, `admitted=${admitted} reserved=${epoch.reserved}`)
    check("the budget is never exceeded: reserved ≤ limit and on-chain charges ≤ 15,000 QLC", epoch.reserved <= epoch.limit && chain.vault <= EPOCH_LIMIT && chain.chargeCalls === admitted)
    check("the first request that did not fit paused the epoch (budget_exhausted)", epoch.status === "paused" && epoch.pauseReason === "budget_exhausted" && epoch.rejected === BigInt(4000))
    const refusals = results.filter((r) => !r.charge.ok).map((r) => r.charge as { code: string; status: number; error: string })
    check("every refused request got 503 devnet_paused with the locked headline", refusals.length === 125 && refusals.every((r) => r.status === 503 && r.code === "devnet_paused" && r.error.startsWith(DEVNET_PAUSED_MESSAGE)))
    const lateWallet = newWallet()
    chain.join(lateWallet, BigInt(100_000), BigInt(100_000))
    const late = await runGeneration(qlcDeps(store, chain), userFor(lateWallet), 1, "success")
    check("after the pause even a 1 QLC request is refused (paused for everyone)", !late.charge.ok && (late.charge as { code: string }).code === "devnet_paused")
  }
  {
    // Mixed sizes: no smaller request may slip in after the epoch paused.
    const store = new FakeChargeStore()
    store.open(EPOCH_LIMIT, "mixed")
    const sizes = [400, 1, 120, 15, 315, 2, 80, 1200, 40, 5]
    const { results } = await stampede(store, 400, (i) => sizes[i % sizes.length])
    const epoch = store.epochs[0]
    const admittedAmount = results.filter((r) => r.charge.ok).reduce((sum, r) => sum + store.charges.get(r.generationId)!.amount, BigInt(0))
    check("mixed concurrent sizes: admitted total = reserved ≤ 15,000 QLC", admittedAmount === epoch.reserved && epoch.reserved <= EPOCH_LIMIT, `admitted=${admittedAmount}`)
    const pausedAt = store.events.indexOf("exhausted")
    check("mixed concurrent sizes: epoch paused, nothing admitted after the pausing request", epoch.status === "paused" && pausedAt >= 0 && !store.events.slice(pausedAt + 1).includes("admit") && store.events.filter((e) => e === "exhausted").length === 1,
      `admits=${store.events.filter((e) => e === "admit").length} pausedAt=${pausedAt}`)
  }
  {
    // Internal wallets / unlimited periods (exempt flag) share the same ceiling and pay on chain.
    const store = new FakeChargeStore()
    store.open(EPOCH_LIMIT, "exempt-stampede")
    const { chain, results } = await stampede(store, 500, () => 40, (i) => i % 2 === 0)
    const admitted = results.filter((r) => r.charge.ok).length
    check("500 concurrent requests, half internal/unlimited: still exactly 375 admitted, all charged on chain",
      admitted === 375 && store.epochs[0].reserved === EPOCH_LIMIT && chain.landed === 375 && chain.vault === EPOCH_LIMIT && store.epochs[0].status === "paused",
      `admitted=${admitted} landed=${chain.landed}`)
  }
  {
    // Negative control: without the epoch row lock the same stampede overshoots — the check above is meaningful.
    const store = new FakeChargeStore({ unlocked: true })
    store.open(EPOCH_LIMIT, "unlocked")
    const { results } = await stampede(store, 500, () => 40)
    const admitted = results.filter((r) => r.charge.ok).length
    check("negative control: an unlocked reservation lets more than 375 through", admitted > 375, `admitted=${admitted}`)
  }
  {
    // Refunds never reopen the budget.
    const store = new FakeChargeStore()
    store.open(EPOCH_LIMIT, "refunds")
    const chain = new FakeChain()
    const deps = qlcDeps(store, chain)
    const wallet = newWallet()
    chain.join(wallet, BigInt(5_000_000), BigInt(5_000_000))
    const user = userFor(wallet)
    for (let i = 0; i < 37; i++) await runGeneration(deps, user, 400, i < 20 ? "failure" : "success") // 14,800 QLC admitted, 8,000 refunded
    const epoch = store.epochs[0]
    check("refunded generations still count toward the epoch", epoch.reserved === BigInt(1_480_000) && epoch.refunded === BigInt(800_000), `reserved=${epoch.reserved} refunded=${epoch.refunded}`)
    const over = await runGeneration(deps, user, 400, "success")
    check("a request that only fits if refunds reopened the budget is refused and pauses", !over.charge.ok && epoch.status === "paused" && epoch.pauseReason === "budget_exhausted")
    check("no automatic reset: the epoch stays paused", (await checkGenerationFunds({ user, credits: 1 }, deps) as { code?: string }).code === "devnet_paused")

    // Owner-controlled resume opens a new epoch; history is preserved.
    const reopened = store.open(EPOCH_LIMIT, "resume-2")
    check("owner resume opens a new epoch with a fresh 15,000 QLC budget", reopened.status === "opened" && store.epochs.length === 2 && store.epochs[1].reserved === BigInt(0))
    check("a retried owner command with the same key does not open a third epoch", store.open(EPOCH_LIMIT, "resume-2").status === "already_opened" && store.epochs.length === 2)
    check("opening another epoch while one is active is refused", store.open(EPOCH_LIMIT, "resume-3").status === "already_active" && store.epochs.length === 2)
    check("the paused epoch and its totals are preserved", store.epochs[0].status === "paused" && store.epochs[0].reserved === BigInt(1_480_000) && Array.from(store.charges.values()).filter((c) => c.epochId === 1).length === 37)
    check("generation works again in the new epoch", (await runGeneration(deps, user, 400, "success")).charge.ok && store.epochs[1].reserved === BigInt(40_000))
    check("owner pause pauses for everyone", store.pauseByOwner() === "paused" && (await checkGenerationFunds({ user, credits: 1 }, deps) as { code?: string }).code === "devnet_paused")
    check("QLC epoch checks never touched database credits", forbiddenCredits.touched === 0)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("Source guards: every generation route bills through the central helper")
  const API = join(repo, "src/app/api")
  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? routeFiles(path) : name === "route.ts" ? [path] : []
    })
  }
  /** Source without full-line comments (comments may mention old patterns). */
  const code = (path: string) => readFileSync(path, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n")
  const rel = (path: string) => relative(API, path).replace(/\/route\.ts$/, "")

  const PROVIDER_KINDS: [string, RegExp][] = [
    ["fal-queue", /\bfal(?: as any\))?\.queue\.submit\(/g],
    ["fal-sync", /\bfal(?: as any\))?\.(?:subscribe|run)\(/g],
    ["muapi-app", /\brunMuapiImageApp\(/g],
    ["muapi-http", /fetch\(\s*`\$\{MUAPI_BASE\}/g],
    ["xai", /api\.x\.ai\//g],
    ["openai", /api\.openai\.com\//g],
    ["stability", /api\.stability\.ai\//g],
    ["elevenlabs", /api\.elevenlabs\.io\//g],
    ["anthropic", /api\.anthropic\.com\/|\.messages\.create\(/g],
    ["fal-storage", /\bfal\.storage\.upload\(/g],
  ]
  function providerCalls(source: string): { kind: string; index: number }[] {
    return PROVIDER_KINDS.flatMap(([kind, pattern]) => Array.from(source.matchAll(pattern)).map((m) => ({ kind, index: m.index ?? 0 }))).sort((a, b) => a.index - b.index)
  }

  // Creation routes: expected number of reserve sites (one per provider path).
  const CREATION_ROUTES: Record<string, number> = {
    "apps/background-remover": 1, "apps/image-extension": 1, "apps/object-eraser": 1, "apps/product-photos": 1,
    "apps/skin-enhancer": 1, "apps/style-snap": 1, "apps/text-remover": 1, "character/generate": 1, edit: 1,
    "generate/audio": 3, "generate/image": 3, "generate/influencer": 1, "generate/lip-sync": 2, "generate/video-extend": 1,
    "generate/video-tools": 1, "generate/video": 2, "influencer/generate-image": 1, "marketing/generate": 1,
    "shorts/generate-video": 1, "shorts/generate-voiceover": 1, "storyboard/generate-scene": 1,
    "studio/scenes/[id]/generate": 1, "studio/scenes/[id]/lip-sync": 1, "tools/watermark-remover": 1,
  }
  // Status routes: settle on success, release on failure.
  const STATUS_ROUTES = [
    "apps/background-remover/status/[jobId]", "apps/object-eraser/status/[jobId]", "apps/product-photos/status/[jobId]",
    "apps/skin-enhancer/status/[jobId]", "apps/style-snap/status/[jobId]", "character/generate/status/[jobId]",
    "generate/audio/status/[jobId]", "generate/image/status/[jobId]", "generate/lip-sync/status/[jobId]",
    "generate/video-extend/status/[jobId]", "generate/video-tools/status/[jobId]", "generate/video/status/[jobId]",
    "marketing/generate/status/[jobId]", "studio/scenes/[id]/generate/status", "studio/scenes/[id]/lip-sync/status",
    "tools/watermark-remover/status/[jobId]",
  ]
  // Provider routes that are not charged: unpriced today (no price in src/lib/credits.ts, never charged in
  // credits mode either; pricing them is an owner decision). They still pass the global epoch gate first.
  const UNBILLED_PROVIDER_ROUTES: Record<string, string> = {
    "cinema/director": "LLM shot-planning helper, unpriced",
    "generate/lip-sync/tts": "text-to-speech input for a priced lip-sync generation, unpriced",
    "influencer/generate-content": "LLM caption helper, unpriced",
    "marketing/caption": "LLM caption helper, unpriced",
    scrape: "LLM page summary helper, unpriced",
    "shorts/generate-script": "LLM script helper, unpriced",
    "storyboard/parse-script": "LLM script parser, unpriced",
    "studio/projects/[id]/script": "LLM script helper, unpriced",
    "generate/video/upload": "input upload to provider storage, unpriced",
    "generate/lip-sync/upload": "input upload to provider storage, unpriced",
  }
  // Routes with external calls that are not generation providers (no provider-side generation spend).
  const NON_PROVIDER_ROUTES: Record<string, string> = {
    "studio/projects/[id]/export": "timeline export rendered by Qelarix FFmpeg (server or own export worker); no provider",
    "studio/exports/[id]/process": "runs the Qelarix FFmpeg export; no provider",
    "studio/exports/[id]/status": "export job status; triggers the Qelarix export process only",
    "stripe/checkout": "legacy card checkout (Stripe), not generation",
    "stripe/portal": "legacy billing portal (Stripe), not generation",
    "stripe/webhook": "legacy payment webhook (Stripe), not generation",
    "cron/monthly-rewards": "leaderboard rewards email (Resend), not generation",
    "email/generation-complete": "notification email (Resend), not generation",
    "email/payment-failed": "notification email (Resend), not generation",
    "email/subscription": "notification email (Resend), not generation",
    "email/topup": "notification email (Resend), not generation",
  }

  const files = routeFiles(API)
  const sources = new Map(files.map((f) => [rel(f), code(f)]))
  const unknown: string[] = []
  for (const [route, source] of Array.from(sources)) {
    const calls = providerCalls(source)
    if (calls.length === 0) continue
    if (route in CREATION_ROUTES || STATUS_ROUTES.includes(route) || route in UNBILLED_PROVIDER_ROUTES) continue
    unknown.push(`${route} (${Array.from(new Set(calls.map((c) => c.kind))).join(", ")})`)
  }
  check("every route that calls a generation provider is billed or explicitly listed as unpriced", unknown.length === 0, unknown.join("; "))
  check("listed routes exist", [...Object.keys(CREATION_ROUTES), ...STATUS_ROUTES, ...Object.keys(UNBILLED_PROVIDER_ROUTES)].every((r) => sources.has(r)),
    [...Object.keys(CREATION_ROUTES), ...STATUS_ROUTES, ...Object.keys(UNBILLED_PROVIDER_ROUTES)].filter((r) => !sources.has(r)).join())
  check("unpriced provider routes never charge (no credits, no reserve / settle / funds check)",
    Object.keys(UNBILLED_PROVIDER_ROUTES).every((r) => !/credit|GenerationCharge|checkGenerationFunds/i.test(sources.get(r) ?? "")))
  for (const route of Object.keys(UNBILLED_PROVIDER_ROUTES)) {
    const source = sources.get(route) ?? ""
    const gate = /const (\w+) = await checkGenerationEpoch\(\);?\n\s*if \(!\1\.ok\) return NextResponse\.json\(/.exec(source)
    const first = providerCalls(source)[0]
    check(`${route}: epoch gate returns before the first provider call (${UNBILLED_PROVIDER_ROUTES[route]})`, !!gate && !!first && gate.index < first.index,
      gate ? "" : "no checkGenerationEpoch early return")
  }
  check("non-provider routes are documented and make no provider call", Object.entries(NON_PROVIDER_ROUTES).every(([r]) => sources.has(r) && providerCalls(sources.get(r) ?? "").length === 0),
    Object.keys(NON_PROVIDER_ROUTES).filter((r) => !sources.has(r) || providerCalls(sources.get(r) ?? "").length > 0).join())
  check("status routes only poll providers (no new submission) and stay open while paused so charges settle or refund",
    STATUS_ROUTES.every((r) => !/queue\.submit\(|\.subscribe\(|runMuapiImageApp\(|messages\.create\(/.test(sources.get(r) ?? "")))

  const bypass = Array.from(sources).filter(([, s]) => /deduct_credits/.test(s)).map(([r]) => r)
  check("no API route calls deduct_credits directly (only generationBilling.ts does)", bypass.length === 0, bypass.join())
  const casBypass = Array.from(sources).filter(([, s]) => /credits_deducted:\s*true/.test(s)).map(([r]) => r)
  check("no API route flips generations.credits_deducted itself", casBypass.length === 0, casBypass.join())
  const balanceReads = Array.from(sources).filter(([, s]) => /\.from\(\s*["']profiles["']\s*\)[\s\S]{0,80}?\.select\(\s*["'`][^"'`]*\bcredits\b/.test(s)).map(([r]) => r)
  check("no API route reads profiles.credits (balance comes from getGenerationBalance)", balanceReads.length === 0, balanceReads.join())
  const localPrices = Array.from(sources).flatMap(([r, src]) => Array.from(src.matchAll(/const [A-Z_]*(?:CREDIT|COST)[A-Z_0-9]*\s*(?::[^=]+)?=\s*\d/g)).map((m) => `${r}: ${m[0]}`))
  check("no route-local price constants: every cost comes from src/lib/credits.ts", localPrices.length === 0, localPrices.join("; "))

  for (const [route, expected] of Object.entries(CREATION_ROUTES)) {
    const source = sources.get(route) ?? ""
    const reserves = Array.from(source.matchAll(/reserveGenerationCharge\(/g)).map((m) => m.index ?? 0)
    const calls = providerCalls(source)
    const beforeFirst = calls.filter((c) => c.index < (reserves[0] ?? Infinity))
    const segments = reserves.map((start, i) => calls.filter((c) => c.index > start && c.index < (reserves[i + 1] ?? Infinity)))
    const mixed = segments.filter((segment) => new Set(segment.map((c) => c.kind)).size > 1)
    const ok = reserves.length === expected && calls.length > 0 && beforeFirst.length === 0 && mixed.length === 0 &&
      segments.every((segment) => segment.length > 0) && /checkGenerationFunds\(/.test(source) && /releaseGenerationCharge\(/.test(source)
    check(`${route}: funds check, ${expected} reserve(s) before the provider, release on failure`, ok,
      ok ? "" : `reserves=${reserves.length} providerCalls=${calls.length} beforeFirstReserve=${beforeFirst.map((c) => c.kind)} mixed=${mixed.length}`)
  }
  for (const route of STATUS_ROUTES) {
    const source = sources.get(route) ?? ""
    check(`${route}: settles on success, releases on failure`, /settleGenerationCharge\(/.test(source) && /releaseGenerationCharge\(/.test(source) && /once: ["']generation-row["']|once: ["']this-request["']/.test(source))
  }
  {
    const billing = readFileSync(join(repo, "src/lib/billing/generationBilling.ts"), "utf8")
    check("generationBilling: provider-facing order is check → reserve (charge confirmed) → settle | release",
      billing.indexOf("export async function checkGenerationFunds") < billing.indexOf("export async function reserveGenerationCharge") &&
      /const signature = await chain\.charge\(/.test(billing) && /markCharged\(request\.generationId, signature\)/.test(billing))
    check("generationBilling: QLC mode returns before any database-credit call", /if \(deps\.mode === "credits"\) \{[\s\S]*?\n {2}\}\n\n {2}const priceRefusal = qlcPriceRefusal\(request\)/.test(billing))
    const exemptReads = billing.match(/\.exempt\b/g) ?? []
    check("generationBilling: the exempt flag is read in exactly one place, the credits-mode helper (no QLC-mode bypass)",
      exemptReads.length === 1 && /function creditsBillable\(request: BillingRequest\): boolean \{\n {2}return !request\.exempt/.test(billing))
    const sessionRoutes = ["user/credits", "profile"].map((r) => sources.get(r) ?? "")
    check("header balance endpoints are mode-aware (getGenerationBalance)", sessionRoutes.every((s) => /getGenerationBalance/.test(s)))
    check("the client pause banner uses the locked headline", /DEVNET_PAUSED_MESSAGE/.test(readFileSync(join(repo, "src/components/payments/QlcSpending.tsx"), "utf8")))
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("Maximum single charge (evidence for the program's max_charge_amount)")
  {
    type Cost = { what: string; credits: number }
    const costs: Cost[] = []
    const leaves = (prefix: string, value: unknown) => {
      if (typeof value === "number") costs.push({ what: prefix, credits: value })
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) leaves(`${prefix}.${k}`, v)
    }
    leaves("CREDITS", CREDITS)
    for (const [model, durations] of Object.entries(VIDEO_PRICES)) {
      for (const [seconds, price] of Object.entries(durations)) costs.push({ what: `VIDEO_PRICES.${model}.${seconds}s`, credits: Math.max(price.no, price.yes) })
    }
    for (const m of IMAGE_MODELS) {
      const tiers = [m.credits, ...(m.qualityTiers ?? []).map((t) => t.credits), ...(m.speedTiers ?? []).map((t) => t.credits), ...(m.resolutionTiers ?? []).map((t) => t.credits)]
      costs.push({ what: `image ${m.id} × ${m.maxImages} images`, credits: Math.max(...tiers) * m.maxImages })
    }
    for (const m of AUDIO_MODELS) {
      for (const seconds of [undefined, ...(m.tiers ?? []).map((t) => t.seconds)]) costs.push({ what: `audio ${m.id}${seconds ? ` ${seconds}s` : ""}`, credits: resolveAudioCredits(m, seconds).credits })
    }
    // Route-local cost rules, read from the routes themselves.
    const tools = sources.get("generate/video-tools") ?? ""
    const maxSeconds = Number(/const MAX_UPSCALE_SECONDS = (\d+)/.exec(tools)?.[1])
    const fpsMultiplier = /fps === 60 \? 2 : 1/.test(tools) ? 2 : 1
    const perSecond = Math.max(CREDITS.videoTools.video_upscale_1080p, CREDITS.videoTools.video_upscale_2k, CREDITS.videoTools.video_upscale_4k)
    costs.push({ what: `video upscale 4K × ${fpsMultiplier} (60fps) × ${maxSeconds}s`, credits: perSecond * fpsMultiplier * maxSeconds })
    const reachable = costs.filter((c) => c.what !== "CREDITS.image.gptimage2_hd") // inert compat key, never charged
    reachable.sort((a, b) => b.credits - a.credits)
    const max = reachable[0]
    console.log("      largest single charges: " + reachable.slice(0, 6).map((c) => `${c.what} = ${c.credits}`).join(" · "))
    check("every cost is a positive whole number of credits (0.05-QLC step holds)", reachable.every((c) => Number.isInteger(c.credits) && c.credits > 0), reachable.filter((c) => !Number.isInteger(c.credits) || c.credits <= 0).map((c) => c.what).join())
    check("largest single charge = 1,200 credits = 1,200.00 QLC (video upscale 4K, 60fps, 300s)", max.credits === 1200 && max.what.startsWith("video upscale"), `${max.what} = ${max.credits}`)
    check("recommended max_charge_amount = 120000 base units (1,200.00 QLC) covers every generation", qlcAmountFor(max.credits) === MAX_CHARGE)
    const blocked = reachable.filter((c) => c.credits > 100).map((c) => `${c.what}=${c.credits}`)
    check("today's devnet cap (10000 = 100.00 QLC) refuses these charges (charge_above_limit)", blocked.length > 0, `${blocked.length} costs above 100 QLC, e.g. ${blocked.slice(0, 4).join(", ")}`)
    check("the largest charge fits the 15,000 QLC epoch and the 10,000 QLC max allowance", qlcAmountFor(max.credits) <= EPOCH_LIMIT && max.credits <= MAX_ALLOWANCE_QLC)
  }
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
