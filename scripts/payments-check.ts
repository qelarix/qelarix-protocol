// Offline checks for the generic QLC payment engine: asset configuration, price sources, quote
// math, the SPL-token and native-SOL adapters (build + verification rules), the engine flows
// (offer, quote, transaction with membership, confirm, settlement, delivery), the background
// recovery job and the exactly-once delivery queue.
// No network, no database, no chain. Database guarantees are covered by scripts/payments-db-check.mjs;
// the on-chain program by `npm run qlc:test` and scripts/payments-local-e2e.ts (local validator).
//
//   npm run check:payments
import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { NextRequest } from "next/server"
import {
  AccountRole,
  address,
  createNoopSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit"
import type { AuthUser } from "../src/lib/authSession"
import { SolanaRpcError, type SolanaRpcCall } from "../src/lib/solanaRpc"
import { formatTokenAmount, formatUsd, pow10 } from "../src/lib/payments/tokenAmount"
import { resolvePaymentDeployment, CLUSTER_GENESIS_HASHES, SETTLEMENT_GRACE_MS, MAX_OPEN_INTENTS_PER_USER } from "../src/lib/payments/paymentConfig"
import { payableAssets, toPayableAsset, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, PYTH_RECEIVER_PROGRAM, type PaymentAssetRow } from "../src/lib/payments/paymentAssets"
import { paymentAmountFor, quotePrice, PriceUnavailableError } from "../src/lib/payments/priceSources"
import { selectOfferedPacks, type PricePackRow } from "../src/lib/payments/qlcPricing"
import { adapterFor, findAssociatedTokenAddress, type ExpectedPayment, type ParsedTransaction } from "../src/lib/payments/adapters"
import { deliveryIdFor, processDelivery, type QlcDeliverer, type QlcDeliveryRecord } from "../src/lib/payments/qlcDeliveries"
import { recoverPayments, STUCK_DELIVERY_ATTEMPTS } from "../src/lib/payments/paymentRecovery"
import { checkCronAuthorization } from "../src/lib/cronAuth"
import { QELARIX_QLC_PROGRAM_ADDRESS, findMemberPda } from "../src/lib/qlc/generated"
import { createQlcOperator } from "../src/lib/qlc/qlcOperator"
import {
  confirmPayment,
  createPaymentIntent,
  createPaymentTransaction,
  createSupabasePaymentStore,
  getPaymentOffer,
  PaymentClusterMismatchError,
  type PaymentEngineDeps,
  type PaymentIntent,
  type PaymentStore,
  type QlcPaymentOperator,
  type SettleOutcome,
} from "../src/lib/payments/paymentEngine"
import { formatQlc, isQlcStep } from "../src/lib/qlc/qlcProgram"
import { missingIdentity, testSigner } from "./test-identities"

let failures = 0
let blockedChecks = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
/** A check that needs an owner test identity that is not provided: never passes, never runs. */
function blocked(name: string, reason: string) {
  blockedChecks++
  console.log(`BLOCKED  ${name}  — ${reason}`)
}
async function rejects(fn: () => Promise<unknown>, type: new (...args: never[]) => Error): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return err instanceof type
  }
}

const B = (value: number | string) => BigInt(value)
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const OTHER_WALLET = "3SHFoCECA6E7tDLnb1jYXS84NUQYofDwCJQKxCnMm4TK"
const TREASURY = "2sU8tYPvkMBRDoY2TtjhdjzrghWQyjQVuHUPYBCsjejm"
const TREASURY_USDC_ON_CHAIN = "wXtPRv7rPpaKY4CkkWvcejg3Frvb4A9hbApQeEEDxi2" // real devnet account
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const FAKE_MINT = "So11111111111111111111111111111111111111112"
const PYTH_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
const BLOCKHASHES = ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"]
const REFERENCES = ["BdzvaQHiBbWx3bFTonBrkETX8kfQkEosH8TxvPYVVYCT", "4QKMKYZ9u7z8SPNLfuYxz8vTJgtedP4g25wkeuiMtyP6", "8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT", "J3TgzThz6VfGjZ1aPABma3Q2eKhmaN4DRQhCMxYjdcFy", "HgraPQLCz7jdTAg4oYgKNoUTxvwk77oWEdKgELkUYUiN", "75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza"]
const sig = (seed: string) => `${seed}${"Z".repeat(88 - seed.length)}`
const NOW = new Date("2026-10-02T12:00:00Z")
const NOW_S = Math.floor(NOW.getTime() / 1000)
const USER_ID = "6f1c2c1e-6c3f-4d55-9d1e-2b8f4a0d9c11"
const OTHER_USER_ID = "0b1c2c1e-6c3f-4d55-9d1e-2b8f4a0d9c22"
const walletUser: AuthUser = { id: USER_ID, email: null, plan: null, walletAddress: WALLET }
const otherUser: AuthUser = { id: OTHER_USER_ID, email: null, plan: null, walletAddress: OTHER_WALLET }
const legacyUser: AuthUser = { id: USER_ID, email: "legacy@example.com", plan: "free", walletAddress: null }

function decodeMessage(bytes: Uint8Array | ReadonlyUint8Array) {
  const message = getCompiledTransactionMessageDecoder().decode(bytes)
  if (!("instructions" in message)) throw new Error("unexpected message version")
  return message
}
const decodeWire = (wire: string) => decodeMessage(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes)
const accountsOf = (ix: Instruction) => (ix.accounts ?? []).map((a) => `${a.address}:${a.role}`).join()

function asset(id: string, extra: Partial<PaymentAssetRow> = {}): PaymentAssetRow {
  return {
    id, cluster: "devnet", symbol: "USDC", kind: "spl-token", mint: USDC, token_program: TOKEN_PROGRAM, decimals: 6, treasury_address: TREASURY,
    price_source: { kind: "usd-peg" }, quote_ttl_secs: 900, is_enabled: true, approved_by: "PixiMan", approved_at: "2026-10-02T00:00:00Z", sort_order: 10, ...extra,
  }
}
const SOL_ROW = asset("devnet-sol", {
  symbol: "SOL", kind: "native-sol", mint: null, token_program: null, decimals: 9, quote_ttl_secs: 120, sort_order: 20,
  price_source: { kind: "pyth-account", account: PYTH_ACCOUNT, feedId: SOL_FEED, maxAgeSecs: 60, maxConfidenceBps: 100 },
})
function pack(id: string, qlc: number, usd: number, extra: Partial<PricePackRow> = {}): PricePackRow {
  return {
    id, cluster: "devnet", qlc_amount: qlc, usd_value_micros: usd, list_usd_value_micros: null, label: id, badge: null, highlighted: false,
    region: null, replaces_pack_id: null, offer: null, sort_order: qlc, is_active: true, starts_at: null, ends_at: null, ...extra,
  }
}
const PACKS = () => [pack("devnet-500", 50000, 4990000), pack("devnet-1500", 150000, 12990000, { highlighted: true })]

/** A Pyth PriceUpdateV2 account as returned by getAccountInfo (base64). */
function pythAccount(opts: { price?: bigint; conf?: bigint; expo?: number; publishTime?: number; feed?: string; verification?: number; owner?: string; discriminator?: string } = {}) {
  const data = Buffer.alloc(134)
  Buffer.from(opts.discriminator ?? "22f123639d7ef4cd", "hex").copy(data, 0)
  let o = 8 + 32
  data[o] = opts.verification ?? 1
  o += 1
  Buffer.from(opts.feed ?? SOL_FEED, "hex").copy(data, o)
  o += 32
  data.writeBigInt64LE(opts.price ?? B(12182492516), o)
  o += 8
  data.writeBigUInt64LE(opts.conf ?? B(1394042), o)
  o += 8
  data.writeInt32LE(opts.expo ?? -8, o)
  o += 4
  data.writeBigInt64LE(B(opts.publishTime ?? NOW_S - 5), o)
  return { value: { owner: opts.owner ?? PYTH_RECEIVER_PROGRAM, data: [data.toString("base64"), "base64"] } }
}

async function main() {
  // ── Amounts ────────────────────────────────────────────────────────────────
  check("pow10 and token formatting", pow10(0) === B(1) && pow10(9) === B(1000000000) && formatTokenAmount(B(4990000), 6) === "4.99" && formatTokenAmount(B(40960123), 9) === "0.040960123" && formatTokenAmount(B(50000), 2, 0) === "500")
  check("USD and QLC formatting", formatUsd(B(12990000)) === "$12.99" && formatQlc(B(150)) === "1.50" && formatQlc(B(1000000)) === "10,000.00")
  check("QLC step: positive multiples of 0.05 only", isQlcStep(B(5)) && isQlcStep(B(50000)) && !isQlcStep(B(0)) && !isQlcStep(B(101)) && !isQlcStep(B(-5)))

  // ── Deployment ─────────────────────────────────────────────────────────────
  const reason = (env: Record<string, string | undefined>) => { const r = resolvePaymentDeployment(env); return r.enabled ? "enabled" : r.reason }
  check("deployment: no cluster → disabled", reason({}) === "cluster_not_configured")
  check("deployment: mainnet cannot be enabled by env", reason({ NEXT_PUBLIC_SOLANA_CLUSTER: "mainnet-beta" }) === "cluster_not_enabled")
  const dev = resolvePaymentDeployment({ NEXT_PUBLIC_SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "http://rpc.test" })
  check("deployment: devnet with devnet genesis and solana:devnet", dev.enabled && dev.deployment.genesisHash === CLUSTER_GENESIS_HASHES.devnet && dev.deployment.chain === "solana:devnet")

  // ── Asset configuration ────────────────────────────────────────────────────
  check("assets: enabled + approved USDC row is payable", toPayableAsset(asset("devnet-usdc"), "devnet")?.symbol === "USDC")
  check("assets: disabled row is not payable", toPayableAsset(asset("x", { is_enabled: false }), "devnet") === null)
  check("assets: enabled without approval is not payable", toPayableAsset(asset("x", { approved_by: null }), "devnet") === null)
  check("assets: other cluster is not payable", toPayableAsset(asset("x", { cluster: "mainnet-beta" }), "devnet") === null)
  check("assets: unknown token program is not payable", toPayableAsset(asset("x", { token_program: OTHER_WALLET }), "devnet") === null)
  check("assets: Token-2022 partner token is supported", toPayableAsset(asset("partner", { token_program: TOKEN_2022_PROGRAM, symbol: "PRT", mint: FAKE_MINT }), "devnet")?.tokenProgram === TOKEN_2022_PROGRAM)
  check("assets: spl-token without mint is not payable", toPayableAsset(asset("x", { mint: null }), "devnet") === null)
  check("assets: native SOL must have 9 decimals and no mint", toPayableAsset(asset("x", { kind: "native-sol", mint: null, token_program: null, decimals: 9 }), "devnet") !== null && toPayableAsset(asset("x", { kind: "native-sol", mint: null, token_program: null, decimals: 6 }), "devnet") === null)
  check("assets: invalid treasury / ttl / price source are not payable",
    toPayableAsset(asset("x", { treasury_address: "nope" }), "devnet") === null &&
    toPayableAsset(asset("x", { quote_ttl_secs: 5 }), "devnet") === null &&
    toPayableAsset(asset("x", { price_source: { kind: "pyth-account", account: PYTH_ACCOUNT, feedId: "zz", maxAgeSecs: 60, maxConfidenceBps: 100 } }), "devnet") === null &&
    toPayableAsset(asset("x", { price_source: { kind: "oracle-of-my-choice" } }), "devnet") === null)
  check("assets: payable list sorted, malformed rows dropped", payableAssets([SOL_ROW, asset("devnet-usdc"), asset("bad", { kind: "nft" })], "devnet").map((a) => a.id).join() === "devnet-usdc,devnet-sol")

  // ── Prices and quote math ──────────────────────────────────────────────────
  check("quote: USD peg pays USDC 1:1 in base units", paymentAmountFor(B(4990000), 6, { price: B(1), expo: 0 }) === B(4990000))
  const lamports = paymentAmountFor(B(4990000), 9, { price: B(12182492516), expo: -8 })
  check("quote: SOL amount = ceil(USD / price) in lamports", lamports === B(40960424) || lamports === B(Math.ceil((4.99 / 121.82492516) * 1e9)), lamports.toString())
  check("quote: rounding is always up", paymentAmountFor(B(1), 9, { price: B(3), expo: 0 }) === B(334) && paymentAmountFor(B(10), 2, { price: B(3), expo: 0 }) === B(1))
  const pythRpc = (account: unknown): SolanaRpcCall => (async (method: string) => {
    if (method === "getAccountInfo") return account
    throw new Error(`unexpected ${method}`)
  }) as SolanaRpcCall
  const solSource = toPayableAsset(SOL_ROW, "devnet")!.priceSource
  const fresh = await quotePrice(solSource, pythRpc(pythAccount()), NOW)
  check("price: verified fresh Pyth SOL/USD account is accepted", fresh.price === B(12182492516) && fresh.expo === -8 && fresh.snapshot.ageSecs === 5 && fresh.source === `pyth:${SOL_FEED}`)
  const refused = async (opts: Parameters<typeof pythAccount>[0]) => rejects(() => quotePrice(solSource, pythRpc(pythAccount(opts)), NOW), PriceUnavailableError)
  check("price: account not owned by the Pyth receiver → refused", await refused({ owner: OTHER_WALLET }))
  check("price: wrong account type → refused", await refused({ discriminator: "0000000000000000" }))
  check("price: partially verified update → refused", await refused({ verification: 0 }))
  check("price: other feed → refused", await refused({ feed: "aa".repeat(32) }))
  check("price: stale (older than 60 s) → refused", await refused({ publishTime: NOW_S - 61 }))
  check("price: confidence band above 1 % → refused", await refused({ conf: B(12182492516) / B(50) }))
  check("price: non-positive price → refused", await refused({ price: B(0) }))
  check("price: missing account → refused", await rejects(() => quotePrice(solSource, pythRpc({ value: null }), NOW), PriceUnavailableError))

  // ── Pricing configuration ──────────────────────────────────────────────────
  const offered = selectOfferedPacks([...PACKS(), pack("bad-step", 101, 1000), pack("free", 50000, 0)], { cluster: "devnet", region: null, now: NOW })
  check("packs: canonical USD values, QLC base units; off-step and zero-value rows dropped", offered.map((p) => `${p.id}:${p.qlcAmount}:${p.usdValueMicros}`).join() === "devnet-500:50000:4990000,devnet-1500:150000:12990000")

  // ── SPL token adapter ──────────────────────────────────────────────────────
  const usdc = toPayableAsset(asset("devnet-usdc"), "devnet")!
  const spl = adapterFor("spl-token")
  const treasuryUsdc = await spl.destinationAccount(usdc)
  const payerUsdc = await findAssociatedTokenAddress(WALLET, USDC, TOKEN_PROGRAM)
  check("spl: treasury token account matches a real devnet USDC account", treasuryUsdc === TREASURY_USDC_ON_CHAIN)
  const splIx = await spl.transferInstruction({ asset: usdc, payer: WALLET, destinationAccount: treasuryUsdc, amount: B(12990000), reference: REFERENCES[0] })
  const splData = Array.from(splIx.data ?? [])
  check(
    "spl: one TransferChecked under the asset's token program, payer → treasury, reference appended, exact amount and decimals",
    splIx.programAddress === TOKEN_PROGRAM &&
      accountsOf(splIx) === [`${payerUsdc}:${AccountRole.WRITABLE}`, `${USDC}:${AccountRole.READONLY}`, `${treasuryUsdc}:${AccountRole.WRITABLE}`, `${WALLET}:${AccountRole.READONLY_SIGNER}`, `${REFERENCES[0]}:${AccountRole.READONLY}`].join() &&
      splData[0] === 12 && splData[9] === 6 && Buffer.from(splData.slice(1, 9)).readBigUInt64LE() === B(12990000),
  )
  const partner = toPayableAsset(asset("partner", { token_program: TOKEN_2022_PROGRAM, symbol: "PRT", mint: FAKE_MINT, decimals: 9 }), "devnet")!
  const partnerIx = await spl.transferInstruction({ asset: partner, payer: WALLET, destinationAccount: await spl.destinationAccount(partner), amount: B(5), reference: REFERENCES[1] })
  check("spl: Token-2022 partner transfer uses the Token-2022 program", partnerIx.programAddress === TOKEN_2022_PROGRAM)

  const splExpected: ExpectedPayment = { payer: WALLET, treasury: TREASURY, destinationAccount: treasuryUsdc, amount: B(12990000), reference: REFERENCES[0], mint: USDC, tokenProgram: TOKEN_PROGRAM, decimals: 6 }
  interface SplOpts { payer?: string; signer?: boolean; reference?: string; err?: unknown; type?: string; programId?: string; mint?: string; destination?: string; authority?: string; legacyAuthority?: boolean; extraSigner?: boolean; sourceOwner?: string; amount?: string; decimals?: number; pre?: string | null; post?: string; postOwner?: string; blockTime?: number | null; inner?: boolean }
  const splTx = (o: SplOpts = {}, base: ExpectedPayment = splExpected): ParsedTransaction => {
    const payer = o.payer ?? base.payer
    const destination = o.destination ?? base.destinationAccount
    const transfer = {
      programId: o.programId ?? base.tokenProgram!,
      program: "spl-token",
      parsed: {
        type: o.type ?? "transferChecked",
        info: {
          source: payerUsdc, mint: o.mint ?? base.mint, destination,
          // How RPC parsers report a TransferChecked with the reference appended (see the adapter).
          ...(o.legacyAuthority
            ? { authority: o.authority ?? payer }
            : { multisigAuthority: o.authority ?? payer, signers: o.extraSigner ? [base.reference, OTHER_WALLET] : [base.reference] }),
          tokenAmount: { amount: o.amount ?? base.amount.toString(), decimals: o.decimals ?? base.decimals },
        },
      },
    }
    const pre = o.pre === undefined ? "5000000" : o.pre
    return {
      slot: 123, blockTime: o.blockTime === undefined ? NOW_S : o.blockTime,
      meta: {
        err: o.err ?? null,
        preTokenBalances: [
          { accountIndex: 1, mint: base.mint!, owner: o.sourceOwner ?? payer, uiTokenAmount: { amount: "200000000", decimals: base.decimals } },
          ...(pre === null ? [] : [{ accountIndex: 2, mint: base.mint!, owner: base.treasury, uiTokenAmount: { amount: pre, decimals: base.decimals } }]),
        ],
        postTokenBalances: [{ accountIndex: 2, mint: base.mint!, owner: o.postOwner ?? base.treasury, uiTokenAmount: { amount: o.post ?? (B(pre ?? "0") + base.amount).toString(), decimals: base.decimals } }],
        innerInstructions: o.inner ? [{ index: 0, instructions: [transfer] }] : [],
      },
      transaction: { message: {
        accountKeys: [
          { pubkey: payer, signer: o.signer ?? true }, { pubkey: payerUsdc, signer: false }, { pubkey: destination, signer: false },
          { pubkey: base.mint!, signer: false }, ...(o.reference === "" ? [] : [{ pubkey: o.reference ?? base.reference, signer: false }]),
        ],
        instructions: [transfer],
      } },
    }
  }
  const splVerdict = (tx: ParsedTransaction | null) => { const r = spl.verify(sig("1"), tx, splExpected); return r.status === "rejected" ? r.reason : r.status }
  check("spl verify: exact payment verified with chain slot and block time", (() => { const r = spl.verify(sig("1"), splTx(), splExpected); return r.status === "verified" && r.payment.amount === B(12990000) && r.payment.slot === 123 && r.payment.blockTime.getTime() === NOW.getTime() })())
  const splCases: [string, SplOpts | null, string][] = [
    ["not finalized", null, "not_found"],
    ["failed transaction", { err: { InstructionError: [0, "Custom"] } }, "transaction_failed"],
    ["payer did not sign", { signer: false }, "payer_not_signer"],
    ["other payer", { payer: OTHER_WALLET }, "payer_not_signer"],
    ["reference missing", { reference: "" }, "reference_missing"],
    ["wrong mint", { mint: FAKE_MINT }, "wrong_mint"],
    ["transfer elsewhere", { destination: payerUsdc }, "no_transfer"],
    ["treasury account owned by someone else", { postOwner: OTHER_WALLET }, "wrong_destination"],
    ["one base unit short", { amount: "12989999" }, "wrong_amount"],
    ["one base unit over", { amount: "12990001" }, "wrong_amount"],
    ["wrong decimals", { decimals: 9 }, "wrong_decimals"],
    ["other plain authority", { legacyAuthority: true, authority: OTHER_WALLET }, "wrong_authority"],
    ["real multisig authority (another key)", { authority: OTHER_WALLET }, "wrong_authority"],
    ["extra signer besides the reference", { extraSigner: true }, "wrong_authority"],
    ["source token account owned by someone else", { sourceOwner: OTHER_WALLET }, "wrong_source"],
    ["unchecked transfer", { type: "transfer" }, "wrong_program"],
    ["other token program", { programId: TOKEN_2022_PROGRAM }, "wrong_program"],
    ["second transfer (inner)", { inner: true }, "multiple_transfers"],
    ["balance change differs (fee-on-transfer)", { post: "6000000" }, "balance_mismatch"],
    ["missing block time", { blockTime: null }, "missing_block_time"],
  ]
  for (const [label, opts, expected] of splCases) check(`spl verify: ${label} → ${expected}`, splVerdict(opts === null ? null : splTx(opts)) === expected)
  check("spl verify: treasury account created in the same transaction → verified", splVerdict(splTx({ pre: null })) === "verified")
  check("spl verify: plain authority shape (no appended accounts) is also accepted", splVerdict(splTx({ legacyAuthority: true })) === "verified")

  // ── Native SOL adapter ─────────────────────────────────────────────────────
  const sol = adapterFor("native-sol")
  const solAsset = toPayableAsset(SOL_ROW, "devnet")!
  const solIx = await sol.transferInstruction({ asset: solAsset, payer: WALLET, destinationAccount: TREASURY, amount: B(40960424), reference: REFERENCES[2] })
  const solData = Buffer.from(Array.from(solIx.data ?? []))
  check(
    "sol: one System transfer payer → treasury with reference, exact lamports",
    solIx.programAddress === "11111111111111111111111111111111" &&
      accountsOf(solIx) === [`${WALLET}:${AccountRole.WRITABLE_SIGNER}`, `${TREASURY}:${AccountRole.WRITABLE}`, `${REFERENCES[2]}:${AccountRole.READONLY}`].join() &&
      solData.readUInt32LE(0) === 2 && solData.readBigUInt64LE(4) === B(40960424),
  )
  const solExpected: ExpectedPayment = { payer: WALLET, treasury: TREASURY, destinationAccount: TREASURY, amount: B(40960424), reference: REFERENCES[2], mint: null, tokenProgram: null, decimals: 9 }
  interface SolOpts { err?: unknown; signer?: boolean; reference?: string; source?: string; destination?: string; lamports?: number; type?: string; program?: string; delta?: number; blockTime?: number | null; second?: boolean }
  const solTx = (o: SolOpts = {}): ParsedTransaction => {
    const transfer = { programId: o.program ?? "11111111111111111111111111111111", program: "system", parsed: { type: o.type ?? "transfer", info: { source: o.source ?? WALLET, destination: o.destination ?? TREASURY, lamports: o.lamports ?? 40960424 } } }
    return {
      slot: 456, blockTime: o.blockTime === undefined ? NOW_S : o.blockTime,
      meta: { err: o.err ?? null, preBalances: [5_000_000_000, 1_000_000], postBalances: [5_000_000_000 - 40960424 - 5000, 1_000_000 + (o.delta ?? 40960424)], innerInstructions: o.second ? [{ index: 0, instructions: [transfer] }] : [] },
      transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: o.signer ?? true }, { pubkey: TREASURY, signer: false }, ...(o.reference === "" ? [] : [{ pubkey: o.reference ?? REFERENCES[2], signer: false }])], instructions: [transfer] } },
    }
  }
  const solVerdict = (tx: ParsedTransaction | null) => { const r = sol.verify(sig("2"), tx, solExpected); return r.status === "rejected" ? r.reason : r.status }
  check("sol verify: exact payment verified", solVerdict(solTx()) === "verified")
  const solCases: [string, SolOpts | null, string][] = [
    ["not finalized", null, "not_found"],
    ["failed transaction", { err: { InstructionError: [0, "Custom"] } }, "transaction_failed"],
    ["payer did not sign", { signer: false }, "payer_not_signer"],
    ["reference missing", { reference: "" }, "reference_missing"],
    ["transfer elsewhere", { destination: OTHER_WALLET }, "no_transfer"],
    ["paid from another wallet", { source: OTHER_WALLET }, "wrong_source"],
    ["one lamport short", { lamports: 40960423 }, "wrong_amount"],
    ["not a plain transfer", { type: "transferWithSeed" }, "wrong_program"],
    ["second transfer", { second: true }, "multiple_transfers"],
    ["treasury balance differs", { delta: 1 }, "balance_mismatch"],
    ["missing block time", { blockTime: null }, "missing_block_time"],
  ]
  for (const [label, opts, expected] of solCases) check(`sol verify: ${label} → ${expected}`, solVerdict(opts === null ? null : solTx(opts)) === expected)

  // ── Engine ─────────────────────────────────────────────────────────────────
  // The real operator's register_member builder (no RPC needed), signing with the owner's test operator.
  // Without it the engine runs with a key-less placeholder (a derived address that has no private key) and
  // the signature check is BLOCKED.
  const ownerOperator = await testSigner("operator")
  const placeholder = await getProgramDerivedAddress({ programAddress: address("11111111111111111111111111111111"), seeds: ["qelarix-test-operator"] })
  const operatorSigner = ownerOperator ?? createNoopSigner(placeholder[0])
  const QLC_MINT = address("85T3fZ4iQLmiBNC4eVd4cNhWMaK2Zarc8SesYdQf48c")
  const realOperator = createQlcOperator({ rpc: {} as never, rpcSubscriptions: {} as never, operator: operatorSigner, mint: QLC_MINT })
  const [walletMember] = await findMemberPda({ wallet: address(WALLET) })

  type MockDelivery = QlcDeliveryRecord & { nextAttemptAt: Date | null; cluster: string }
  interface World {
    deps: PaymentEngineDeps
    assets: PaymentAssetRow[]
    packs: PricePackRow[]
    intents: Map<string, PaymentIntent>
    deliveries: Map<string, MockDelivery>
    chain: { genesis: string; tokenBalances: Map<string, bigint>; lamports: Map<string, bigint>; txs: Map<string, ParsedTransaction>; refs: Map<string, string[]>; pyth: unknown; down: boolean; blockhashes: number }
    delivered: { id: string; amount: bigint; wallet: string }[]
    qlcDown: { value: boolean }
    /** The program's on-chain limits as the mock operator reports them (read live on every call). */
    limits: { maxDeliveryAmount: bigint; mintWindowCap: bigint; paused: boolean; unreadable: boolean }
    clock: { now: Date }
  }
  const makeWorld = (opts: { assets?: PaymentAssetRow[]; qlc?: boolean; env?: Record<string, string> } = {}): World => {
    const assets = (opts.assets ?? [asset("devnet-usdc"), SOL_ROW]).map((row) => ({ ...row }))
    const packs = PACKS()
    const intents = new Map<string, PaymentIntent>()
    const deliveries = new Map<string, MockDelivery>()
    const chain = {
      genesis: CLUSTER_GENESIS_HASHES.devnet,
      tokenBalances: new Map<string, bigint>([[treasuryUsdc, B(0)], [payerUsdc, B(200000000)]]),
      lamports: new Map<string, bigint>([[WALLET, B(5_000_000_000)]]),
      txs: new Map<string, ParsedTransaction>(),
      refs: new Map<string, string[]>(),
      pyth: pythAccount() as unknown,
      down: false,
      blockhashes: 0,
    }
    const clock = { now: NOW }
    const delivered: World["delivered"] = []
    const qlcDown = { value: false }
    const limits = { maxDeliveryAmount: B(1_000_000), mintWindowCap: B(2_000_000), paused: false, unreadable: false }
    const onChainReceipts = new Map<string, { fromVault: bigint; minted: bigint }>()
    let seq = 0
    let refSeq = 0
    const rpc = (async (method: string, params: unknown[]) => {
      if (chain.down) throw new SolanaRpcError("rpc down")
      const p = params as [string, Record<string, unknown>]
      switch (method) {
        case "getGenesisHash": return chain.genesis
        case "getLatestBlockhash": chain.blockhashes++; return { value: { blockhash: BLOCKHASHES[chain.blockhashes % 2], lastValidBlockHeight: 1000 + chain.blockhashes } }
        case "getAccountInfo":
          if (p[0] === PYTH_ACCOUNT) return chain.pyth
          return { value: chain.tokenBalances.has(p[0]) ? { data: { parsed: { info: { tokenAmount: { amount: chain.tokenBalances.get(p[0])!.toString() } } } } } : null }
        case "getBalance": return { value: Number(chain.lamports.get(p[0]) ?? B(0)) }
        case "getTransaction": return chain.txs.get(p[0]) ?? null
        case "getSignaturesForAddress": return (chain.refs.get(p[0]) ?? []).map((signature) => ({ signature }))
      }
      throw new Error(`unexpected rpc ${method}`)
    }) as SolanaRpcCall
    const qlc: QlcPaymentOperator = {
      membershipInstruction: (wallet) => realOperator.membershipInstruction(wallet),
      async limits() {
        if (limits.unreadable) throw new Error("rpc unavailable")
        return { maxDeliveryAmount: limits.maxDeliveryAmount, maxChargeAmount: BigInt(10000), mintWindowCap: limits.mintWindowCap, paused: limits.paused }
      },
      async deliver({ deliveryId, wallet, amount }) {
        if (qlcDown.value) throw new Error("operator unavailable")
        const key = Buffer.from(deliveryId).toString("hex")
        const existing = onChainReceipts.get(key)
        if (existing) return { status: "already_delivered", ...existing }
        onChainReceipts.set(key, { fromVault: B(0), minted: amount })
        delivered.push({ id: key, amount, wallet })
        return { status: "delivered", signature: sig(`dl${delivered.length}`), fromVault: B(0), minted: amount }
      },
    }
    const store: PaymentStore = {
      async listPricePacks(cluster) { return packs.filter((r) => r.cluster === cluster && r.is_active) },
      async listPaymentAssets(cluster) { return assets.filter((r) => r.cluster === cluster && r.is_enabled) },
      async countOpenIntents(userId, now) { return Array.from(intents.values()).filter((i) => i.userId === userId && i.status === "pending" && i.expiresAt > now).length },
      async createIntent(input) {
        const intent: PaymentIntent = { ...input, id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, status: "pending", txSignature: null, deliveryId: null }
        intents.set(intent.id, intent)
        return { ...intent }
      },
      async getIntent(id) { const i = intents.get(id); return i ? { ...i } : null },
      async getDelivery(id) { const d = deliveries.get(id); return d ? { ...d } : null },
      async markDelivered(id, result) { const d = deliveries.get(id)!; Object.assign(d, { status: "delivered", txSignature: result.signature, fromVault: result.fromVault, minted: result.minted }) },
      // Mirrors record_qlc_delivery_attempt: backoff 1, 2, 4 ... minutes, capped at 1 hour.
      async recordAttempt(id, error) {
        const d = deliveries.get(id)!
        if (d.status !== "pending") return
        d.nextAttemptAt = new Date(clock.now.getTime() + Math.min(2 ** Math.min(d.attempts, 6), 60) * 60_000)
        d.attempts++
        d.lastError = error
      },
      async listPendingIntents(cluster, limit) {
        return Array.from(intents.values()).filter((i) => i.cluster === cluster && i.status === "pending").sort((a, b) => a.quotedAt.getTime() - b.quotedAt.getTime()).slice(0, limit).map((i) => ({ ...i }))
      },
      async closeExpiredIntent(id, cutoff) {
        const i = intents.get(id)
        if (!i || i.status !== "pending" || !(i.expiresAt < cutoff)) return false
        i.status = "expired"
        return true
      },
      async listDueDeliveries(cluster, limit) {
        return Array.from(deliveries.values())
          .filter((d) => d.cluster === cluster && d.status === "pending" && (d.nextAttemptAt === null || d.nextAttemptAt <= clock.now))
          .sort((a, b) => (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0))
          .slice(0, limit)
          .map((d) => ({ ...d }))
      },
      // Mirrors settle_payment_intent; the real function is exercised by the database check.
      async settle(intent, userId, p): Promise<SettleOutcome> {
        const i = intents.get(intent.id)
        if (!i || i.userId !== userId) return { status: "unknown_intent" }
        if (i.status === "paid") return i.txSignature === p.signature ? { status: "already_paid", deliveryId: i.deliveryId!, signature: i.txSignature! } : { status: "intent_already_paid", signature: i.txSignature! }
        if (i.walletAddress !== p.payer) return { status: "payer_mismatch" }
        if (i.mint !== p.mint) return { status: "asset_mismatch" }
        if (i.treasury !== p.treasury || i.destinationAccount !== p.destinationAccount) return { status: "destination_mismatch" }
        if (i.paymentAmount !== p.amount) return { status: "amount_mismatch" }
        if (i.reference !== p.reference) return { status: "reference_mismatch" }
        if (p.blockTime > i.expiresAt) return { status: "expired" }
        if (Array.from(intents.values()).some((x) => x.txSignature === p.signature)) return { status: "signature_used" }
        const deliveryId = `d-${i.id}`
        deliveries.set(deliveryId, { id: deliveryId, deliveryKey: `payment:${i.id}`, walletAddress: i.walletAddress, qlcAmount: i.qlcAmount, kind: "purchase", status: "pending", txSignature: null, fromVault: null, minted: null, attempts: 0, lastError: null, nextAttemptAt: null, cluster: i.cluster })
        Object.assign(i, { status: "paid", txSignature: p.signature, deliveryId })
        return { status: "paid", deliveryId, signature: p.signature }
      },
    }
    return {
      deps: {
        deployment: resolvePaymentDeployment(opts.env ?? { NEXT_PUBLIC_SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: `http://rpc-${Math.random()}.test` }),
        store, rpc, qlc: opts.qlc === false ? null : qlc, now: () => clock.now, newReference: () => REFERENCES[refSeq++ % REFERENCES.length],
      },
      assets, packs, intents, deliveries, chain, delivered, qlcDown, clock, limits,
    }
  }
  const quote = async (w: World, assetId = "devnet-usdc", packId = "devnet-1500") => {
    const r = await createPaymentIntent(walletUser, { packId, assetId }, null, w.deps)
    if (r.status !== "ok") throw new Error(`quote failed: ${JSON.stringify(r)}`)
    return { result: r, intent: w.intents.get(r.intent.id)! }
  }
  const usdcTxFor = (i: PaymentIntent, o: SplOpts = {}) => splTx(o, { payer: i.walletAddress, treasury: i.treasury, destinationAccount: i.destinationAccount, amount: i.paymentAmount, reference: i.reference, mint: i.mint, tokenProgram: i.tokenProgram, decimals: i.decimals })
  const solTxFor = (i: PaymentIntent): ParsedTransaction => {
    const t = solTx({ lamports: Number(i.paymentAmount), delta: Number(i.paymentAmount) })
    t.transaction.message.accountKeys[2] = { pubkey: i.reference, signer: false }
    return t
  }

  // Availability
  check("engine: no QLC delivery available → nothing is offered or quoted", (await getPaymentOffer(walletUser, null, makeWorld({ qlc: false }).deps)).status === "disabled" && (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, makeWorld({ qlc: false }).deps)).status === "disabled")
  check("engine: mainnet deployment is disabled", (await getPaymentOffer(walletUser, null, makeWorld({ env: { NEXT_PUBLIC_SOLANA_CLUSTER: "mainnet-beta" } }).deps)).status === "disabled")
  check("engine: no payable asset → disabled", (await getPaymentOffer(walletUser, null, makeWorld({ assets: [asset("x", { is_enabled: false })] }).deps)).status === "disabled")
  let w = makeWorld()
  check("engine: legacy (non-wallet) session cannot buy", (await getPaymentOffer(legacyUser, null, w.deps)).status === "wallet_required" && (await createPaymentIntent(legacyUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, w.deps)).status === "wallet_required")
  const offer = await getPaymentOffer(walletUser, null, w.deps)
  check("engine: offer lists packs (USD value, QLC base units) and payable assets", offer.status === "ok" && offer.packs.map((p) => `${p.qlcAmount}=${p.usdValueMicros}`).join() === "50000=4990000,150000=12990000" && offer.assets.map((a) => a.symbol).join() === "USDC,SOL")
  w.packs[0].usd_value_micros = 4490000
  const repriced = await getPaymentOffer(walletUser, null, w.deps)
  check("engine: price edits apply to the next offer without code changes", repriced.status === "ok" && repriced.packs[0].usdValueMicros === "4490000")

  // On-chain limits guard: only packs the program can always deliver are sold
  w = makeWorld()
  w.limits.maxDeliveryAmount = B(100_000)
  const capped = await getPaymentOffer(walletUser, null, w.deps)
  check("guard: packs above the on-chain per-delivery limit are not offered", capped.status === "ok" && capped.packs.map((p) => p.id).join() === "devnet-500")
  check("guard: a pack above the limit cannot be quoted, nothing stored", (await createPaymentIntent(walletUser, { packId: "devnet-1500", assetId: "devnet-usdc" }, null, w.deps)).status === "unknown_pack" && w.intents.size === 0)
  w.limits.maxDeliveryAmount = B(1_000_000)
  w.limits.mintWindowCap = B(100_000)
  const windowCapped = await getPaymentOffer(walletUser, null, w.deps)
  check("guard: packs above the newly-minted-per-window cap are not offered", windowCapped.status === "ok" && windowCapped.packs.map((p) => p.id).join() === "devnet-500")
  w.limits.mintWindowCap = B(2_000_000)
  const restored = await getPaymentOffer(walletUser, null, w.deps)
  check("guard: limits are read live — raising them on chain offers the packs again", restored.status === "ok" && restored.packs.length === 2)
  w.limits.paused = true
  const pausedOffer = await getPaymentOffer(walletUser, null, w.deps)
  check("guard: paused program → nothing offered or quoted", pausedOffer.status === "disabled" && pausedOffer.reason === "qlc_paused" && (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, w.deps)).status === "disabled")
  w.limits.paused = false
  w.limits.unreadable = true
  const unreadable = await getPaymentOffer(walletUser, null, w.deps)
  check("guard: limits unreadable → nothing offered (never sell blind)", unreadable.status === "disabled" && unreadable.reason === "qlc_unavailable")
  w.limits.unreadable = false
  const guarded = await quote(w)
  w.limits.maxDeliveryAmount = B(100_000)
  check("guard: no new transaction for an open quote whose pack no longer fits the limits", (await createPaymentTransaction(walletUser, guarded.intent.id, w.deps)).status === "unknown_pack")
  w.limits.maxDeliveryAmount = B(1_000_000)
  w.limits.paused = true
  check("guard: no new transaction while the program is paused", (await createPaymentTransaction(walletUser, guarded.intent.id, w.deps)).status === "disabled")
  w.limits.paused = false

  // Quote validation
  w = makeWorld()
  check("engine: unknown / malformed pack → unknown_pack", (await createPaymentIntent(walletUser, { packId: "devnet-777", assetId: "devnet-usdc" }, null, w.deps)).status === "unknown_pack" && (await createPaymentIntent(walletUser, { packId: { x: 1 }, assetId: "devnet-usdc" }, null, w.deps)).status === "unknown_pack")
  check("engine: unknown / disabled asset → unknown_asset", (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-qlx" }, null, w.deps)).status === "unknown_asset")
  w.assets[1].is_enabled = false
  check("engine: disabling an asset stops new quotes immediately", (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-sol" }, null, w.deps)).status === "unknown_asset")
  w = makeWorld()
  w.chain.genesis = CLUSTER_GENESIS_HASHES["mainnet-beta"]
  check("engine: RPC on another network → refused, nothing stored", (await rejects(() => createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, w.deps), PaymentClusterMismatchError)) && w.intents.size === 0)
  w = makeWorld()
  w.chain.tokenBalances.delete(treasuryUsdc)
  check("engine: treasury token account missing → treasury_not_ready", (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, w.deps)).status === "treasury_not_ready")
  w = makeWorld()
  w.chain.tokenBalances.set(payerUsdc, B(4989999))
  const short = await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, w.deps)
  check("engine: not enough USDC → insufficient_funds with exact amounts", short.status === "insufficient_funds" && short.required === "4990000" && short.available === "4989999" && short.symbol === "USDC" && w.intents.size === 0)
  w = makeWorld()
  w.chain.lamports.set(WALLET, B(0))
  check("engine: no SOL for fees → insufficient_sol", (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, w.deps)).status === "insufficient_sol")
  w = makeWorld()
  w.chain.pyth = pythAccount({ publishTime: NOW_S - 600 })
  check("engine: stale SOL price → price_unavailable, nothing stored", (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-sol" }, null, w.deps)).status === "price_unavailable" && w.intents.size === 0)

  // USDC quote
  w = makeWorld()
  const { result: usdcQuote, intent: usdcIntent } = await quote(w)
  check(
    "engine: USDC quote stores pack, QLC base units, exact USDC, treasury account, price snapshot, reference, 15 min expiry",
    usdcIntent.qlcAmount === B(150000) && usdcIntent.usdValueMicros === B(12990000) && usdcIntent.paymentAmount === B(12990000) && usdcIntent.assetSymbol === "USDC" &&
      usdcIntent.destinationAccount === treasuryUsdc && usdcIntent.treasury === TREASURY && usdcIntent.priceSource === "usd-peg" && usdcIntent.reference === REFERENCES[0] &&
      usdcIntent.expiresAt.getTime() === NOW.getTime() + 900_000 && usdcQuote.intent.paymentAmount === "12990000",
  )
  check("engine: quote returns the transfer built from the stored quote", decodeWire(usdcQuote.transaction).staticAccounts.includes(usdcIntent.reference as never))
  {
    const wire = getTransactionDecoder().decode(getBase64Encoder().encode(usdcQuote.transaction))
    const msg = decodeMessage(wire.messageBytes)
    const keys = msg.staticAccounts
    const signers = keys.slice(0, msg.header.numSignerAccounts)
    const [membershipIx, transferIx] = msg.instructions
    const memberAccounts = (membershipIx?.accountIndices ?? []).map((i) => keys[i])
    const operatorSig = wire.signatures[operatorSigner.address]
    const operatorSigValid = !!operatorSig && (await verifySignature(await getPublicKeyFromAddress(operatorSigner.address), operatorSig, wire.messageBytes))
    check(
      "engine: payment transaction = [register_member, transfer]; the payer pays the fee and signs; the wallet is a signer of register_member",
      msg.instructions.length === 2 && keys[membershipIx.programAddressIndex] === QELARIX_QLC_PROGRAM_ADDRESS && keys[transferIx.programAddressIndex] === TOKEN_PROGRAM &&
        keys[0] === WALLET && signers.length === 2 && signers.includes(WALLET as never) && signers.includes(operatorSigner.address) &&
        memberAccounts.includes(WALLET as never) && memberAccounts.includes(walletMember) && memberAccounts.includes(operatorSigner.address),
    )
    const signedName = "engine: the operator has already signed (valid signature); the payer's signature slot is empty for the wallet"
    if (ownerOperator) check(signedName, operatorSigValid && wire.signatures[WALLET as never] === null)
    else blocked(signedName, missingIdentity("operator"))
  }
  w.packs[1].usd_value_micros = 1
  check("engine: later price edits do not change an issued quote", w.intents.get(usdcIntent.id)!.paymentAmount === B(12990000))

  // SOL quote
  const { result: solQuote, intent: solIntent } = await quote(w, "devnet-sol", "devnet-500")
  {
    const msg = decodeWire(solQuote.transaction)
    check("engine: SOL payments carry the same membership instruction", msg.instructions.length === 2 && msg.staticAccounts[msg.instructions[0].programAddressIndex] === QELARIX_QLC_PROGRAM_ADDRESS && msg.staticAccounts[msg.instructions[1].programAddressIndex] === "11111111111111111111111111111111")
  }
  check(
    "engine: SOL quote locks exact lamports from the verified Pyth price for 2 minutes",
    solIntent.assetKind === "native-sol" && solIntent.paymentAmount === paymentAmountFor(B(4990000), 9, { price: B(12182492516), expo: -8 }) &&
      solIntent.destinationAccount === TREASURY && solIntent.priceSource === `pyth:${SOL_FEED}` && solIntent.priceSnapshot.price === "12182492516" &&
      solIntent.expiresAt.getTime() === NOW.getTime() + 120_000,
  )

  for (let i = 2; i < MAX_OPEN_INTENTS_PER_USER; i++) await quote(w, "devnet-usdc", "devnet-500")
  check("engine: open quote limit per user", (await createPaymentIntent(walletUser, { packId: "devnet-500", assetId: "devnet-usdc" }, null, w.deps)).status === "too_many_open_intents")

  // Transactions for open quotes
  w = makeWorld()
  const open = await quote(w)
  const fresh2 = await createPaymentTransaction(walletUser, open.intent.id, w.deps)
  check("engine: retry builds a new transaction (fresh blockhash) for the same quote", fresh2.status === "ok" && fresh2.transaction !== open.result.transaction)
  check("engine: another user cannot use the quote", (await createPaymentTransaction(otherUser, open.intent.id, w.deps)).status === "unknown_intent")
  w.assets[0].is_enabled = false
  check("engine: an asset disabled after quoting takes no further payments", (await createPaymentTransaction(walletUser, open.intent.id, w.deps)).status === "unknown_asset")
  w.assets[0].is_enabled = true
  const qlcBackup = w.deps.qlc
  w.deps.qlc = null
  check("engine: no transaction while the QLC operator is unavailable (membership cannot be co-signed)", (await createPaymentTransaction(walletUser, open.intent.id, w.deps)).status === "qlc_unavailable")
  w.deps.qlc = qlcBackup
  w.clock.now = new Date(open.intent.expiresAt.getTime())
  check("engine: no new transaction once the quote expired", (await createPaymentTransaction(walletUser, open.intent.id, w.deps)).status === "expired")

  // Confirm USDC: verify → settle → deliver
  w = makeWorld()
  const paid = await quote(w)
  check("engine: malformed signature → invalid_signature", (await confirmPayment(walletUser, paid.intent.id, "nope", w.deps)).status === "invalid_signature")
  check("engine: not finalized yet → pending, nothing delivered", (await confirmPayment(walletUser, paid.intent.id, sig("1"), w.deps)).status === "pending" && w.delivered.length === 0)
  check("engine: another user cannot confirm the quote", (await confirmPayment(otherUser, paid.intent.id, sig("1"), w.deps)).status === "unknown_intent")
  w.chain.txs.set(sig("1"), usdcTxFor(paid.intent))
  const confirmed = await confirmPayment(walletUser, paid.intent.id, sig("1"), w.deps)
  check(
    "engine: verified USDC payment → paid and 1,500.00 QLC delivered once on chain",
    confirmed.status === "paid" && confirmed.delivery.status === "delivered" && confirmed.qlcAmount === "150000" && w.delivered.length === 1 &&
      w.delivered[0].amount === B(150000) && w.delivered[0].wallet === WALLET && w.delivered[0].id === Buffer.from(deliveryIdFor(`payment:${paid.intent.id}`)).toString("hex"),
    JSON.stringify(confirmed),
  )
  const again = await confirmPayment(walletUser, paid.intent.id, sig("1"), w.deps)
  const againNoSig = await confirmPayment(walletUser, paid.intent.id, null, w.deps)
  check("engine: repeated confirm returns the same result, nothing delivered again", again.status === "paid" && againNoSig.status === "paid" && w.delivered.length === 1)
  check("engine: different signature on a paid quote → intent_already_paid", (await confirmPayment(walletUser, paid.intent.id, sig("2"), w.deps)).status === "intent_already_paid")
  const next = await quote(w)
  const replay = await confirmPayment(walletUser, next.intent.id, sig("1"), w.deps)
  check("engine: a transaction cannot pay a second quote", replay.status === "failed" && replay.reason === "reference_missing" && w.delivered.length === 1)

  // Confirm SOL
  w = makeWorld()
  const solPaid = await quote(w, "devnet-sol", "devnet-500")
  w.chain.txs.set(sig("3"), solTxFor(solPaid.intent))
  const solConfirmed = await confirmPayment(walletUser, solPaid.intent.id, sig("3"), w.deps)
  check("engine: verified SOL payment → paid and 500.00 QLC delivered (same pipeline)", solConfirmed.status === "paid" && solConfirmed.delivery.status === "delivered" && w.delivered[0]?.amount === B(50000))

  // Chain mismatches never settle or deliver
  for (const [label, options, reason] of [["wrong mint", { mint: FAKE_MINT }, "wrong_mint"], ["wrong amount", { amount: "12000000" }, "wrong_amount"], ["wrong payer", { payer: OTHER_WALLET }, "payer_not_signer"], ["wrong destination owner", { postOwner: OTHER_WALLET }, "wrong_destination"], ["failed transaction", { err: { InstructionError: [0, "Custom"] } }, "transaction_failed"]] as [string, SplOpts, string][]) {
    const m = makeWorld()
    const q = await quote(m)
    m.chain.txs.set(sig("4"), usdcTxFor(q.intent, options))
    const r = await confirmPayment(walletUser, q.intent.id, sig("4"), m.deps)
    check(`engine: ${label} → failed, nothing settled or delivered`, r.status === "failed" && r.reason === reason && m.deliveries.size === 0 && m.delivered.length === 0)
  }

  // Expiry
  w = makeWorld()
  const late = await quote(w)
  w.clock.now = new Date(late.intent.expiresAt.getTime() + 60_000)
  check("engine: within the settlement grace an unseen payment is still pending", (await confirmPayment(walletUser, late.intent.id, sig("5"), w.deps)).status === "pending")
  w.clock.now = new Date(late.intent.expiresAt.getTime() + SETTLEMENT_GRACE_MS + 1000)
  check("engine: after the grace an unseen payment → expired", (await confirmPayment(walletUser, late.intent.id, sig("5"), w.deps)).status === "expired")
  w.chain.txs.set(sig("5"), usdcTxFor(late.intent, { blockTime: Math.floor(late.intent.expiresAt.getTime() / 1000) + 30 }))
  const landedLate = await confirmPayment(walletUser, late.intent.id, sig("5"), w.deps)
  check("engine: payment that landed after expiry → failed (expired), no QLC", landedLate.status === "failed" && landedLate.reason === "expired" && w.delivered.length === 0)

  // Recovery and transient failures
  w = makeWorld()
  const lost = await quote(w)
  w.chain.txs.set(sig("6"), usdcTxFor(lost.intent, { err: { InstructionError: [0, "Custom"] } }))
  w.chain.txs.set(sig("7"), usdcTxFor(lost.intent))
  w.chain.refs.set(lost.intent.reference, [sig("6"), sig("7")])
  const recovered = await confirmPayment(walletUser, lost.intent.id, null, w.deps)
  check("engine: confirm without signature finds the payment by reference", recovered.status === "paid" && recovered.signature === sig("7") && w.delivered.length === 1)
  w = makeWorld()
  const flaky = await quote(w)
  w.chain.txs.set(sig("8"), usdcTxFor(flaky.intent))
  w.chain.down = true
  check("engine: RPC outage throws, nothing settled", (await rejects(() => confirmPayment(walletUser, flaky.intent.id, sig("8"), w.deps), SolanaRpcError)) && w.deliveries.size === 0)
  w.chain.down = false
  w.qlcDown.value = true
  const paidPending = await confirmPayment(walletUser, flaky.intent.id, sig("8"), w.deps)
  check("engine: payment settles even if QLC delivery is temporarily down; delivery stays pending", paidPending.status === "paid" && paidPending.delivery.status === "pending" && w.deliveries.size === 1 && Array.from(w.deliveries.values())[0].attempts === 1)
  w.qlcDown.value = false
  const retried = await confirmPayment(walletUser, flaky.intent.id, sig("8"), w.deps)
  check("engine: confirming again delivers the pending QLC exactly once", retried.status === "paid" && retried.delivery.status === "delivered" && w.delivered.length === 1)

  // ── Background recovery (no client confirm) ────────────────────────────────
  const recover = async (world: World) => {
    const r = await recoverPayments(world.deps)
    if (r.status !== "ok") throw new Error(`recovery disabled: ${JSON.stringify(r)}`)
    return r
  }
  w = makeWorld()
  const abandoned = await quote(w)
  w.chain.txs.set(sig("r1"), usdcTxFor(abandoned.intent))
  w.chain.refs.set(abandoned.intent.reference, [sig("r1")])
  const run1 = await recover(w)
  check("recovery: a payment the buyer never confirmed is found by reference, settled and its QLC delivered",
    run1.intentsSettled === 1 && run1.deliveriesDelivered === 1 && w.delivered.length === 1 && w.intents.get(abandoned.intent.id)!.status === "paid" && w.delivered[0].amount === B(150000), JSON.stringify(run1))
  const lateConfirm = await confirmPayment(walletUser, abandoned.intent.id, null, w.deps)
  const run2 = await recover(w)
  check("recovery: a later confirm and later runs change nothing (exactly once)",
    lateConfirm.status === "paid" && lateConfirm.delivery.status === "delivered" && run2.intentsChecked === 0 && run2.deliveriesAttempted === 0 && w.delivered.length === 1)

  w = makeWorld()
  const undelivered = await quote(w)
  w.chain.txs.set(sig("r2"), usdcTxFor(undelivered.intent))
  w.qlcDown.value = true
  const paidNotDelivered = await confirmPayment(walletUser, undelivered.intent.id, sig("r2"), w.deps)
  w.qlcDown.value = false
  const tooSoon = await recover(w)
  check("recovery: a failed delivery waits for its backoff (1 minute) before the next attempt",
    paidNotDelivered.status === "paid" && paidNotDelivered.delivery.status === "pending" && tooSoon.deliveriesAttempted === 0 && w.delivered.length === 0)
  w.clock.now = new Date(NOW.getTime() + 61_000)
  const due = await recover(w)
  check("recovery: paid-but-undelivered QLC is delivered by the job once due, without the buyer returning",
    due.deliveriesAttempted === 1 && due.deliveriesDelivered === 1 && w.delivered.length === 1 && Array.from(w.deliveries.values())[0].status === "delivered", JSON.stringify(due))

  w = makeWorld()
  const stuck = await quote(w)
  w.chain.txs.set(sig("r3"), usdcTxFor(stuck.intent))
  w.qlcDown.value = true
  await confirmPayment(walletUser, stuck.intent.id, sig("r3"), w.deps)
  let lastRun = await recover(w)
  for (let n = 1; n < STUCK_DELIVERY_ATTEMPTS; n++) {
    w.clock.now = new Date(w.clock.now.getTime() + 61 * 60_000)
    lastRun = await recover(w)
  }
  const stuckRow = Array.from(w.deliveries.values())[0]
  check(`recovery: a delivery failing ${STUCK_DELIVERY_ATTEMPTS} times is reported as stuck and stays pending (never dropped)`,
    lastRun.stuckDeliveries.length === 1 && lastRun.stuckDeliveries[0].attempts === STUCK_DELIVERY_ATTEMPTS && lastRun.stuckDeliveries[0].error === "operator unavailable" && stuckRow.status === "pending", JSON.stringify(lastRun.stuckDeliveries))
  w.qlcDown.value = false
  w.clock.now = new Date(w.clock.now.getTime() + 61 * 60_000)
  check("recovery: a stuck delivery is delivered once the operator works again", (await recover(w)).deliveriesDelivered === 1 && w.delivered.length === 1)

  w = makeWorld()
  const unpaid = await quote(w)
  const stillOpen = await quote(w, "devnet-usdc", "devnet-500")
  w.clock.now = new Date(unpaid.intent.expiresAt.getTime() + 60_000)
  const inGrace = await recover(w)
  check("recovery: unpaid quotes inside the settlement grace stay open", inGrace.intentsChecked === 2 && inGrace.intentsClosed === 0)
  w.clock.now = new Date(unpaid.intent.expiresAt.getTime() + SETTLEMENT_GRACE_MS + 1000)
  w.intents.get(stillOpen.intent.id)!.expiresAt = new Date(w.clock.now.getTime() + 600_000)
  const closing = await recover(w)
  const afterClose = await recover(w)
  check("recovery: an unpaid quote past the grace is closed as expired and not scanned again; open quotes are kept",
    closing.intentsClosed === 1 && w.intents.get(unpaid.intent.id)!.status === "expired" && w.intents.get(stillOpen.intent.id)!.status === "pending" && afterClose.intentsChecked === 1, JSON.stringify({ closing, afterClose }))
  check("recovery: a closed quote takes no new transaction", (await createPaymentTransaction(walletUser, unpaid.intent.id, w.deps)).status === "expired")
  w.chain.txs.set(sig("r4"), usdcTxFor(unpaid.intent, { blockTime: Math.floor(unpaid.intent.expiresAt.getTime() / 1000) - 10 }))
  const closedButPaid = await confirmPayment(walletUser, unpaid.intent.id, sig("r4"), w.deps)
  check("recovery: a payment that landed before expiry still settles on a closed quote", closedButPaid.status === "paid" && closedButPaid.delivery.status === "delivered" && w.delivered.length === 1)

  // The quote comes from another world, so this world's RPC has never passed the genesis check.
  const quotedElsewhere = await quote(makeWorld())
  w = makeWorld()
  w.intents.set(quotedElsewhere.intent.id, { ...quotedElsewhere.intent })
  w.chain.txs.set(sig("r5"), usdcTxFor(quotedElsewhere.intent))
  w.chain.refs.set(quotedElsewhere.intent.reference, [sig("r5")])
  w.chain.genesis = CLUSTER_GENESIS_HASHES["mainnet-beta"]
  check("recovery: RPC on another network → refused before anything is settled",
    (await rejects(() => recoverPayments(w.deps), PaymentClusterMismatchError)) && w.deliveries.size === 0 && w.intents.get(quotedElsewhere.intent.id)!.status === "pending")
  check("recovery: disabled deployment does nothing", (await recoverPayments(makeWorld({ env: { NEXT_PUBLIC_SOLANA_CLUSTER: "mainnet-beta" } }).deps)).status === "disabled")

  // ── Delivery queue ─────────────────────────────────────────────────────────
  const receipts = new Set<string>()
  let sends = 0
  const fakeQlc: QlcDeliverer = {
    async deliver({ deliveryId }) {
      const key = Buffer.from(deliveryId).toString("hex")
      if (receipts.has(key)) return { status: "already_delivered", fromVault: B(100), minted: B(0) }
      receipts.add(key)
      sends++
      return { status: "delivered", signature: sig("dq"), fromVault: B(100), minted: B(0) }
    },
  }
  const marks: string[] = []
  const deliveryStore = { async markDelivered(id: string) { marks.push(id) }, async recordAttempt() {} }
  const record: QlcDeliveryRecord = { id: "d1", deliveryKey: "leaderboard:2026-10:1", walletAddress: WALLET, qlcAmount: B(100), kind: "reward", status: "pending", txSignature: null, fromVault: null, minted: null, attempts: 0, lastError: null }
  const first = await processDelivery(record, { qlc: fakeQlc, store: deliveryStore })
  const second = await processDelivery(record, { qlc: fakeQlc, store: deliveryStore })
  check("deliveries: the same key is executed on chain at most once (receipt), retries are recognised", first.status === "delivered" && second.status === "delivered" && sends === 1 && marks.length === 2)
  check("deliveries: delivery id is sha256 of the key", Buffer.from(deliveryIdFor("payment:abc")).toString("hex") === createHash("sha256").update("payment:abc").digest("hex"))
  const noQlc = await processDelivery({ ...record, id: "d2" }, { qlc: null, store: deliveryStore })
  check("deliveries: without a configured QLC operator a delivery stays pending", noQlc.status === "pending" && noQlc.error === "qlc_not_configured")
  const attempts: string[] = []
  for (const status of ["not_member", "member_suspended"] as const) {
    const refusing: QlcDeliverer = { async deliver() { return { status } } }
    const outcome = await processDelivery({ ...record, id: `d-${status}` }, { qlc: refusing, store: { async markDelivered() { throw new Error("must not mark") }, async recordAttempt(_id, error) { attempts.push(error) } } })
    check(`deliveries: ${status.replace("_", " ")} → nothing sent, stays pending with the reason recorded`, outcome.status === "pending" && outcome.error === status && attempts.at(-1) === status)
  }

  // ── Supabase store adapter ─────────────────────────────────────────────────
  const calls: { op: string; table?: string; args: unknown[] }[] = []
  const row = { id: "00000000-0000-4000-8000-000000000009", user_id: USER_ID, wallet_address: WALLET, cluster: "devnet", pack_id: "devnet-500", offer: null, qlc_amount: 50000, usd_value_micros: 4990000, payment_asset_id: "devnet-usdc", payment_asset_symbol: "USDC", payment_asset_kind: "spl-token", payment_mint: USDC, payment_token_program: TOKEN_PROGRAM, payment_decimals: 6, payment_amount: 4990000, treasury_address: TREASURY, destination_account: treasuryUsdc, price_source: "usd-peg", price_snapshot: { price: "1" }, quoted_at: NOW.toISOString(), expires_at: "2026-10-02T12:15:00Z", reference: REFERENCES[0], status: "pending", tx_signature: null, delivery_id: null }
  const deliveryRow = { id: "d9", delivery_key: `payment:${row.id}`, wallet_address: WALLET, qlc_amount: "50000", kind: "purchase", status: "pending", tx_signature: null, from_vault: null, minted: null, attempts: 2, last_error: "rpc timeout" }
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "gt", "lt", "or", "order", "limit", "insert", "update"]) b[m] = (...args: unknown[]) => { calls.push({ op: m, table, args }); return b }
    b.single = async () => ({ data: row, error: null })
    b.maybeSingle = async () => ({ data: row, error: null })
    b.then = (resolve: (v: unknown) => void) => resolve({ data: [table === "qlc_deliveries" ? deliveryRow : row], count: 3, error: null })
    return b
  }
  const client = { from: (t: string) => builder(t), rpc: async (name: string, params: unknown) => { calls.push({ op: "rpc", args: [name, params] }); return { data: { status: "paid", deliveryId: "x" }, error: null } } } as unknown as SupabaseClient
  const store = createSupabasePaymentStore(client)
  await store.listPaymentAssets("devnet")
  check("store: payment assets filtered by cluster and enabled flag", calls.some((c) => c.table === "payment_assets" && c.op === "eq" && c.args.join() === "is_enabled,true"))
  calls.length = 0
  const created = await store.createIntent({ userId: USER_ID, walletAddress: WALLET, cluster: "devnet", packId: "devnet-500", offer: null, qlcAmount: B(50000), usdValueMicros: B(4990000), assetId: "devnet-usdc", assetSymbol: "USDC", assetKind: "spl-token", mint: USDC, tokenProgram: TOKEN_PROGRAM, decimals: 6, paymentAmount: B(4990000), treasury: TREASURY, destinationAccount: treasuryUsdc, priceSource: "usd-peg", priceSnapshot: { price: "1" }, quotedAt: NOW, expiresAt: new Date("2026-10-02T12:15:00Z"), reference: REFERENCES[0] })
  const inserted = calls.find((c) => c.op === "insert")?.args[0] as Record<string, unknown> | undefined
  check("store: intent insert sends base units as strings; rows map back to bigint", inserted?.payment_amount === "4990000" && inserted?.qlc_amount === "50000" && created.paymentAmount === B(4990000) && created.qlcAmount === B(50000))
  calls.length = 0
  await store.settle(created, USER_ID, { signature: sig("1"), payer: WALLET, treasury: TREASURY, destinationAccount: treasuryUsdc, mint: USDC, amount: B(4990000), reference: REFERENCES[0], slot: 7, blockTime: NOW })
  const settleCall = calls.find((c) => c.op === "rpc")
  const params = settleCall?.args[1] as Record<string, unknown> | undefined
  check("store: settlement only through settle_payment_intent with verified values", settleCall?.args[0] === "settle_payment_intent" && params?.p_payment_amount === "4990000" && params?.p_payment_mint === USDC && params?.p_tx_block_time === NOW.toISOString())
  calls.length = 0
  await store.recordAttempt("d1", "boom")
  check("store: failed delivery attempts go through record_qlc_delivery_attempt", calls.some((c) => c.op === "rpc" && c.args[0] === "record_qlc_delivery_attempt"))
  calls.length = 0
  await store.listPendingIntents("devnet", 25)
  check("store: recovery lists only pending quotes of the cluster, oldest first, bounded",
    calls.some((c) => c.op === "eq" && c.args.join() === "status,pending") && calls.some((c) => c.op === "eq" && c.args.join() === "cluster,devnet") && calls.some((c) => c.op === "order" && c.args[0] === "quoted_at") && calls.some((c) => c.op === "limit" && c.args[0] === 25))
  calls.length = 0
  const cutoffDate = new Date(NOW.getTime() - SETTLEMENT_GRACE_MS)
  const closedOne = await store.closeExpiredIntent(row.id, cutoffDate)
  check("store: closing a quote is conditional on pending + expired before the cutoff",
    closedOne && calls.some((c) => c.op === "update" && (c.args[0] as Record<string, unknown>).status === "expired") && calls.some((c) => c.op === "eq" && c.args.join() === "status,pending") && calls.some((c) => c.op === "lt" && c.args.join() === `expires_at,${cutoffDate.toISOString()}`))
  calls.length = 0
  const dueRows = await store.listDueDeliveries("devnet", 10)
  check("store: recovery lists pending deliveries whose retry time has come",
    dueRows[0]?.qlcAmount === B(50000) && dueRows[0]?.attempts === 2 && calls.some((c) => c.table === "qlc_deliveries" && c.op === "eq" && c.args.join() === "status,pending") && calls.some((c) => c.op === "or" && String(c.args[0]).startsWith("next_attempt_at.is.null,next_attempt_at.lte.")) && calls.some((c) => c.op === "limit" && c.args[0] === 10))

  // ── Cron authorization ─────────────────────────────────────────────────────
  const SECRET = "s".repeat(40)
  check("cron: no secret or a short secret → the job refuses to run", checkCronAuthorization(`Bearer `, undefined) === "not_configured" && checkCronAuthorization("Bearer short", "short") === "not_configured")
  check("cron: wrong or missing bearer → unauthorized", checkCronAuthorization(null, SECRET) === "unauthorized" && checkCronAuthorization(`Bearer ${SECRET}x`, SECRET) === "unauthorized" && checkCronAuthorization(SECRET, SECRET) === "unauthorized")
  check("cron: exact bearer → ok", checkCronAuthorization(`Bearer ${SECRET}`, SECRET) === "ok")

  // ── Routes require a signed-in user ────────────────────────────────────────
  process.env.NEXTAUTH_SECRET ??= "offline-check-secret"
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://supabase.test"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key"
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key"
  const routes = await Promise.all([
    import("../src/app/api/payments/offer/route"),
    import("../src/app/api/payments/intents/route"),
    import("../src/app/api/payments/intents/[intentId]/transaction/route"),
    import("../src/app/api/payments/intents/[intentId]/confirm/route"),
    import("../src/app/api/qlc/balance/route"),
    import("../src/app/api/cron/qlc-payments/route"),
  ])
  const anon = (path: string, method = "POST") => new NextRequest(`http://localhost${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) })
  const statuses = [
    (await routes[0].GET(anon("/api/payments/offer", "GET"))).status,
    (await routes[1].POST(anon("/api/payments/intents"))).status,
    (await routes[2].POST(anon("/api/payments/intents/x/transaction"), { params: { intentId: "x" } })).status,
    (await routes[3].POST(anon("/api/payments/intents/x/confirm"), { params: { intentId: "x" } })).status,
    (await routes[4].GET(anon("/api/qlc/balance", "GET"))).status,
  ]
  check("routes: every payment and QLC endpoint returns 401 without a session", statuses.every((s) => s === 401), statuses.join())
  const cronGet = (auth?: string) => routes[5].GET(new NextRequest("http://localhost/api/cron/qlc-payments", { headers: auth ? { authorization: auth } : {} }))
  const savedSecret = process.env.CRON_SECRET
  delete process.env.CRON_SECRET
  const cronUnset = (await cronGet("Bearer ")).status
  process.env.CRON_SECRET = SECRET
  const cronStatuses = [(await cronGet()).status, (await cronGet(`Bearer ${SECRET.slice(1)}`)).status]
  if (savedSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedSecret
  check("routes: recovery cron refuses without CRON_SECRET (503) and without the exact bearer (401)", cronUnset === 503 && cronStatuses.every((s) => s === 401), [cronUnset, ...cronStatuses].join())

  if (blockedChecks) console.log(`\n${blockedChecks} CHECK(S) BLOCKED: owner test identities missing`)
  console.log(failures === 0 ? (blockedChecks ? "\nALL RUNNABLE CHECKS PASSED" : "\nALL CHECKS PASSED") : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 && blockedChecks === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
