// End-to-end purchase through the real payment engine and QLC program on a LOCAL validator (never
// devnet/mainnet): quote → payer co-signs the server-built [register_member, transfer] transaction
// (already signed by the operator) → finalized verification → settlement → on-chain QLC delivery,
// for an SPL token (USDC-like, 1 token = 1 USD) and native SOL. Also: a failed payment creates no
// membership, and the recovery job settles and delivers payments nobody confirmed and deliveries
// that failed. The database is an in-memory store with the same settlement and backoff rules
// (scripts/payments-db-check.mjs covers the real SQL). Run after the localnet setup (scripts/qlc-setup.ts create-mint, then initialize; --cluster localnet --execute).
//
//   npx tsx scripts/payments-local-e2e.ts --funder <keypair.json> --operator <operator keypair.json> --mint <QLC mint>
//
// The treasury, the member wallets and the local USD mint are the owner's test identities treasury,
// wallet-1, wallet-2 and usd-mint (scripts/test-identities.ts).
import { readFileSync } from "node:fs"
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit"
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system"
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022"
import type { AuthUser } from "../src/lib/authSession"
import { createSolanaRpcCall } from "../src/lib/solanaRpc"
import { createQlcOperator } from "../src/lib/qlc/qlcOperator"
import { TOKEN_PROGRAM, type PaymentAssetRow } from "../src/lib/payments/paymentAssets"
import { createPaymentReference } from "../src/lib/payments/paymentReference"
import type { PricePackRow } from "../src/lib/payments/qlcPricing"
import type { QlcDeliveryRecord } from "../src/lib/payments/qlcDeliveries"
import { confirmPayment, createPaymentIntent, getPaymentOffer, type PaymentEngineDeps, type PaymentIntent, type PaymentStore, type QlcPaymentOperator, type SettleOutcome } from "../src/lib/payments/paymentEngine"
import { recoverPayments } from "../src/lib/payments/paymentRecovery"
import { requireTestSigner } from "./test-identities"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
const option = (name: string) => process.argv[process.argv.indexOf(`--${name}`) + 1]
const B = (value: number | string) => BigInt(value)
const keypair = (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))))

async function main() {
  const http = "http://127.0.0.1:8899"
  const rpc = createSolanaRpc(http)
  const rpcSubscriptions = createSolanaRpcSubscriptions("ws://127.0.0.1:8900")
  const genesis = await rpc.getGenesisHash().send()
  if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesis)) throw new Error("Refusing: local validator only")
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })
  async function sendAs(signer: TransactionSigner, instructions: Parameters<typeof appendTransactionMessageInstructions>[0]) {
    const { value: blockhash } = await rpc.getLatestBlockhash().send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const signed = await signTransactionMessageWithSigners(message)
    assertIsTransactionWithBlockhashLifetime(signed)
    await sendAndConfirm(signed, { commitment: "confirmed" })
  }

  const funder = await keypair(option("funder"))
  const operator = await keypair(option("operator"))
  const qlcMint = address(option("mint"))
  const treasury = await requireTestSigner("treasury")
  const alice = await requireTestSigner("wallet-1")
  const carol = await requireTestSigner("wallet-2")
  await sendAs(funder, [
    getTransferSolInstruction({ source: funder, destination: operator.address, amount: B(5_000_000_000) }),
    getTransferSolInstruction({ source: funder, destination: alice.address, amount: B(20_000_000_000) }),
    getTransferSolInstruction({ source: funder, destination: carol.address, amount: B(1_000_000_000) }),
    getTransferSolInstruction({ source: funder, destination: treasury.address, amount: B(1_000_000_000) }),
  ])

  // A local USDC-like token (SPL Token program, 6 decimals); alice holds 100, the treasury account exists.
  const usd = await requireTestSigner("usd-mint")
  const space = getMintSize()
  await sendAs(funder, [
    getCreateAccountInstruction({ payer: funder, newAccount: usd, lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send(), space, programAddress: address(TOKEN_PROGRAM) }),
    getInitializeMint2Instruction({ mint: usd.address, decimals: 6, mintAuthority: funder.address }, { programAddress: address(TOKEN_PROGRAM) }),
  ])
  const [aliceUsd] = await findAssociatedTokenPda({ owner: alice.address, mint: usd.address, tokenProgram: address(TOKEN_PROGRAM) })
  const [treasuryUsd] = await findAssociatedTokenPda({ owner: treasury.address, mint: usd.address, tokenProgram: address(TOKEN_PROGRAM) })
  const [carolUsd] = await findAssociatedTokenPda({ owner: carol.address, mint: usd.address, tokenProgram: address(TOKEN_PROGRAM) })
  await sendAs(funder, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: funder, ata: aliceUsd, owner: alice.address, mint: usd.address, tokenProgram: address(TOKEN_PROGRAM) }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: funder, ata: treasuryUsd, owner: treasury.address, mint: usd.address, tokenProgram: address(TOKEN_PROGRAM) }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: funder, ata: carolUsd, owner: carol.address, mint: usd.address, tokenProgram: address(TOKEN_PROGRAM) }),
    getMintToCheckedInstruction({ mint: usd.address, token: aliceUsd, mintAuthority: funder, amount: B(100_000_000), decimals: 6 }, { programAddress: address(TOKEN_PROGRAM) }),
    getMintToCheckedInstruction({ mint: usd.address, token: carolUsd, mintAuthority: funder, amount: B(10_000_000), decimals: 6 }, { programAddress: address(TOKEN_PROGRAM) }),
  ])

  // Engine wiring: real chain + real QLC operator; in-memory store with the settlement rules.
  const qlc = createQlcOperator({ rpc, rpcSubscriptions, operator, mint: qlcMint })
  await qlc.selfCheck()
  const assets: PaymentAssetRow[] = [
    { id: "local-usd", cluster: "devnet", symbol: "USDL", kind: "spl-token", mint: usd.address, token_program: TOKEN_PROGRAM, decimals: 6, treasury_address: treasury.address, price_source: { kind: "usd-peg" }, quote_ttl_secs: 900, is_enabled: true, approved_by: "local", approved_at: "2026-10-02T00:00:00Z", sort_order: 10 },
    { id: "local-sol", cluster: "devnet", symbol: "SOL", kind: "native-sol", mint: null, token_program: null, decimals: 9, treasury_address: treasury.address, price_source: { kind: "usd-peg" }, quote_ttl_secs: 900, is_enabled: true, approved_by: "local", approved_at: "2026-10-02T00:00:00Z", sort_order: 20 },
  ]
  const packs: PricePackRow[] = [{ id: "pack-500", cluster: "devnet", qlc_amount: 50000, usd_value_micros: 4990000, list_usd_value_micros: null, label: "Starter Pack", badge: null, highlighted: false, region: null, replaces_pack_id: null, offer: null, sort_order: 10, is_active: true, starts_at: null, ends_at: null }]
  const intents = new Map<string, PaymentIntent>()
  const deliveries = new Map<string, QlcDeliveryRecord & { nextAttemptAt: Date | null }>()
  // Simulated time skip for the recovery job's backoff (the chain keeps real time).
  let skipMs = 0
  const now = () => new Date(Date.now() + skipMs)
  let seq = 0
  const store: PaymentStore = {
    async listPricePacks() { return packs },
    async listPaymentAssets() { return assets },
    async countOpenIntents() { return 0 },
    async createIntent(input) { const i: PaymentIntent = { ...input, id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, status: "pending", txSignature: null, deliveryId: null }; intents.set(i.id, i); return { ...i } },
    async getIntent(id) { const i = intents.get(id); return i ? { ...i } : null },
    async getDelivery(id) { const d = deliveries.get(id); return d ? { ...d } : null },
    async markDelivered(id, r) { Object.assign(deliveries.get(id)!, { status: "delivered", txSignature: r.signature, fromVault: r.fromVault, minted: r.minted }) },
    async recordAttempt(id, error) {
      const d = deliveries.get(id)!
      if (d.status !== "pending") return
      d.nextAttemptAt = new Date(now().getTime() + Math.min(2 ** Math.min(d.attempts, 6), 60) * 60_000)
      d.attempts++
      d.lastError = error
    },
    async listPendingIntents(_cluster, limit) { return Array.from(intents.values()).filter((i) => i.status === "pending").slice(0, limit).map((i) => ({ ...i })) },
    async closeExpiredIntent(id, cutoff) { const i = intents.get(id)!; if (i.status !== "pending" || !(i.expiresAt < cutoff)) return false; i.status = "expired"; return true },
    async listDueDeliveries(_cluster, limit) {
      return Array.from(deliveries.values()).filter((d) => d.status === "pending" && (d.nextAttemptAt === null || d.nextAttemptAt <= now())).slice(0, limit).map((d) => ({ ...d }))
    },
    async settle(intent, userId, p): Promise<SettleOutcome> {
      const i = intents.get(intent.id)!
      if (i.userId !== userId) return { status: "unknown_intent" }
      if (i.status === "paid") return i.txSignature === p.signature ? { status: "already_paid", deliveryId: i.deliveryId!, signature: p.signature } : { status: "intent_already_paid" }
      if (i.walletAddress !== p.payer || i.mint !== p.mint || i.destinationAccount !== p.destinationAccount || i.paymentAmount !== p.amount || i.reference !== p.reference) return { status: "amount_mismatch" }
      const deliveryId = `d-${i.id}`
      deliveries.set(deliveryId, { id: deliveryId, deliveryKey: `payment:local:${Date.now()}:${i.id}`, walletAddress: i.walletAddress, qlcAmount: i.qlcAmount, kind: "purchase", status: "pending", txSignature: null, fromVault: null, minted: null, attempts: 0, lastError: null, nextAttemptAt: null })
      Object.assign(i, { status: "paid", txSignature: p.signature, deliveryId })
      return { status: "paid", deliveryId, signature: p.signature }
    },
  }
  // The real operator; `operatorDown` makes deliveries fail as if the operator RPC were unavailable.
  let operatorDown = false
  const deliverer: QlcPaymentOperator = {
    membershipInstruction: (wallet) => qlc.membershipInstruction(wallet),
    limits: () => qlc.limits(),
    deliver: (input) => (operatorDown ? Promise.reject(new Error("operator unavailable")) : qlc.deliver(input)),
  }
  const deps: PaymentEngineDeps = {
    deployment: { enabled: true as const, deployment: { cluster: "devnet" as const, chain: "solana:devnet" as const, rpcUrl: http, genesisHash: genesis } },
    store,
    rpc: createSolanaRpcCall(http),
    qlc: deliverer,
    now,
    newReference: createPaymentReference,
  }
  const user: AuthUser = { id: "7a000000-0000-4000-8000-000000000001", email: null, plan: null, walletAddress: alice.address }
  const carolUser: AuthUser = { id: "7a000000-0000-4000-8000-000000000002", email: null, plan: null, walletAddress: carol.address }

  const offer = await getPaymentOffer(user, null, deps)
  check("offer lists the pack and both payment assets", offer.status === "ok" && offer.assets.map((a) => a.symbol).join() === "USDL,SOL")

  const [aliceQlc] = await findAssociatedTokenPda({ owner: alice.address, mint: qlcMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const qlcBalance = async () => {
    const account = await fetchToken(rpc, aliceQlc).catch(() => null)
    return account ? account.data.amount : B(0)
  }

  /** Quote, then the payer's wallet co-signs exactly the server-built (operator-signed) transaction and sends it. */
  async function payWith(assetId: string, payer: KeyPairSigner, buyer: AuthUser, sendOptions: { skipPreflight?: boolean } = {}) {
    const created = await createPaymentIntent(buyer, { packId: "pack-500", assetId }, null, deps)
    if (created.status !== "ok") throw new Error(`quote failed: ${JSON.stringify(created)}`)
    const partiallySigned = getTransactionDecoder().decode(getBase64Encoder().encode(created.transaction))
    const signed = await signTransaction([payer.keyPair], partiallySigned)
    const signature = getSignatureFromTransaction(signed)
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", ...sendOptions }).send()
    return { created, signature, signers: Object.keys(partiallySigned.signatures), operatorSigned: partiallySigned.signatures[operator.address] !== null }
  }
  async function untilFinalized(signature: string) {
    for (let i = 0; i < 90; i++) {
      const { value } = await rpc.getSignatureStatuses([signature as never]).send()
      if (value[0]?.confirmationStatus === "finalized") return value[0]
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error("transaction did not finalize in time")
  }
  async function buyWith(assetId: string, payer: KeyPairSigner) {
    const paid = await payWith(assetId, payer, user)
    for (let i = 0; i < 90; i++) {
      const result = await confirmPayment(user, paid.created.intent.id, paid.signature, deps)
      if (result.status !== "pending") return { ...paid, result }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error("payment did not finalize in time")
  }
  const operatorLamports = async () => BigInt((await rpc.getBalance(operator.address).send()).value)

  // A payment that fails on chain creates no membership: the transaction is all-or-nothing.
  const carolQuote = await createPaymentIntent(carolUser, { packId: "pack-500", assetId: "local-usd" }, null, deps)
  if (carolQuote.status !== "ok") throw new Error(`quote failed: ${JSON.stringify(carolQuote)}`)
  const operatorBeforeFailed = await operatorLamports()
  await sendAs(carol, [getTransferCheckedInstruction({ source: carolUsd, mint: usd.address, destination: aliceUsd, authority: carol, amount: B(10_000_000), decimals: 6 }, { programAddress: address(TOKEN_PROGRAM) })])
  const carolSigned = await signTransaction([carol.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(carolQuote.transaction)))
  const carolSig = getSignatureFromTransaction(carolSigned)
  await rpc.sendTransaction(getBase64EncodedWireTransaction(carolSigned), { encoding: "base64", skipPreflight: true }).send()
  const carolStatus = await untilFinalized(carolSig)
  const carolResult = await confirmPayment(carolUser, carolQuote.intent.id, carolSig, deps)
  check(
    "failed payment (payer lacks funds): transaction fails, no membership created, operator pays no rent, nothing settled",
    carolStatus.err !== null && !(await qlc.isMember(carol.address)) && (await operatorLamports()) === operatorBeforeFailed && carolResult.status === "failed" && deliveries.size === 0,
    JSON.stringify({ result: carolResult }),
  )

  const before = await qlcBalance()
  const operatorBeforeJoin = await operatorLamports()
  check("buyer starts as a non-member", !(await qlc.isMember(alice.address)))
  const usdPurchase = await buyWith("local-usd", alice)
  const afterUsd = await qlcBalance()
  const treasuryUsdBalance = (await rpc.getTokenAccountBalance(treasuryUsd).send()).value.amount
  check(
    "SPL purchase: exact 4.99 USDL paid to the treasury, payment finalized and verified, 500.00 QLC delivered on chain",
    usdPurchase.result.status === "paid" && usdPurchase.result.delivery.status === "delivered" && afterUsd - before === B(50000) && treasuryUsdBalance === "4990000",
    JSON.stringify({ result: usdPurchase.result, qlc: (afterUsd - before).toString() }),
  )
  check(
    "first purchase joins the buyer in the same transaction: wallet + operator signed, operator paid the member rent",
    usdPurchase.signers.length === 2 && usdPurchase.signers.includes(alice.address) && usdPurchase.operatorSigned && (await qlc.isMember(alice.address)) && (await operatorLamports()) < operatorBeforeJoin,
  )
  const repeat = await confirmPayment(user, usdPurchase.created.intent.id, usdPurchase.signature, deps)
  check("repeated confirm returns paid and delivers nothing more", repeat.status === "paid" && (await qlcBalance()) === afterUsd)

  const treasuryLamportsBefore = BigInt((await rpc.getBalance(treasury.address).send()).value)
  const solPurchase = await buyWith("local-sol", alice)
  const afterSol = await qlcBalance()
  const treasuryLamportsAfter = BigInt((await rpc.getBalance(treasury.address).send()).value)
  check(
    "SOL purchase: exact lamports to the treasury, verified, 500.00 QLC delivered through the same pipeline",
    solPurchase.result.status === "paid" && solPurchase.result.delivery.status === "delivered" && afterSol - afterUsd === B(50000) &&
      treasuryLamportsAfter - treasuryLamportsBefore === BigInt(solPurchase.created.intent.paymentAmount),
    JSON.stringify({ lamports: solPurchase.created.intent.paymentAmount }),
  )

  // Recovery: the buyer pays and closes the tab; nobody calls confirm.
  const abandoned = await payWith("local-usd", alice, user)
  await untilFinalized(abandoned.signature)
  const recovered = await recoverPayments(deps)
  const afterRecovery = await qlcBalance()
  check(
    "recovery job: an unconfirmed payment is found on chain, settled and its 500.00 QLC delivered without the client",
    recovered.status === "ok" && recovered.intentsSettled === 1 && recovered.deliveriesDelivered === 1 && afterRecovery - afterSol === B(50000) && intents.get(abandoned.created.intent.id)!.status === "paid",
    JSON.stringify(recovered),
  )
  const abandonedTx = await rpc.getTransaction(abandoned.signature as never, { commitment: "finalized", maxSupportedTransactionVersion: 0, encoding: "json" }).send()
  const keys: string[] = [...(abandonedTx?.transaction.message.accountKeys ?? [])]
  const operatorIndex = keys.indexOf(operator.address)
  const operatorDelta = operatorIndex < 0 ? null : BigInt(abandonedTx!.meta!.postBalances[operatorIndex]) - BigInt(abandonedTx!.meta!.preBalances[operatorIndex])
  check("membership instruction is idempotent for an existing member: the operator's balance is unchanged by the payment", operatorDelta === BigInt(0), String(operatorDelta))

  // Recovery: paid, settled, but the delivery failed and the buyer never returns.
  const failing = await payWith("local-usd", alice, user)
  operatorDown = true
  let pendingDelivery
  for (let i = 0; i < 90 && !pendingDelivery; i++) {
    const r = await confirmPayment(user, failing.created.intent.id, failing.signature, deps)
    if (r.status !== "pending") pendingDelivery = r
    else await new Promise((res) => setTimeout(res, 1000))
  }
  operatorDown = false
  const notYet = await recoverPayments(deps)
  skipMs = 61_000
  const retried = await recoverPayments(deps)
  check(
    "recovery job: a paid-but-undelivered purchase waits for its backoff, then is delivered exactly once",
    pendingDelivery?.status === "paid" && pendingDelivery.delivery.status === "pending" && notYet.status === "ok" && notYet.deliveriesAttempted === 0 &&
      retried.status === "ok" && retried.deliveriesDelivered === 1 && (await qlcBalance()) - afterRecovery === B(50000),
    JSON.stringify({ notYet, retried }),
  )
  const again = await recoverPayments(deps)
  check("recovery job: later runs deliver nothing more", again.status === "ok" && again.deliveriesAttempted === 0 && again.intentsSettled === 0 && (await qlcBalance()) - afterRecovery === B(50000))

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
