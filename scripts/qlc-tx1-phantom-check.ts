// Offline checks for the owner-run Phantom + mint-keypair TX1 path (scripts/qlc-tx1-phantom.ts, qlc-setup
// --payer-wallet phantom). No network beyond a local 127.0.0.1 test server, nothing sent, no key generated: real
// signatures come from the owner's test-only identities (QLC_TEST_IDENTITIES_DIR) standing in for the Phantom payer
// (wallet-1) and the mint identity (mint); wallet-2 and wallet-3 play the wrong wallet and the wrong mint key.
//
//   QLC_TEST_IDENTITIES_DIR=<owner test identities folder> npm run check:qlc-tx1-phantom
import { request } from "node:http"
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  getPublicKeyFromAddress,
  signBytes,
  verifySignature,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit"
import { findMembershipAuthorityPda, findMintAuthorityPda } from "../src/lib/qlc/generated"
import { findNoBurnAuthority } from "../src/lib/qlc/qlcProgram"
import { DEVNET_SETUP, assertCluster } from "./qlc-policy"
import { createMintInstructions, mintSizes, parseArgs } from "./qlc-setup"
import {
  decodeStrictBase64,
  messageHash,
  mintCoSign,
  ownerPage,
  sameExceptBlockhash,
  startOwnerSigningServer,
  verifyTx1Transaction,
  type PreparedTx1,
  type Tx1Expectation,
} from "./qlc-tx1-phantom"
import { requireTestSigner } from "./test-identities"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
const refused = (name: string, problems: string[], fragment: string) =>
  check(`refuses: ${name}`, problems.some((p) => p.includes(fragment)), problems.length ? problems.join("; ") : "accepted")
async function throwsWith(name: string, run: () => Promise<unknown>, fragment: string) {
  try {
    await run()
    check(`refuses: ${name}`, false, "did not throw")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    check(`refuses: ${name}`, message.includes(fragment), message.slice(0, 160))
  }
}
const SYSTEM = address("11111111111111111111111111111111")
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111")
// Any valid 32-byte base58 values work as placeholder blockhashes.
const BH1 = blockhash("EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa")
const BH2 = blockhash("DfoWpNfC1jCfQEpAYnvqHJ3Z8dcYXEopMZYQioaq1FuZ")

async function main() {
  const payerWallet = await requireTestSigner("wallet-1") // stands in for the Phantom Deploy_Fee_Payer
  const mintKey = await requireTestSigner("mint") // stands in for the owner's mint identity
  const wrongWallet = await requireTestSigner("wallet-2")
  const wrongMintKey = await requireTestSigner("wallet-3")
  const admin = address(DEVNET_SETUP.admin)
  const [[mintAuthority], [freezeAuthority], noBurnAuthority] = await Promise.all([findMintAuthorityPda(), findMembershipAuthorityPda(), findNoBurnAuthority()])
  const { space } = mintSizes(admin, mintKey.address, noBurnAuthority)

  // The same build as scripts/qlc-setup.ts (legacy message, fee payer = payer, createMintInstructions with noop signers).
  const tx1 = (payer: Address, mint: Address, bh = BH1, extra: Instruction[] = []) => {
    const payerNoop = createNoopSigner(payer)
    const instructions = createMintInstructions({ payer: payerNoop, mint: createNoopSigner(mint), admin, mintAuthority, freezeAuthority, noBurnAuthority, lamports: BigInt(3_271_520), space })
    return compileTransaction(
      pipe(
        createTransactionMessage({ version: "legacy" }),
        (m) => setTransactionMessageFeePayerSigner(payerNoop, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh, lastValidBlockHeight: BigInt(0) }, m),
        (m) => appendTransactionMessageInstructions([...extra, ...instructions], m),
      ),
    )
  }
  const expectationFor = (unsigned: Transaction): Tx1Expectation => ({ messageBytes: new Uint8Array(unsigned.messageBytes), payer: payerWallet.address, mint: mintKey.address })
  const decode = (wire: Uint8Array) => getTransactionDecoder().decode(wire)
  const encode = (transaction: Transaction) => new Uint8Array(getTransactionEncoder().encode(transaction))
  /** What Phantom does for a partially signed transaction: sign the exact message bytes as the payer. */
  const walletSigns = async (wire: Uint8Array, wallet: KeyPairSigner) => encode(await partiallySignTransaction([wallet.keyPair], decode(wire)))

  console.log("— canonical TX1 (same reviewed policy as Step 06)")
  const unsigned = tx1(payerWallet.address, mintKey.address)
  const expected = expectationFor(unsigned)
  const message = decode(encode(unsigned))
  check("signer slots are exactly [payer, mint]", JSON.stringify(Object.keys(message.signatures)) === JSON.stringify([payerWallet.address, mintKey.address]))
  check("unsigned TX1 carries no signature", Object.values(message.signatures).every((s) => s === null))
  check("message hash is base58(sha256(message))", messageHash(expected.messageBytes).length >= 43)

  console.log("— happy path: mint co-signs first, then the payer wallet signs the same message")
  const partial = await mintCoSign(unsigned, expected, mintKey)
  check("mint co-signature verifies; payer slot still empty", (await verifyTx1Transaction(partial, expected, { payer: false, mint: true })).length === 0 && decode(partial).signatures[payerWallet.address] === null)
  const full = await walletSigns(partial, payerWallet)
  const fullProblems = await verifyTx1Transaction(full, expected, { payer: true, mint: true })
  check("correct payer + correct mint signer: accepted (message unchanged, both signatures valid)", fullProblems.length === 0, fullProblems.join("; "))

  console.log("— wrong wallet / wrong key / wrong payer")
  await throwsWith("wrong Phantom wallet cannot sign a TX1 whose payer it is not", () => walletSigns(partial, wrongWallet), "")
  const forged = decode(partial)
  const forgedSignature = await signBytes(wrongWallet.keyPair.privateKey, expected.messageBytes)
  refused("wrong wallet's signature placed in the payer slot", await verifyTx1Transaction(encode({ ...forged, signatures: { ...forged.signatures, [payerWallet.address]: forgedSignature } }), expected, { payer: true, mint: true }), "payer signature does not verify")
  await throwsWith("wrong mint key file (resolves to another address)", () => mintCoSign(unsigned, expected, wrongMintKey), "not the mint identity")
  const wrongPayerTx = tx1(wrongWallet.address, mintKey.address)
  const wrongPayerSigned = encode(await partiallySignTransaction([wrongWallet.keyPair, mintKey.keyPair], wrongPayerTx))
  refused("TX1 built for another payer", await verifyTx1Transaction(wrongPayerSigned, expected, { payer: true, mint: true }), "message bytes differ")

  console.log("— modified, incomplete or extended transactions")
  const priorityFee: Instruction = { programAddress: COMPUTE_BUDGET, data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]) }
  const walletModified = tx1(payerWallet.address, mintKey.address, BH1, [priorityFee])
  const walletModifiedSigned = encode(await partiallySignTransaction([payerWallet.keyPair], walletModified))
  const withOldMintSig = { ...decode(walletModifiedSigned), signatures: { ...decode(walletModifiedSigned).signatures, [mintKey.address]: decode(partial).signatures[mintKey.address] } }
  const modifiedProblems = await verifyTx1Transaction(encode(withOldMintSig), expected, { payer: true, mint: true })
  refused("wallet added a priority-fee instruction after the mint signed (message changed)", modifiedProblems, "message bytes differ")
  const oldMintSignature = decode(partial).signatures[mintKey.address]!
  check(
    "… and the mint's co-signature does not cover the modified message (it would also fail on chain)",
    !(await verifySignature(await getPublicKeyFromAddress(mintKey.address), oldMintSignature, new Uint8Array(walletModified.messageBytes))),
  )
  refused("payer signature missing", await verifyTx1Transaction(partial, expected, { payer: true, mint: true }), "payer signature missing")
  const payerOnly = encode(await partiallySignTransaction([payerWallet.keyPair], unsigned))
  refused("mint signature missing", await verifyTx1Transaction(payerOnly, expected, { payer: true, mint: true }), "mint signature missing")
  const memo: Instruction = { programAddress: SYSTEM, accounts: [{ address: payerWallet.address, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }
  const extended = tx1(payerWallet.address, mintKey.address, BH1, [memo])
  await throwsWith("mint refuses to co-sign a message with an unexpected extra instruction", () => mintCoSign(extended, expected, mintKey), "not the reviewed TX1")
  const extendedSigned = encode(await partiallySignTransaction([payerWallet.keyPair, mintKey.keyPair], extended))
  refused("fully signed transaction with an unexpected extra instruction", await verifyTx1Transaction(extendedSigned, expected, { payer: true, mint: true }), "message bytes differ")
  await throwsWith("mint refuses to co-sign an already signed transaction", () => mintCoSign(decode(payerOnly), expected, mintKey), "already carries a signature")
  refused("trailing bytes after the transaction (they become part of the message)", await verifyTx1Transaction(Uint8Array.from([...Array.from(full), 0]), expected, { payer: true, mint: true }), "message bytes differ")
  refused("oversized input", await verifyTx1Transaction(new Uint8Array(1300), expected, { payer: true, mint: true }), "limit 1232")

  console.log("— blockhash refresh")
  const refreshed = tx1(payerWallet.address, mintKey.address, BH2)
  check("same TX1 with another blockhash is recognised as blockhash-only change", sameExceptBlockhash(expected.messageBytes, new Uint8Array(refreshed.messageBytes)))
  check("extra instruction is not a blockhash-only change", !sameExceptBlockhash(expected.messageBytes, new Uint8Array(extended.messageBytes)))
  check("other payer is not a blockhash-only change", !sameExceptBlockhash(expected.messageBytes, new Uint8Array(wrongPayerTx.messageBytes)))
  refused("a transaction signed for a different (drifted) blockhash than the prepared one", await verifyTx1Transaction(encode(await partiallySignTransaction([payerWallet.keyPair, mintKey.keyPair], refreshed)), expected, { payer: true, mint: true }), "message bytes differ")

  console.log("— cluster and arguments")
  const fakeRpc = (genesis: string) => ({ getGenesisHash: () => ({ send: async () => genesis }) }) as unknown as Parameters<typeof assertCluster>[0]
  await throwsWith("wrong cluster (mainnet genesis) for --cluster devnet", () => assertCluster(fakeRpc("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"), "devnet"), "does not match")
  check("devnet genesis accepted", (await assertCluster(fakeRpc("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"), "devnet")) === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
  const phantomArgs = parseArgs(["create-mint", "--cluster", "devnet", "--payer", DEVNET_SETUP.payer, "--payer-wallet", "phantom", "--mint-keypair", "/owner/mint.json", "--execute"])
  check("create-mint --payer-wallet phantom parsed", phantomArgs.errors.length === 0 && phantomArgs.values["--payer-wallet"] === "phantom" && phantomArgs.execute)
  check("refuses: --payer-wallet other than phantom", parseArgs(["create-mint", "--payer-wallet", "solflare"]).errors.some((e) => e.includes('accepts only "phantom"')))
  check("refuses: --payer-wallet together with --payer-keypair", parseArgs(["create-mint", "--payer-wallet", "phantom", "--payer-keypair", "/x.json"]).errors.some((e) => e.includes("not both")))

  console.log("— strict input encoding")
  check("canonical base64 accepted", Buffer.from(decodeStrictBase64(Buffer.from(full).toString("base64"))).equals(Buffer.from(full)))
  for (const [name, text] of [
    ["whitespace", ` ${Buffer.from(full).toString("base64")}`],
    ["invalid character", "AAA*"],
    ["non-canonical padding bits", "AB=="],
    ["not a string", 42],
  ] as const) {
    let threw = false
    try {
      decodeStrictBase64(text)
    } catch {
      threw = true
    }
    check(`refuses base64: ${name}`, threw)
  }

  console.log("— local owner page and server (127.0.0.1 only)")
  const html = ownerPage(payerWallet.address, mintKey.address)
  check("page uses Wallet Standard solana:signTransaction only (never signAndSend)", html.includes('"solana:signTransaction"') && !html.includes("signAndSendTransaction") && !html.includes("sendTransaction("))
  check("page asks for the devnet chain and loads no external resources", html.includes("solana:devnet") && !/\bsrc=|<link|https?:\/\//.test(html.replace(/https?:\/\/127\.0\.0\.1/g, "")))
  check("page refuses any connected account other than the approved payer", html.includes("are not the approved TX1 payer"))
  let prepareCalls = 0
  const prepared: PreparedTx1 = { wire: partial, expected, messageHash: messageHash(expected.messageBytes), blockhash: BH1, lastValidBlockHeight: BigInt(1000) }
  const session = await startOwnerSigningServer({
    payer: payerWallet.address,
    mint: mintKey.address,
    prepare: async () => {
      prepareCalls++
      return prepared
    },
  })
  const base = session.url
  const origin = `http://127.0.0.1:${session.port}`
  const call = async (path: string, init: { method?: string; body?: unknown; origin?: string | null; type?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": init.type ?? "application/json" }
    if (init.origin !== null) headers.origin = init.origin ?? origin
    const res = await fetch(new URL(path, base), { method: init.method ?? "POST", headers, body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}) })
    return { status: res.status, headers: res.headers, json: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as { ok: boolean; error?: string; transaction?: string }) : null }
  }
  const page = await fetch(base)
  check("GET page: 200 with frame protection and no CORS", page.status === 200 && page.headers.get("x-frame-options") === "DENY" && (page.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") && page.headers.get("access-control-allow-origin") === null)
  check("wrong token: 404", (await fetch(base.replace(/\/[0-9a-f]{48}\//, "/" + "0".repeat(48) + "/"))).status === 404)
  const wrongHost = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port: session.port, path: new URL(base).pathname, headers: { host: "localhost" } }, (res) => resolve(res.statusCode ?? 0))
    req.end()
  })
  check("wrong Host header (DNS rebinding): 403", wrongHost === 403)
  check("POST without Origin: 403", (await call("signed", { origin: null })).status === 403)
  check("POST from a foreign Origin: 403", (await call("signed", { origin: "https://evil.example" })).status === 403)
  check("POST non-JSON: 415", (await call("signed", { type: "text/plain" })).status === 415)
  check("signed before prepare: 409", (await call("signed", { body: { transaction: Buffer.from(full).toString("base64") } })).status === 409)
  const prep = await call("prepare")
  check("prepare returns the mint-co-signed transaction", prep.status === 200 && prep.json?.transaction === Buffer.from(partial).toString("base64") && prepareCalls === 1)
  check("oversized body: 413", (await call("signed", { body: { transaction: "A".repeat(20_000) } })).status === 413)
  check("malformed base64: 400", (await call("signed", { body: { transaction: "not base64!" } })).status === 400)
  const tampered = await call("signed", { body: { transaction: Buffer.from(encode(withOldMintSig)).toString("base64") } })
  check("wallet-modified transaction: 422, not accepted", tampered.status === 422 && Boolean(tampered.json?.error?.includes("message bytes differ")))
  const missing = await call("signed", { body: { transaction: Buffer.from(partial).toString("base64") } })
  check("payer signature missing: 422", missing.status === 422)
  const accept = await call("signed", { body: { transaction: Buffer.from(full).toString("base64") } })
  const resolved = await Promise.race([session.signed, new Promise<null>((r) => setTimeout(() => r(null), 1000))])
  check("valid payer + mint signatures: accepted and handed to the terminal", accept.status === 200 && resolved !== null && Buffer.from(resolved.wire).equals(Buffer.from(full)))
  check("resend: a second signed transaction is refused (409)", (await call("signed", { body: { transaction: Buffer.from(full).toString("base64") } })).status === 409)
  check("no new prepare after acceptance (409)", (await call("prepare")).status === 409 && prepareCalls === 1)
  await session.close()

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll TX1 Phantom-path checks passed")
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
