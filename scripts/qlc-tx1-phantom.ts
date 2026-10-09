// Owner-run mixed-signer path for QLC TX1 (create-mint): the approved Phantom Deploy_Fee_Payer signs as fee payer and
// the owner-controlled mint keypair co-signs, without any Phantom secret ever leaving the wallet. Used only by
// `npm run qlc:setup -- create-mint --payer-wallet phantom --mint-keypair <owner file> --execute` (OWNER MUTATION).
//
// Order matters. Phantom adds priority-fee (compute budget) instructions to every transaction it signs unless the
// transaction already carries a signature (docs.phantom.com/developer-powertools/solana-priority-fees). So the mint
// co-signs first, and only the exact reviewed message; Phantom then signs that message as-is. Every result is
// verified here: the message must be byte-identical to the reviewed TX1 and both signatures must verify, otherwise
// nothing is sent. Sending stays a separate, typed owner confirmation in the terminal.
//
// The browser page is dedicated to this one owner step: served on 127.0.0.1 behind a one-time token, no third-party
// code, Wallet Standard `solana:signTransaction` only (raw bytes in, raw bytes out; never signAndSend).
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  verifySignature,
  type Address,
  type Blockhash,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit"

/** Wallet Standard chain the payer wallet is asked to sign for. */
export const TX1_WALLET_CHAIN = "solana:devnet"
/** Solana's packet limit. */
export const MAX_TRANSACTION_BYTES = 1232
const ZERO_BLOCKHASH = "11111111111111111111111111111111" as Blockhash

const equalBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

/** base58(SHA-256(message bytes)): the message hash shown to the owner for comparison. */
export function messageHash(messageBytes: Uint8Array): string {
  return getAddressDecoder().decode(createHash("sha256").update(messageBytes).digest())
}

/** True when two compiled legacy messages are identical except for the recent blockhash. */
export function sameExceptBlockhash(a: Uint8Array, b: Uint8Array): boolean {
  try {
    const decoder = getCompiledTransactionMessageDecoder()
    const encoder = getCompiledTransactionMessageEncoder()
    const [ma, mb] = [decoder.decode(a), decoder.decode(b)]
    if (ma.version !== "legacy" || mb.version !== "legacy") return false
    return equalBytes(new Uint8Array(encoder.encode({ ...ma, lifetimeToken: ZERO_BLOCKHASH })), new Uint8Array(encoder.encode({ ...mb, lifetimeToken: ZERO_BLOCKHASH })))
  } catch {
    return false
  }
}

export interface Tx1Expectation {
  /** The reviewed TX1 message (canonical build for one blockhash). */
  messageBytes: Uint8Array
  payer: Address
  mint: Address
}

/**
 * A TX1 wire transaction is acceptable only if it carries exactly the reviewed message, its signer slots are exactly
 * [payer, mint], every required signature is present and verifies over the reviewed bytes, and it re-encodes to itself.
 */
export async function verifyTx1Transaction(wire: Uint8Array, expected: Tx1Expectation, required: { payer: boolean; mint: boolean }): Promise<string[]> {
  if (wire.length > MAX_TRANSACTION_BYTES) return [`transaction is ${wire.length} bytes (limit ${MAX_TRANSACTION_BYTES})`]
  let transaction: Transaction
  try {
    transaction = getTransactionDecoder().decode(wire)
  } catch (err) {
    return [`not a decodable transaction (${err instanceof Error ? err.message : String(err)})`]
  }
  const problems: string[] = []
  if (!equalBytes(new Uint8Array(transaction.messageBytes), expected.messageBytes)) {
    problems.push("message bytes differ from the reviewed TX1 message (the transaction was changed after it was built)")
  }
  const slots = Object.keys(transaction.signatures)
  if (JSON.stringify(slots) !== JSON.stringify([expected.payer, expected.mint])) {
    problems.push(`signer slots [${slots.join(", ")}] are not exactly [payer ${expected.payer}, mint ${expected.mint}]`)
  }
  for (const [role, address, needed] of [
    ["payer", expected.payer, required.payer],
    ["mint", expected.mint, required.mint],
  ] as const) {
    const signature = transaction.signatures[address]
    if (!signature) {
      if (needed) problems.push(`${role} signature missing`)
      continue
    }
    if (!(await verifySignature(await getPublicKeyFromAddress(address), signature, expected.messageBytes))) {
      problems.push(`${role} signature does not verify for ${address} over the reviewed message`)
    }
  }
  if (!problems.length && !equalBytes(new Uint8Array(getTransactionEncoder().encode(transaction)), wire)) {
    problems.push("non-canonical transaction encoding (extra or trailing bytes)")
  }
  return problems
}

/**
 * The mint co-signs only the exact reviewed TX1, and only with the key that resolves to the mint identity. Returns the
 * partially signed wire transaction (payer slot still empty) for the payer wallet.
 */
export async function mintCoSign(unsigned: Transaction, expected: Tx1Expectation, mint: KeyPairSigner): Promise<Uint8Array> {
  if (mint.address !== expected.mint) throw new Error(`STOP: the mint key resolves to ${mint.address}, not the mint identity ${expected.mint}`)
  if (!equalBytes(new Uint8Array(unsigned.messageBytes), expected.messageBytes)) throw new Error("STOP: refusing to co-sign: the message is not the reviewed TX1")
  if (Object.values(unsigned.signatures).some((signature) => signature !== null)) throw new Error("STOP: refusing to co-sign: the transaction already carries a signature")
  const wire = new Uint8Array(getTransactionEncoder().encode(await partiallySignTransaction([mint.keyPair], unsigned)))
  const problems = await verifyTx1Transaction(wire, expected, { payer: false, mint: true })
  if (problems.length) throw new Error(`STOP: mint co-signature check failed: ${problems.join("; ")}`)
  return wire
}

/** Strict, canonical base64 (no whitespace, canonical padding, re-encodes to itself). */
export function decodeStrictBase64(text: unknown): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("not strict base64")
  const bytes = Buffer.from(text, "base64")
  if (bytes.toString("base64") !== text) throw new Error("not canonical base64")
  return new Uint8Array(bytes)
}

export interface PreparedTx1 {
  /** Mint-co-signed wire transaction handed to the payer wallet. */
  wire: Uint8Array
  expected: Tx1Expectation
  messageHash: string
  blockhash: Blockhash
  lastValidBlockHeight: bigint
}

export interface OwnerSigningSession {
  url: string
  port: number
  /** Resolves once the payer wallet returned a transaction that passed every check. */
  signed: Promise<{ wire: Uint8Array; prepared: PreparedTx1 }>
  close(): Promise<void>
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
}
const MAX_BODY_BYTES = 16 * 1024

/**
 * Local owner-signing page: GET /<token>/ serves the page; POST /<token>/prepare builds, re-verifies and mint-co-signs a
 * fresh TX1 (via `prepare`); POST /<token>/signed accepts the payer wallet's result exactly once, after full verification.
 * Only 127.0.0.1 with the exact Host header; POSTs need the page's own Origin.
 */
export async function startOwnerSigningServer(options: { payer: Address; mint: Address; prepare: () => Promise<PreparedTx1>; port?: number }): Promise<OwnerSigningSession> {
  const token = randomBytes(24).toString("hex")
  let active: PreparedTx1 | null = null
  let accepted = false
  let resolveSigned!: (value: { wire: Uint8Array; prepared: PreparedTx1 }) => void
  const signed = new Promise<{ wire: Uint8Array; prepared: PreparedTx1 }>((resolve) => (resolveSigned = resolve))
  let port = 0

  const reply = (res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type })
    res.end(typeof body === "string" ? body : JSON.stringify(body))
  }
  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size <= MAX_BODY_BYTES) chunks.push(chunk)
        else if (size > 64 * MAX_BODY_BYTES) req.destroy()
      })
      req.on("end", () => {
        if (size > MAX_BODY_BYTES) return reject(Object.assign(new Error("request body too large"), { status: 413 }))
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object")
          resolve(value as Record<string, unknown>)
        } catch {
          reject(Object.assign(new Error("malformed JSON body"), { status: 400 }))
        }
      })
      req.on("error", reject)
    })

  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403, { ok: false, error: "wrong Host" })
      const path = (req.url ?? "").split("?")[0]
      if (!path.startsWith(`/${token}/`)) return reply(res, 404, { ok: false, error: "not found" })
      const route = path.slice(token.length + 2)
      if (req.method === "GET" && route === "") return reply(res, 200, ownerPage(options.payer, options.mint), "text/html; charset=utf-8")
      if (req.method !== "POST" || (route !== "prepare" && route !== "signed")) return reply(res, 404, { ok: false, error: "not found" })
      if (req.headers.origin !== `http://127.0.0.1:${port}`) return reply(res, 403, { ok: false, error: "wrong Origin" })
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(res, 415, { ok: false, error: "JSON only" })
      const body = await readJson(req)
      if (accepted) return reply(res, 409, { ok: false, error: "a signed TX1 was already accepted; nothing more is accepted in this session" })
      if (route === "prepare") {
        active = null
        const prepared = await options.prepare()
        active = prepared
        return reply(res, 200, {
          ok: true,
          transaction: Buffer.from(prepared.wire).toString("base64"),
          messageHash: prepared.messageHash,
          lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
        })
      }
      if (!active) return reply(res, 409, { ok: false, error: "no prepared TX1: press Prepare first" })
      let wire: Uint8Array
      try {
        wire = decodeStrictBase64(body.transaction)
      } catch (err) {
        return reply(res, 400, { ok: false, error: `transaction: ${err instanceof Error ? err.message : String(err)}` })
      }
      const problems = await verifyTx1Transaction(wire, active.expected, { payer: true, mint: true })
      if (problems.length) return reply(res, 422, { ok: false, error: problems.join("; ") })
      accepted = true
      resolveSigned({ wire, prepared: active })
      return reply(res, 200, { ok: true, messageHash: active.messageHash })
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      return reply(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    port,
    signed,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** The owner page: plain DOM, no external resources; the only wallet call is Wallet Standard solana:signTransaction. */
export function ownerPage(payer: Address, mint: Address): string {
  const config = JSON.stringify({ payer, mint, chain: TX1_WALLET_CHAIN }).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QLC TX1 owner signing (devnet)</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;background:#0a0a0f;color:#e8e8f0}
code,pre{font-family:ui-monospace,monospace;word-break:break-all}pre{background:#15151f;padding:1rem;border-radius:8px;white-space:pre-wrap}
button{font:inherit;padding:.6rem 1rem;margin:.25rem .5rem .25rem 0;border:0;border-radius:8px;background:#7B61FF;color:#fff;cursor:pointer}
button:disabled{opacity:.4;cursor:default}</style></head>
<body>
<h1>QLC TX1 — owner signing (Solana devnet)</h1>
<p>OWNER MUTATION. Fee payer (Phantom): <code id="payer"></code><br>Mint co-signer (local owner key, applied by the terminal tool before Phantom): <code id="mint"></code></p>
<p>Phantom must be on the approved payer account. This page never sends anything; the terminal asks you to type SEND.</p>
<button id="connect">1. Connect Phantom</button><button id="sign" disabled>2. Prepare and sign TX1</button>
<pre id="log"></pre>
<script>
"use strict";
const CONFIG = ${config};
const out = document.getElementById("log");
const log = (line) => { out.textContent += line + "\\n"; };
document.getElementById("payer").textContent = CONFIG.payer;
document.getElementById("mint").textContent = CONFIG.mint;
const wallets = [];
const api = Object.freeze({ register: (...items) => { wallets.push(...items); return () => {}; } });
window.addEventListener("wallet-standard:register-wallet", (event) => event.detail(api));
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
const toBase64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const post = async (path, body) => (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
let wallet = null;
let account = null;
document.getElementById("connect").onclick = async () => {
  wallet = wallets.find((w) => w.name === "Phantom" && w.features["standard:connect"] && w.features["solana:signTransaction"]);
  if (!wallet) return log("REFUSED: Phantom (Wallet Standard with solana:signTransaction) was not found in this browser.");
  if (!wallet.features["solana:signTransaction"].supportedTransactionVersions.includes("legacy")) return log("REFUSED: this Phantom does not sign legacy transactions.");
  try {
    const { accounts } = await wallet.features["standard:connect"].connect();
    account = accounts.find((a) => a.address === CONFIG.payer) || null;
    if (!account) return log("REFUSED: the connected Phantom account(s) " + accounts.map((a) => a.address).join(", ") + " are not the approved TX1 payer " + CONFIG.payer + ". Select that account in Phantom and connect again.");
    log("Connected the approved TX1 payer " + account.address + ".");
    document.getElementById("sign").disabled = false;
  } catch (err) { log("Phantom did not connect: " + (err && err.message || err)); }
};
document.getElementById("sign").onclick = async () => {
  const button = document.getElementById("sign");
  button.disabled = true;
  const prepared = await post("prepare", {});
  if (!prepared.ok) { log("REFUSED by the terminal tool: " + prepared.error); button.disabled = false; return; }
  log("TX1 Message Hash: " + prepared.messageHash + " (must equal the hash in the terminal). Approve only this in Phantom.");
  try {
    const [result] = await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: fromBase64(prepared.transaction), chain: CONFIG.chain });
    const verdict = await post("signed", { transaction: toBase64(result.signedTransaction) });
    if (verdict.ok) log("Verified by the terminal tool (message unchanged, payer and mint signatures valid). Return to the terminal; nothing has been sent.");
    else { log("REFUSED by the terminal tool: " + verdict.error); button.disabled = false; }
  } catch (err) { log("Phantom did not sign: " + (err && err.message || err)); button.disabled = false; }
};
</script>
</body></html>
`
}
