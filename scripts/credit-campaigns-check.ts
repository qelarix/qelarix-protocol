// Offline checks for the credit campaign engine: eligibility rules, Solana account signals,
// claim orchestration, operator grants and the Supabase store adapter. No network, no database.
// Database-level guarantees (cap, concurrency, idempotency, privileges) are covered by
// scripts/credit-campaigns-db-check.mjs.
//
//   npm run check:credit-campaigns
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuthUser } from "../src/lib/authSession"
import { parseSolanaCluster } from "../src/lib/solanaCluster"
import { evaluateEligibility, type EligibilityContext } from "../src/lib/creditCampaigns/eligibility"
import { createSolanaAccountSignals, SIGNATURE_PAGE_SIZE } from "../src/lib/creditCampaigns/solanaAccountSignals"
import {
  DEVNET_AUTO_CLAIM_CAMPAIGNS,
  devnetAutoClaimCampaigns,
  claimCampaignCredits,
  claimDevnetBetaCredits,
  createSupabaseCampaignStore,
  grantManualCredits,
  type CampaignStore,
  type CreditCampaign,
  type GrantRequest,
  type GrantServiceDeps,
} from "../src/lib/creditCampaigns/grantService"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const OTHER_WALLET = "So11111111111111111111111111111111111111112"
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const NOW = new Date("2026-10-02T12:00:00Z")
const NOW_S = Math.floor(NOW.getTime() / 1000)
const user = (walletAddress: string | null = WALLET): AuthUser => ({
  id: "6f1c2c1e-6c3f-4d55-9d1e-2b8f4a0d9c11", email: null, plan: null, walletAddress,
})

// ── Fake Solana JSON-RPC ─────────────────────────────────────────────────────
interface FakeChain {
  lamports?: number
  signatures?: { signature: string; blockTime: number | null }[]
  tokenAmounts?: string[]
  fail?: boolean
}
function fakeRpc(chain: FakeChain) {
  const calls: string[] = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body))
    calls.push(method)
    if (chain.fail) return new Response("upstream down", { status: 503 })
    let result: unknown
    if (method === "getBalance") result = { value: chain.lamports ?? 0 }
    if (method === "getSignaturesForAddress") {
      const all = chain.signatures ?? []
      const before = params[1]?.before
      const start = before ? all.findIndex((s) => s.signature === before) + 1 : 0
      result = all.slice(start, start + params[1].limit)
    }
    if (method === "getTokenAccountsByOwner") {
      result = { value: (chain.tokenAmounts ?? []).map((amount) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } })) }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 })
  }) as typeof fetch
  return { signals: createSolanaAccountSignals("http://rpc.local", fetchImpl), calls }
}
const history = (count: number, newestTime: number, step = 60) =>
  Array.from({ length: count }, (_, i) => ({ signature: `sig${i}`, blockTime: newestTime - i * step }))

async function eligible(rules: unknown, chain: FakeChain = {}, walletAddress: string | null = WALLET) {
  const { signals, calls } = fakeRpc(chain)
  const context: EligibilityContext = { user: user(walletAddress), cluster: "mainnet-beta", signals, now: NOW }
  return { result: await evaluateEligibility(rules, context), calls }
}
const reason = (r: { eligible: boolean; reason?: string }) => (r.eligible ? "eligible" : r.reason)

async function eligibilityChecks() {
  console.log("── Eligibility rules ──")
  check("no rules → eligible", (await eligible([])).result.eligible)
  check("rules not an array → invalid_rules", reason((await eligible({ type: "wallet_identity" })).result) === "invalid_rules")
  check("wallet_identity without wallet → wallet_required", reason((await eligible([{ type: "wallet_identity" }], {}, null)).result) === "wallet_required")
  check("wallet_identity with wallet → eligible", (await eligible([{ type: "wallet_identity" }])).result.eligible)

  check("allowlist hit → eligible", (await eligible([{ type: "allowlist", wallets: [OTHER_WALLET, WALLET] }])).result.eligible)
  check("allowlist miss → not_allowlisted", reason((await eligible([{ type: "allowlist", wallets: [OTHER_WALLET] }])).result) === "not_allowlisted")
  check("allowlist malformed → invalid_rule", reason((await eligible([{ type: "allowlist", wallets: ["nope"] }])).result) === "invalid_rule:allowlist")

  const testerId = user().id
  check("user_allowlist hit (no wallet needed) → eligible", (await eligible([{ type: "user_allowlist", userIds: [testerId.toUpperCase()] }], {}, null)).result.eligible)
  check("user_allowlist miss → not_allowlisted", reason((await eligible([{ type: "user_allowlist", userIds: ["00000000-0000-4000-8000-000000000000"] }])).result) === "not_allowlisted")
  check("user_allowlist malformed → invalid_rule", reason((await eligible([{ type: "user_allowlist", userIds: ["not-a-uuid"] }])).result) === "invalid_rule:user_allowlist")

  const sol = [{ type: "min_sol_balance", lamports: 50_000_000 }]
  check("min_sol_balance met → eligible", (await eligible(sol, { lamports: 50_000_000 })).result.eligible)
  check("min_sol_balance not met → sol_balance_too_low", reason((await eligible(sol, { lamports: 49_999_999 })).result) === "sol_balance_too_low")
  check("min_sol_balance without wallet → wallet_required (no RPC)", reason((await eligible(sol, {}, null)).result) === "wallet_required")
  check("min_sol_balance malformed → invalid_rule", reason((await eligible([{ type: "min_sol_balance", lamports: -1 }])).result) === "invalid_rule:min_sol_balance")
  check("RPC failure → signal_unavailable (fail closed)", reason((await eligible(sol, { fail: true })).result) === "signal_unavailable")

  const age = [{ type: "min_wallet_age_days", days: 30 }]
  const oldOnSecondPage = [...history(SIGNATURE_PAGE_SIZE, NOW_S), { signature: "old", blockTime: NOW_S - 40 * 86_400 }]
  const aged = await eligible(age, { signatures: oldOnSecondPage })
  check("wallet age found on page 2 → eligible", aged.result.eligible && aged.calls.filter((c) => c === "getSignaturesForAddress").length === 2)
  check("only recent history → wallet_too_new", reason((await eligible(age, { signatures: history(20, NOW_S) })).result) === "wallet_too_new")
  check("history beyond scan limit → signal_unavailable", reason((await eligible(age, { signatures: history(SIGNATURE_PAGE_SIZE * 10 + 5, NOW_S, 1) })).result) === "signal_unavailable")

  check("min_transaction_count met → eligible", (await eligible([{ type: "min_transaction_count", count: 5 }], { signatures: history(5, NOW_S) })).result.eligible)
  check("min_transaction_count not met → too_few_transactions", reason((await eligible([{ type: "min_transaction_count", count: 6 }], { signatures: history(5, NOW_S) })).result) === "too_few_transactions")

  const usdc = [{ type: "token_balance", mint: MINT, minAmount: "1000000" }]
  check("token_balance summed across accounts → eligible", (await eligible(usdc, { tokenAmounts: ["400000", "600000"] })).result.eligible)
  check("token_balance short → token_balance_too_low", reason((await eligible(usdc, { tokenAmounts: ["999999"] })).result) === "token_balance_too_low")
  check("specific NFT mint (minAmount 1) held → eligible", (await eligible([{ type: "token_balance", mint: MINT, minAmount: "1" }], { tokenAmounts: ["1"] })).result.eligible)

  const anyOf = [{ type: "any_of", rules: [{ type: "allowlist", wallets: [OTHER_WALLET] }, { type: "min_sol_balance", lamports: 1 }] }]
  check("any_of: second rule passes → eligible", (await eligible(anyOf, { lamports: 5 })).result.eligible)
  check("any_of: none pass → last reason", reason((await eligible(anyOf, { lamports: 0 })).result) === "sol_balance_too_low")
  check("all rules must pass (AND)", reason((await eligible([{ type: "wallet_identity" }, ...sol], { lamports: 0 })).result) === "sol_balance_too_low")

  check("unknown rule type → not eligible", reason((await eligible([{ type: "holds_unicorn" }])).result) === "unknown_rule:holds_unicorn")
  check("prototype key as rule type → not eligible", reason((await eligible([{ type: "constructor" }])).result) === "unknown_rule:constructor")
  for (const reserved of ["verified_usdc_purchase", "invite_code", "nft_collection"]) {
    check(`${reserved} reserved → rule_not_available`, reason((await eligible([{ type: reserved }])).result) === `rule_not_available:${reserved}`)
  }

  const { signals, calls } = fakeRpc({ lamports: 10 })
  await Promise.all([signals.getBalanceLamports(WALLET), signals.getBalanceLamports(WALLET)])
  check("signals are memoized per request", calls.length === 1)
}

// ── Claim orchestration ──────────────────────────────────────────────────────
function campaign(id: string, overrides: Partial<CreditCampaign> = {}): CreditCampaign {
  return { id, recipientScope: "wallet", amount: 200, maxRecipients: null, grantedCount: 0, priority: 10, exclusionGroup: null, eligibility: [], ...overrides }
}
function memoryStore(campaigns: CreditCampaign[]) {
  const grants: GrantRequest[] = []
  const store: CampaignStore = {
    listClaimCampaigns: async () => [...campaigns].sort((a, b) => a.priority - b.priority),
    listRecipientGrants: async (_cluster, userId, wallet) =>
      grants
        .filter((g) => g.userId === userId || (wallet !== null && g.walletAddress === wallet))
        .map((g) => ({ campaignId: g.campaignId, exclusionGroup: campaigns.find((c) => c.id === g.campaignId)?.exclusionGroup ?? null })),
    grant: async (request) => {
      grants.push(request)
      const c = campaigns.find((x) => x.id === request.campaignId)!
      return { status: "granted", campaignId: c.id, amount: request.amount ?? c.amount }
    },
  }
  return { store, grants }
}
function deps(store: CampaignStore, cluster: GrantServiceDeps["cluster"] = "mainnet-beta", chain: FakeChain = {}) {
  const rpc = fakeRpc(chain)
  let signalFactories = 0
  const d: GrantServiceDeps = { cluster, store, signals: () => (signalFactories++, rpc.signals), now: () => NOW }
  return { d, rpc, factories: () => signalFactories }
}

async function claimChecks() {
  console.log("\n── Claim orchestration ──")
  const disabledStore = memoryStore([campaign("mainnet-launch-2026")])
  const disabled = await claimCampaignCredits(user(), deps(disabledStore.store, null).d)
  check("no cluster configured → disabled, nothing granted", disabled.status === "disabled" && disabledStore.grants.length === 0)

  const launch = memoryStore([campaign("mainnet-launch-2026", { amount: 200, maxRecipients: 50, eligibility: [{ type: "wallet_identity" }] })])
  const noWallet = await claimCampaignCredits(user(null), deps(launch.store).d)
  check("wallet campaign without wallet → not_eligible, no grant", noWallet.status === "ok" && noWallet.grants[0]?.reason === "wallet_required" && launch.grants.length === 0)
  const first = await claimCampaignCredits(user(), deps(launch.store).d)
  const sent = launch.grants[0]
  check("eligible wallet → granted 200", first.status === "ok" && first.grants[0]?.status === "granted" && first.grants[0]?.amount === 200)
  check("server fixes mode, amount and cluster (claim, null, mainnet-beta)", sent?.mode === "claim" && sent.amount === null && sent.cluster === "mainnet-beta" && sent.walletAddress === WALLET)
  const second = await claimCampaignCredits(user(), deps(launch.store).d)
  check("repeat claim → already_granted without a new grant", second.status === "ok" && second.grants[0]?.status === "already_granted" && launch.grants.length === 1)

  const capped = memoryStore([campaign("mainnet-capped", { maxRecipients: 50, grantedCount: 50 })])
  const cappedResult = await claimCampaignCredits(user(), deps(capped.store).d)
  check("cap already reached → cap_reached, no grant call", cappedResult.status === "ok" && cappedResult.grants[0]?.status === "cap_reached" && capped.grants.length === 0)

  const ordered = memoryStore([campaign("mainnet-b", { priority: 20 }), campaign("mainnet-a", { priority: 5 })])
  await claimCampaignCredits(user(), deps(ordered.store).d)
  check("campaigns run in priority order", ordered.grants.map((g) => g.campaignId).join() === "mainnet-a,mainnet-b")

  const grouped = memoryStore([
    campaign("mainnet-tier-vip", { priority: 1, exclusionGroup: "launch", amount: 500 }),
    campaign("mainnet-tier-general", { priority: 2, exclusionGroup: "launch" }),
  ])
  const groupedResult = await claimCampaignCredits(user(), deps(grouped.store).d)
  check("exclusion group → first eligible wins, second excluded",
    groupedResult.status === "ok" && groupedResult.grants.map((g) => g.status).join() === "granted,excluded" && grouped.grants.length === 1)

  const gated = memoryStore([campaign("mainnet-holders", { eligibility: [{ type: "min_sol_balance", lamports: 100 }] })])
  const gatedResult = await claimCampaignCredits(user(), deps(gated.store, "mainnet-beta", { lamports: 1 }).d)
  check("not eligible → reason returned, no grant", gatedResult.status === "ok" && gatedResult.grants[0]?.reason === "sol_balance_too_low" && gated.grants.length === 0)

  const plain = memoryStore([campaign("devnet-test-credits", { recipientScope: "user", amount: 1000 })])
  const plainDeps = deps(plain.store, "devnet")
  const devnetResult = await claimCampaignCredits(user(null), plainDeps.d)
  check("devnet user campaign works without a wallet", devnetResult.status === "ok" && devnetResult.grants[0]?.status === "granted" && plain.grants[0]?.cluster === "devnet")
  check("rules without on-chain reads make no RPC calls", plainDeps.rpc.calls.length === 0)

  console.log("\n── Devnet automatic beta-credit claim ──")
  check("auto-claim campaigns are exactly the Devnet test campaign", DEVNET_AUTO_CLAIM_CAMPAIGNS.join() === "devnet-test-credits")
  let listed = 0
  const counting = (store: CampaignStore): CampaignStore => ({ ...store, listClaimCampaigns: async (c, n) => (listed++, store.listClaimCampaigns(c, n)) })
  for (const cluster of ["mainnet-beta", null] as const) {
    const launchLive = memoryStore([campaign("mainnet-launch-2026", { amount: 200, maxRecipients: 50 })])
    listed = 0
    const refused = await claimDevnetBetaCredits(user(), deps(counting(launchLive.store), cluster).d)
    check(`auto-claim on ${cluster ?? "no cluster"} → disabled, campaigns not even read, nothing granted`,
      refused.status === "disabled" && listed === 0 && launchLive.grants.length === 0)
  }
  const devnetAuto = memoryStore([
    campaign("devnet-test-credits", { recipientScope: "user", amount: 1000, maxRecipients: 20 }),
    campaign("devnet-other-claim", { recipientScope: "user", amount: 5, priority: 1 }),
  ])
  const autoFirst = await claimDevnetBetaCredits(user(), deps(devnetAuto.store, "devnet").d)
  check("devnet auto-claim → only devnet-test-credits granted (1,000), other claim campaigns untouched",
    autoFirst.status === "ok" && autoFirst.grants.length === 1 && autoFirst.grants[0]?.campaignId === "devnet-test-credits" &&
    autoFirst.grants[0]?.status === "granted" && autoFirst.grants[0]?.amount === 1000 && devnetAuto.grants.length === 1 && devnetAuto.grants[0]?.mode === "claim")
  const autoAgain = await claimDevnetBetaCredits(user(), deps(devnetAuto.store, "devnet").d)
  check("repeat auto-claim (reload / re-login) → already_granted, no new grant",
    autoAgain.status === "ok" && autoAgain.grants[0]?.status === "already_granted" && devnetAuto.grants.length === 1)
  const fullDevnet = memoryStore([campaign("devnet-test-credits", { recipientScope: "user", maxRecipients: 20, grantedCount: 20 })])
  const autoCapped = await claimDevnetBetaCredits(user(), deps(fullDevnet.store, "devnet").d)
  check("devnet campaign cap reached → cap_reached, no grant", autoCapped.status === "ok" && autoCapped.grants[0]?.status === "cap_reached" && fullDevnet.grants.length === 0)

  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const provider = readFileSync(join(root, "src/components/providers/AuthSessionProvider.tsx"), "utf8")
  const route = readFileSync(join(root, "src/app/api/credits/claim/devnet-beta/route.ts"), "utf8")
  check("client calls only the Devnet route, and only when the cluster is devnet",
    provider.includes('fetch("/api/credits/claim/devnet-beta"') && !/["'`]\/api\/credits\/claim["'`]/.test(provider) && provider.includes('getSolanaCluster() !== "devnet"'))
  check("Devnet route uses claimDevnetBetaCredits (server-side cluster guard), not the generic claim",
    /claimDevnetBetaCredits\(authUser\b/.test(route) && !route.includes("claimCampaignCredits"))

  console.log("\n── Devnet automatic claim after the QLC cutover (500 on-chain QLC per wallet) ──")
  check("QLC-mode auto-claim campaigns are exactly devnet-open-qlc; credits mode keeps devnet-test-credits",
    devnetAutoClaimCampaigns("qlc").join() === "devnet-open-qlc" && devnetAutoClaimCampaigns("credits").join() === "devnet-test-credits")
  const qlcCampaigns = () => {
    const store = memoryStore([
      campaign("devnet-open-qlc", { recipientScope: "wallet", amount: 500, maxRecipients: null, eligibility: [{ type: "wallet_identity" }] }),
      campaign("devnet-test-credits", { recipientScope: "user", amount: 1000, maxRecipients: 20 }),
    ])
    const grant = store.store.grant
    store.store.grant = async (request) => ({ ...(await grant(request)), deliveryId: `delivery-for-${request.walletAddress}` })
    return store
  }
  const qlcOpen = qlcCampaigns()
  const qlcFirst = await claimDevnetBetaCredits(user(), deps(qlcOpen.store, "devnet").d, "qlc")
  check("QLC mode: only devnet-open-qlc is claimed (500), with its on-chain delivery id; the credit campaign is untouched",
    qlcFirst.status === "ok" && qlcFirst.grants.length === 1 && qlcFirst.grants[0]?.campaignId === "devnet-open-qlc" &&
    qlcFirst.grants[0]?.amount === 500 && qlcFirst.grants[0]?.deliveryId === `delivery-for-${WALLET}` && qlcOpen.grants[0]?.walletAddress === WALLET)
  const qlcAgain = await claimDevnetBetaCredits(user(), deps(qlcOpen.store, "devnet").d, "qlc")
  check("QLC mode: reload / re-login → already_granted, no second grant", qlcAgain.grants[0]?.status === "already_granted" && qlcOpen.grants.length === 1)
  const otherWallet = await claimDevnetBetaCredits({ ...user(OTHER_WALLET), id: "0b9c2c1e-6c3f-4d55-9d1e-2b8f4a0d9c22" }, deps(qlcOpen.store, "devnet").d, "qlc")
  check("QLC mode: a different wallet is granted normally (open-wallet testing, no allowlist)", otherWallet.grants[0]?.status === "granted" && qlcOpen.grants.length === 2)
  const noWalletQlc = await claimDevnetBetaCredits(user(null), deps(qlcCampaigns().store, "devnet").d, "qlc")
  check("QLC mode: no wallet → not eligible (QLC is delivered to a wallet)", noWalletQlc.grants[0]?.reason === "wallet_required")
  listed = 0
  const qlcMainnet = await claimDevnetBetaCredits(user(), deps(counting(qlcCampaigns().store), "mainnet-beta").d, "qlc")
  check("QLC mode on mainnet → disabled, nothing read or granted", qlcMainnet.status === "disabled" && listed === 0)

  console.log("\n── Operator grants ──")
  const manual = memoryStore([campaign("mainnet-manual-grants", { recipientScope: "grant_key", amount: 10000 })])
  const input = { campaignId: "mainnet-manual-grants", userId: user().id, amount: 300, grantKey: "bug-bounty-42", reason: "Bug bounty #42", operator: " piximan " }
  const outcome = await grantManualCredits(input, deps(manual.store).d)
  const req = manual.grants[0]
  check("manual grant → manual mode, operator recorded, key and amount passed",
    outcome.status === "granted" && req?.mode === "manual" && req.grantedBy === "operator:piximan" && req.grantKey === "bug-bounty-42" && req.amount === 300)
  const noCluster = await grantManualCredits(input, deps(manual.store, null).d).then(() => "granted", (e: Error) => e.message)
  check("manual grant without cluster config → refused", /NEXT_PUBLIC_SOLANA_CLUSTER/.test(noCluster))
  const noOperator = await grantManualCredits({ ...input, operator: "  " }, deps(manual.store).d).then(() => "granted", (e: Error) => e.message)
  check("manual grant without operator → refused", noOperator === "operator is required")
}

// ── Supabase store adapter ───────────────────────────────────────────────────
function fakeSupabase(rows: Record<string, unknown>[]) {
  const log: { table?: string; filters: string[]; rpc?: { fn: string; args: Record<string, unknown> } } = { filters: [] }
  const builder = {
    select: (cols: string) => (log.filters.push(`select:${cols}`), builder),
    eq: (col: string, val: unknown) => (log.filters.push(`eq:${col}=${val}`), builder),
    or: (expr: string) => (log.filters.push(`or:${expr}`), builder),
    order: (col: string) => (log.filters.push(`order:${col}`), builder),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
  }
  const client = {
    from: (table: string) => ((log.table = table), builder),
    rpc: async (fn: string, args: Record<string, unknown>) => ((log.rpc = { fn, args }), { data: { status: "granted", campaignId: args.p_campaign_id }, error: null }),
  }
  return { client: client as unknown as SupabaseClient, log }
}

async function storeChecks() {
  console.log("\n── Supabase store adapter ──")
  const rows = [
    { id: "open", recipient_scope: "wallet", amount: 200, max_recipients: 50, granted_count: 3, priority: 10, exclusion_group: null, eligibility: [], starts_at: null, ends_at: null },
    { id: "future", recipient_scope: "wallet", amount: 1, max_recipients: null, granted_count: 0, priority: 11, exclusion_group: null, eligibility: [], starts_at: "2026-11-01T00:00:00Z", ends_at: null },
    { id: "ended", recipient_scope: "wallet", amount: 1, max_recipients: null, granted_count: 0, priority: 12, exclusion_group: null, eligibility: [], starts_at: null, ends_at: "2026-10-01T00:00:00Z" },
  ]
  const listing = fakeSupabase(rows)
  const campaigns = await createSupabaseCampaignStore(listing.client).listClaimCampaigns("mainnet-beta", NOW)
  check("claim campaigns: cluster, claim mode, active only, priority order",
    ["eq:cluster=mainnet-beta", "eq:grant_mode=claim", "eq:is_active=true", "order:priority"].every((f) => listing.log.filters.includes(f)))
  check("claim campaigns: closed time windows filtered out", campaigns.map((c) => c.id).join() === "open" && campaigns[0].maxRecipients === 50)

  const grantsQuery = fakeSupabase([{ campaign_id: "open", credit_campaigns: { exclusion_group: "launch" } }])
  const prior = await createSupabaseCampaignStore(grantsQuery.client).listRecipientGrants("mainnet-beta", user().id, WALLET)
  check("recipient grants filtered by user or wallet", grantsQuery.log.filters.includes(`or:user_id.eq.${user().id},wallet_address.eq.${WALLET}`) && prior[0]?.exclusionGroup === "launch")
  const injected = fakeSupabase([])
  await createSupabaseCampaignStore(injected.client).listRecipientGrants("mainnet-beta", user().id, "x,user_id.neq.0")
  check("malformed wallet never reaches the filter", injected.log.filters.includes(`or:user_id.eq.${user().id}`))
  const badUser = await createSupabaseCampaignStore(fakeSupabase([]).client).listRecipientGrants("mainnet-beta", "1,id.neq.0", null).then(() => "ok", () => "refused")
  check("malformed user id refused", badUser === "refused")

  const rpc = fakeSupabase([])
  await createSupabaseCampaignStore(rpc.client).grant({ campaignId: "open", cluster: "devnet", mode: "claim", userId: user().id, walletAddress: WALLET, grantKey: null, amount: null, reason: "claimed", grantedBy: "claim" })
  const args = rpc.log.rpc?.args ?? {}
  check("grant maps to grant_campaign_credits with all parameters",
    rpc.log.rpc?.fn === "grant_campaign_credits" && args.p_cluster === "devnet" && args.p_grant_mode === "claim" && args.p_amount === null && Object.keys(args).length === 9)

  console.log("\n── Cluster configuration ──")
  check("cluster parsing is strict", parseSolanaCluster("devnet") === "devnet" && parseSolanaCluster("mainnet-beta") === "mainnet-beta" &&
    parseSolanaCluster(undefined) === null && parseSolanaCluster("mainnet") === null && parseSolanaCluster("testnet") === null)
}

eligibilityChecks()
  .then(claimChecks)
  .then(storeChecks)
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
