// Offline checks for wallet sign-in (Sign In With Solana via Supabase Web3), for wallet session
// resolution in src/lib/authSession.ts and for the route guards in src/middleware.ts. Real Supabase
// client code, stubbed network, the owner's test wallet (scripts/test-identities.ts). No Supabase
// project is contacted.
//
//   npm run check:wallet-auth
import { sign, verify, createPublicKey, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { NextRequest } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getBase58Decoder } from "@solana/kit"
import type { SignInInput, WalletSigner } from "../src/lib/walletSignIn"
import { missingIdentity, testEd25519Key } from "./test-identities"

const PROJECT_REF = "abcdefghijklmnopqrst"
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key"

let failures = 0
let blockedChecks = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
/** Checks that need an owner test identity that is not provided: never passes, never runs. */
function blocked(name: string, count: number, reason: string) {
  blockedChecks += count
  console.log(`BLOCKED  ${name} (${count} checks)  — ${reason}`)
}

// The owner's test wallet. Without it the signing checks are BLOCKED and the address-only checks use a
// key-less placeholder address (a sysvar address nobody holds a key for).
const walletKey = testEd25519Key("wallet-1")
const rawPub = walletKey ? Buffer.from(createPublicKey(walletKey).export({ format: "jwk" }).x as string, "base64url") : null
const WALLET = rawPub ? getBase58Decoder().decode(rawPub) : "SysvarRent111111111111111111111111111111111"
const OTHER_WALLET = "So11111111111111111111111111111111111111112"
const signWithWallet = async (message: Uint8Array) => new Uint8Array(sign(null, message, walletKey!))

const web3User = (id: string, address: string, claimed = address) => ({
  id, aud: "authenticated", role: "authenticated", app_metadata: { provider: "web3", providers: ["web3"] }, user_metadata: {},
  created_at: new Date().toISOString(),
  identities: [{ id: `web3:solana:${address}`, identity_id: randomUUID(), user_id: id, provider: "web3",
    identity_data: { sub: `web3:solana:${address}`, custom_claims: { address: claimed, chain: "solana", domain: "localhost:3000" } } }],
})
const emailUser = (id: string) => ({
  id, aud: "authenticated", role: "authenticated", app_metadata: { provider: "email" }, user_metadata: {}, created_at: new Date().toISOString(),
  identities: [{ id, identity_id: randomUUID(), user_id: id, provider: "email", identity_data: { sub: id, email: "someone@qelarix.test" } }],
})
const sessionFor = (user: object) => {
  const now = Math.floor(Date.now() / 1000)
  return { access_token: `access-${randomUUID()}`, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: `refresh-${randomUUID()}`, user }
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>
const realFetch = globalThis.fetch
function stubFetch(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return calls
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function identityChecks() {
  console.log("── Wallet identity ──")
  const { getSolanaWalletAddress, shortWalletAddress } = await import("../src/lib/walletIdentity")
  const id = randomUUID()
  check("web3 identity → wallet address", getSolanaWalletAddress(web3User(id, WALLET)) === WALLET)
  check("email identity → null", getSolanaWalletAddress(emailUser(id)) === null)
  check("claim / identity mismatch → null", getSolanaWalletAddress(web3User(id, WALLET, OTHER_WALLET)) === null)
  check("malformed identity id → null", getSolanaWalletAddress({ identities: [{ provider: "web3", id: "web3:solana:not-base58!" }] }) === null)
  check("other chain identity → null", getSolanaWalletAddress({ identities: [{ provider: "web3", id: `web3:ethereum:0xabc` }] }) === null)
  check("no user → null", getSolanaWalletAddress(null) === null)
  check("web3 identity found among several", getSolanaWalletAddress({ identities: [emailUser(id).identities[0], web3User(id, WALLET).identities[0]] }) === WALLET)
  check("short address", shortWalletAddress(WALLET) === `${WALLET.slice(0, 4)}…${WALLET.slice(-4)}`)
}

async function signInChecks() {
  console.log("\n── Sign In With Solana ──")
  const lib = await import("../src/lib/walletSignIn")
  check("enabled on devnet only", lib.isWalletSignInEnabled("devnet") && !lib.isWalletSignInEnabled("mainnet-beta") && !lib.isWalletSignInEnabled(null))
  check("wallet chain ids", lib.walletChainFor("devnet") === "solana:devnet" && lib.walletChainFor("mainnet-beta") === "solana:mainnet")
  check("user rejection detected", lib.isUserRejection({ code: 4001 }) && lib.isUserRejection(new Error("User rejected the request.")) && !lib.isUserRejection(new Error("Network error")))
  check("wallets with solana:signIn use Sign In With Solana; signMessage only without it",
    lib.walletSignInMethod(["solana:signMessage", "solana:signIn"]) === "sign-in" && lib.walletSignInMethod(["solana:signMessage"]) === "sign-message" &&
    lib.walletSignInMethod(["standard:connect"]) === null)
  const unusedSignIn: WalletSigner = { signIn: async () => { throw new Error("not called") } }
  const asSignIn = lib.toSupabaseSolanaWallet(OTHER_WALLET, unusedSignIn)
  const asMessage = lib.toSupabaseSolanaWallet(OTHER_WALLET, { signMessage: async () => new Uint8Array(64) })
  check("signIn wallet is handed to Supabase with signIn only, so Supabase cannot fall back to its own message text",
    typeof asSignIn.signIn === "function" && !("signMessage" in asSignIn) && asSignIn.publicKey?.toBase58() === OTHER_WALLET)
  check("signMessage wallet is handed to Supabase without signIn", typeof asMessage.signMessage === "function" && !("signIn" in asMessage))
  const ui = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/components/auth/WalletSignIn.tsx"), "utf8")
  check("sign-in UI takes the signIn path (useSignIn) for signIn wallets",
    /walletSignInMethod\(props\.wallet\.features\) === "sign-in" \? <SignInStep/.test(ui) && /useSignIn\(props\.wallet\)/.test(ui))
  if (!walletKey || !rawPub) {
    blocked("Sign In With Solana signing flows (signIn and signMessage)", 18, missingIdentity("wallet-1"))
    return
  }

  const pageUrl = "http://localhost:3000/login"
  const client = () => createClient(SUPABASE_URL, "anon-key", { auth: { persistSession: false, autoRefreshToken: false } })
  const userId = randomUUID()

  let calls = stubFetch(async (url, init) => {
    const body = JSON.parse(String(init.body))
    return url.pathname === "/auth/v1/token" && body.chain === "solana" ? json(sessionFor(web3User(userId, WALLET))) : json({}, 404)
  })
  const ok = await lib.signInWithSolanaWallet(client(), WALLET, { signMessage: signWithWallet }, pageUrl)
  check("valid signature → signed-in with the signing wallet", ok.kind === "signed-in" && ok.walletAddress === WALLET && ok.userId === userId, JSON.stringify(ok))
  const req = calls.find((c) => c.url.pathname === "/auth/v1/token")
  const body = req ? JSON.parse(String(req.init.body)) : {}
  const lines = String(body.message).split("\n")
  check("token request uses grant_type=web3, chain solana", req?.url.searchParams.get("grant_type") === "web3" && body.chain === "solana")
  check("SIWS message: domain, address, statement, version, URI, issued-at",
    lines[0] === "localhost:3000 wants you to sign in with your Solana account:" && lines[1] === WALLET &&
    lines.includes(lib.WALLET_SIGN_IN_STATEMENT) && lines.includes("Version: 1") && lines.includes(`URI: ${pageUrl}`) &&
    lines.some((l) => l.startsWith("Issued At: ")))
  const sig = Buffer.from(String(body.signature).replace(/-/g, "+").replace(/_/g, "/"), "base64")
  const pub = createPublicKey(walletKey)
  check("signature verifies against the wallet address", verify(null, new TextEncoder().encode(body.message), pub, sig))
  check("no private key material sent", !JSON.stringify(body).includes(walletKey.export({ format: "jwk" }).d as string))

  calls = stubFetch(() => json(sessionFor(web3User(userId, WALLET))))
  const rejected = await lib.signInWithSolanaWallet(client(), WALLET, { signMessage: async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }) } }, pageUrl)
  check("rejected signature → rejected, no session request", rejected.kind === "rejected" && calls.length === 0, JSON.stringify(rejected))

  stubFetch(() => json({ code: 422, error_code: "web3_provider_disabled", msg: "Web3 provider is disabled" }, 422))
  const disabled = await lib.signInWithSolanaWallet(client(), WALLET, { signMessage: signWithWallet }, pageUrl)
  check("provider disabled → unavailable", disabled.kind === "unavailable", JSON.stringify(disabled))

  calls = stubFetch((url) => (url.pathname === "/auth/v1/token" ? json(sessionFor(web3User(userId, OTHER_WALLET))) : new Response(null, { status: 204 })))
  const mismatchClient = client()
  const mismatch = await lib.signInWithSolanaWallet(mismatchClient, WALLET, { signMessage: signWithWallet }, pageUrl)
  const { data: leftover } = await mismatchClient.auth.getSession()
  check("session for another wallet → error, session revoked and cleared",
    mismatch.kind === "error" && leftover.session === null &&
    calls.some((c) => c.url.pathname === "/auth/v1/logout" && c.url.searchParams.get("scope") === "local"), JSON.stringify(mismatch))

  calls = stubFetch(() => json({}))
  const invalid = await lib.signInWithSolanaWallet(client(), "0OIl-not-an-address", { signMessage: signWithWallet }, pageUrl)
  check("invalid address → error, nothing signed or sent", invalid.kind === "error" && calls.length === 0)

  stubFetch(() => json({ code: 400, error_code: "validation_failed", msg: "Signature is invalid" }, 400))
  const failed = await lib.signInWithSolanaWallet(client(), WALLET, { signMessage: signWithWallet }, pageUrl)
  check("server rejects signature → error, no session", failed.kind === "error", JSON.stringify(failed))

  console.log("\n── Sign In With Solana through the wallet's signIn (solana:signIn, e.g. Phantom) ──")
  // A signIn wallet builds the SIWS text itself, in the field order of the SIWS specification
  // (as createSignInMessageText in @solana/wallet-standard-util).
  const siwsText = (input: SignInInput) => {
    let text = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`
    if (input.statement) text += `\n\n${input.statement}`
    const fields = [
      input.uri && `URI: ${input.uri}`, input.version && `Version: ${input.version}`, input.chainId && `Chain ID: ${input.chainId}`,
      input.nonce && `Nonce: ${input.nonce}`, input.issuedAt && `Issued At: ${input.issuedAt}`,
      input.expirationTime && `Expiration Time: ${input.expirationTime}`, input.notBefore && `Not Before: ${input.notBefore}`,
      input.requestId && `Request ID: ${input.requestId}`, ...(input.resources?.length ? ["Resources:", ...input.resources.map((r) => `- ${r}`)] : []),
    ].filter(Boolean)
    return fields.length ? `${text}\n\n${fields.join("\n")}` : text
  }
  // Byte arrays from another JavaScript realm (as a wallet may return): not `instanceof Uint8Array` here.
  const foreignBytes = (bytes: Uint8Array) => runInNewContext("Uint8Array.from(source)", { source: Array.from(bytes) }) as Uint8Array
  const signInInputs: SignInInput[] = []
  const signInWallet = (reportedAddress = WALLET, bytes = (b: Uint8Array) => b): WalletSigner => ({
    signIn: async (input) => {
      signInInputs.push(input)
      const signedMessage = new TextEncoder().encode(siwsText(input))
      const signature = await signWithWallet(signedMessage)
      return {
        account: { address: reportedAddress, publicKey: Uint8Array.from(rawPub), chains: ["solana:devnet"], features: ["solana:signIn"] },
        signedMessage: bytes(signedMessage),
        signature: bytes(signature),
      }
    },
  })
  const tokenOk = () => stubFetch(async (url, init) => {
    const body = JSON.parse(String(init.body))
    return url.pathname === "/auth/v1/token" && body.chain === "solana" ? json(sessionFor(web3User(userId, WALLET))) : json({}, 404)
  })

  calls = tokenOk()
  const viaSignIn = await lib.signInWithSolanaWallet(client(), WALLET, signInWallet(), pageUrl)
  check("signIn wallet → signed-in with the signing wallet", viaSignIn.kind === "signed-in" && viaSignIn.walletAddress === WALLET, JSON.stringify(viaSignIn))
  const input: SignInInput = signInInputs[0] ?? {}
  check("Supabase asks the wallet for the SIWS fields: domain, URI, version 1, statement, issued-at, connected address",
    signInInputs.length === 1 && input.domain === "localhost:3000" && input.uri === pageUrl && input.version === "1" &&
    input.statement === lib.WALLET_SIGN_IN_STATEMENT && input.address === WALLET && !Number.isNaN(Date.parse(input.issuedAt ?? "")), JSON.stringify(input))
  const signInRequest = calls.find((c) => c.url.pathname === "/auth/v1/token")
  const signInBody = signInRequest ? JSON.parse(String(signInRequest.init.body)) : {}
  check("token request carries the message the wallet built, not Supabase's own text", signInBody.message === siwsText(input))
  const at = (prefix: string) => String(signInBody.message).split("\n").findIndex((l) => l.startsWith(prefix))
  check("message follows the SIWS field order (URI, Version, Issued At)", at("URI: ") > 1 && at("URI: ") < at("Version: ") && at("Version: ") < at("Issued At: "))
  const signInSig = Buffer.from(String(signInBody.signature).replace(/-/g, "+").replace(/_/g, "/"), "base64")
  check("signature verifies over the wallet-built message", verify(null, new TextEncoder().encode(signInBody.message), pub, signInSig))

  calls = tokenOk()
  const crossRealm = await lib.signInWithSolanaWallet(client(), WALLET, signInWallet(WALLET, foreignBytes), pageUrl)
  check("signIn output from another realm is accepted (copied to plain Uint8Arrays)",
    !(foreignBytes(new Uint8Array(1)) instanceof Uint8Array) && crossRealm.kind === "signed-in", JSON.stringify(crossRealm))

  calls = tokenOk()
  const otherAccount = await lib.signInWithSolanaWallet(client(), WALLET, signInWallet(OTHER_WALLET), pageUrl)
  check("wallet signs in with another account → error, nothing sent to Supabase", otherAccount.kind === "error" && calls.length === 0, JSON.stringify(otherAccount))

  calls = tokenOk()
  const declined = await lib.signInWithSolanaWallet(client(), WALLET, { signIn: async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }) } }, pageUrl)
  check("declined signIn → rejected, no session request", declined.kind === "rejected" && calls.length === 0, JSON.stringify(declined))
}

async function sessionResolutionChecks() {
  console.log("\n── Server session resolution (src/lib/authSession.ts) ──")
  const { getRequestAuthUser } = await import("../src/lib/authSession")
  const cookieName = `sb-${PROJECT_REF}-auth-token`
  const supabaseCookie = (session: object) => `${cookieName}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
  const request = (cookie?: string) => new NextRequest("http://localhost:3000/api/profile", { headers: cookie ? { cookie } : {} })
  const walletId = randomUUID()
  const walletSession = sessionFor(web3User(walletId, WALLET))

  function supabaseServer(users: Record<string, object>) {
    return stubFetch((url, init) => {
      const auth = new Headers(init.headers).get("authorization") ?? ""
      if (url.pathname === "/auth/v1/user") {
        const user = users[auth.replace(/^Bearer /, "")]
        return user ? json(user) : json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401)
      }
      if (url.pathname === "/rest/v1/profiles") {
        const object = new Headers(init.headers).get("accept")?.includes("vnd.pgrst.object")
        return object ? json({ plan: "pro" }) : json([{ plan: "pro" }])
      }
      return json({}, 404)
    })
  }

  let calls = supabaseServer({ [walletSession.access_token]: walletSession.user })
  const wallet = await getRequestAuthUser(request(supabaseCookie(walletSession)))
  check("wallet session → user with wallet address and profile plan",
    wallet?.id === walletId && wallet.walletAddress === WALLET && wallet.plan === "pro" && wallet.email === null, JSON.stringify(wallet))
  check("access token validated with Supabase Auth (getUser)", calls.some((c) => c.url.pathname === "/auth/v1/user"))
  check("profile read with the service role, not the user token",
    calls.some((c) => c.url.pathname === "/rest/v1/profiles" && new Headers(c.init.headers).get("authorization") === "Bearer service-role-key"))

  const emailSession = sessionFor(emailUser(randomUUID()))
  supabaseServer({ [emailSession.access_token]: emailSession.user })
  check("Supabase email session is not accepted", (await getRequestAuthUser(request(supabaseCookie(emailSession)))) === null)

  supabaseServer({})
  check("revoked / invalid wallet token → not accepted", (await getRequestAuthUser(request(supabaseCookie(walletSession)))) === null)

  // Wallet-only: a NextAuth session cookie (the retired Google/GitHub sign-in) is never read.
  const legacyCookie = `next-auth.session-token=${randomBytes(48).toString("base64url")}`
  supabaseServer({ [walletSession.access_token]: walletSession.user })
  const both = await getRequestAuthUser(request(`${supabaseCookie(walletSession)}; ${legacyCookie}`))
  check("wallet session next to a stray legacy cookie → the wallet user", both?.id === walletId && both.walletAddress === WALLET)

  calls = supabaseServer({})
  check("legacy NextAuth cookie alone → null, Supabase not contacted",
    (await getRequestAuthUser(request(legacyCookie))) === null && calls.length === 0)
  calls = supabaseServer({})
  check("no session at all → null, Supabase not contacted", (await getRequestAuthUser(request())) === null && calls.length === 0)

  console.log("\n── Middleware guards (src/middleware.ts) ──")
  const { middleware } = await import("../src/middleware")
  const visit = (path: string, cookie?: string) => middleware(new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} }))
  const target = (res: Response) => {
    const location = res.headers.get("location")
    if (res.status !== 307 || !location) return null
    const url = new URL(location)
    return url.origin === "http://localhost:3000" ? `${url.pathname}${url.search}` : location
  }
  const passes = (res: Response) => res.status === 200 && res.headers.get("location") === null
  const signedIn = supabaseCookie(walletSession)
  const emailOnly = sessionFor(emailUser(randomUUID()))

  supabaseServer({ [walletSession.access_token]: walletSession.user, [emailOnly.access_token]: emailOnly.user })
  check("signed out: protected page → /login with the full destination as callbackUrl",
    target(await visit("/dashboard?tab=plan")) === `/login?callbackUrl=${encodeURIComponent("/dashboard?tab=plan")}`)
  check("signed out: /login and /signup open", passes(await visit("/login")) && passes(await visit("/signup?callbackUrl=/pricing")))
  check("legacy NextAuth cookie only: protected page → /login", target(await visit("/settings", legacyCookie)) === `/login?callbackUrl=${encodeURIComponent("/settings")}`)
  check("Supabase email session: protected page → /login", target(await visit("/dashboard", supabaseCookie(emailOnly))) === `/login?callbackUrl=${encodeURIComponent("/dashboard")}`)
  check("wallet session: protected page opens", passes(await visit("/dashboard", signedIn)))
  check("wallet session: /login?callbackUrl=/pricing → /pricing", target(await visit("/login?callbackUrl=/pricing", signedIn)) === "/pricing")
  check("wallet session: /signup without destination → /dashboard", target(await visit("/signup", signedIn)) === "/dashboard")
  check("wallet session: external callbackUrl → /dashboard", target(await visit(`/login?callbackUrl=${encodeURIComponent("//evil.example")}`, signedIn)) === "/dashboard")
  check("wallet session: callbackUrl back to a sign-in page → /dashboard (no loop)", target(await visit("/login?callbackUrl=/signup", signedIn)) === "/dashboard")
}

identityChecks()
  .then(signInChecks)
  .then(sessionResolutionChecks)
  .then(() => {
    globalThis.fetch = realFetch
    if (blockedChecks) console.log(`\n${blockedChecks} CHECK(S) BLOCKED: owner test identities missing`)
    console.log(`\n${failures === 0 ? (blockedChecks ? "ALL RUNNABLE CHECKS PASSED" : "ALL CHECKS PASSED") : `${failures} CHECK(S) FAILED`}`)
    process.exit(failures === 0 && blockedChecks === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
