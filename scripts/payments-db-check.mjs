// Database checks for supabase/proposed/20261002000002_qlc_payments.sql against a throwaway local
// Postgres (never a Supabase project). Two schemas are tested:
//   1. the verified dev-project schema (supabase/snapshots/dev-credit-schema-2026-10-02.sql) with the
//      applied credit-campaign migration and devnet campaigns, i.e. the state of qcggkvubogqlmxcepvbr;
//   2. the repo migrations (a fresh project).
// Each applies the payment migration and the configuration files, asserts settlement, the delivery
// queue, replay protection, privileges and isolation from database credits and campaigns, then runs
// the rollback and re-applies.
//
// Needs `pg` and `embedded-postgres`, which are not project dependencies:
//   npm install --prefix /tmp/payments-db-check pg embedded-postgres
//   node scripts/payments-db-check.mjs /tmp/payments-db-check
import { createRequire } from "node:module"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash, randomInt, randomUUID } from "node:crypto"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const modulesDir = resolve(process.argv[2] ?? repo)
const require = createRequire(join(modulesDir, "package.json"))
const pg = require("pg")
const { default: EmbeddedPostgres } = await import(pathToFileURL(join(modulesDir, "node_modules/embedded-postgres/dist/index.js")).href)

const sql = (rel) => readFileSync(join(repo, rel), "utf8")
let failures = 0
function check(name, ok, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const address = () => Array.from({ length: 44 }, () => B58[randomInt(B58.length)]).join("")
const signature = () => Array.from({ length: 88 }, () => B58[randomInt(B58.length)]).join("")
const sha256hex = (text) => createHash("sha256").update(text, "utf8").digest("hex")

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const TREASURY = "AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw"
const TREASURY_USDC = "F9ANqX1VDe77hE8BQssPWADRSPejTqkkMz7uw39Az8iX"

const dataDir = mkdtempSync(join(tmpdir(), "payments-db-check-"))
const port = 55000 + randomInt(4000)
const server = new EmbeddedPostgres({ databaseDir: dataDir, port, user: "postgres", password: "postgres", persistent: false, onLog: () => {} })
await server.initialise()
await server.start()
const pools = []
let pool
async function useDatabase(name) {
  await server.createDatabase(name)
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: name, max: 40 })
  pool.on("error", () => {})
  pools.push(pool)
}
const q = (text, params) => pool.query(text, params)
const SUPABASE_STUBS = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB DEFAULT '{}'::jsonb);
  CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
`

async function asRole(role, text, params, sub) {
  const c = await pool.connect()
  try {
    await c.query(`SET ROLE ${role}`)
    if (sub) await c.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [sub])
    return await c.query(text, params)
  } finally {
    await c.query("RESET ROLE; RESET ALL").catch(() => {})
    c.release()
  }
}
async function denied(role, text, params, sub) {
  try { await asRole(role, text, params, sub); return false } catch (e) { return /permission denied/.test(e.message) }
}
async function fails(text, params) {
  try { await q(text, params); return false } catch { return true }
}
async function newUser() {
  const id = randomUUID()
  await q("INSERT INTO auth.users (id, raw_user_meta_data) VALUES ($1, '{}')", [id])
  return id
}
const one = async (text, params) => (await q(text, params)).rows[0]

/** Inserts a quote as the server would (service_role). */
async function newIntent(userId, overrides = {}) {
  const i = {
    wallet: address(), cluster: "devnet", packId: "devnet-1500", qlc: "150000", usd: "12990000",
    assetId: "devnet-usdc", symbol: "USDC", kind: "spl-token", mint: USDC, tokenProgram: TOKEN_PROGRAM, decimals: 6,
    amount: "12990000", treasury: TREASURY, destination: TREASURY_USDC, reference: address(),
    expiresAt: new Date(Date.now() + 15 * 60000), ...overrides,
  }
  const { rows } = await asRole("service_role", `
    INSERT INTO public.payment_intents
      (user_id, wallet_address, cluster, pack_id, qlc_amount, usd_value_micros, payment_asset_id, payment_asset_symbol,
       payment_asset_kind, payment_mint, payment_token_program, payment_decimals, payment_amount, treasury_address,
       destination_account, price_source, price_snapshot, quoted_at, expires_at, reference)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'usd-peg', '{"price": "1"}', NOW(), $16, $17)
    RETURNING id`,
    [userId, i.wallet, i.cluster, i.packId, i.qlc, i.usd, i.assetId, i.symbol, i.kind, i.mint, i.tokenProgram, i.decimals,
     i.amount, i.treasury, i.destination, i.expiresAt, i.reference])
  return { ...i, id: rows[0].id, userId }
}

const SETTLE = "SELECT public.settle_payment_intent($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS r"
async function settle(intent, overrides = {}) {
  const p = {
    intentId: intent.id, userId: intent.userId, cluster: intent.cluster, sig: intent.sig ?? signature(), payer: intent.wallet,
    mint: intent.mint, treasury: intent.treasury, destination: intent.destination, amount: intent.amount, reference: intent.reference,
    slot: 4242, blockTime: new Date(), ...overrides,
  }
  const { rows } = await asRole("service_role", SETTLE,
    [p.intentId, p.userId, p.cluster, p.sig, p.payer, p.mint, p.treasury, p.destination, p.amount, p.reference, p.slot, p.blockTime])
  return { ...rows[0].r, sig: p.sig }
}
const deliveriesFor = async (userId) => (await q("SELECT * FROM public.qlc_deliveries WHERE user_id = $1 ORDER BY created_at", [userId])).rows

async function paymentSuite(label) {
  // ── Configuration ──
  await q(sql("supabase/payment-assets/devnet.sql"))
  await q(sql("supabase/pricing/devnet.sql"))
  const assets = (await q("SELECT id, symbol, kind, is_enabled FROM public.payment_assets ORDER BY sort_order")).rows
  check(`${label}: devnet assets: USDC and SOL enabled (both owner-approved)`, assets.map((a) => `${a.symbol}:${a.kind}:${a.is_enabled}`).join() === "USDC:spl-token:true,SOL:native-sol:true", JSON.stringify(assets))
  const packs = (await q("SELECT qlc_amount::text AS qlc, usd_value_micros::text AS usd FROM public.qlc_price_packs WHERE cluster = 'devnet' ORDER BY sort_order")).rows
  check(`${label}: devnet packs mirror the top-ups (1 credit = 1 QLC) with canonical USD values`,
    packs.map((p) => `${p.qlc}=${p.usd}`).join() === "50000=4990000,150000=12990000,500000=37990000,1000000=99990000")
  await q("UPDATE public.qlc_price_packs SET usd_value_micros = 4490000 WHERE id = 'devnet-500'")
  await q(sql("supabase/pricing/devnet.sql"))
  await q(sql("supabase/payment-assets/devnet.sql"))
  check(`${label}: re-running configuration files keeps operator edits and adds no duplicates`,
    (await one("SELECT usd_value_micros::int AS u FROM public.qlc_price_packs WHERE id = 'devnet-500'")).u === 4490000 &&
    (await one("SELECT count(*)::int AS n FROM public.qlc_price_packs")).n === 4 && (await one("SELECT count(*)::int AS n FROM public.payment_assets")).n === 2)
  await q(sql("supabase/pricing/mainnet.sql"))
  check(`${label}: mainnet pricing template inserts only inactive packs`, (await one("SELECT count(*)::int AS n FROM public.qlc_price_packs WHERE cluster = 'mainnet-beta' AND is_active")).n === 0)

  const assetInsert = `INSERT INTO public.payment_assets (id, cluster, symbol, kind, mint, token_program, decimals, treasury_address, price_source, quote_ttl_secs, is_enabled, approved_by, approved_at)
                       VALUES ($1, 'devnet', $2, $3, $4, $5, $6, $7, '{"kind": "usd-peg"}', 300, $8, $9, $10)`
  check(`${label}: assets: an asset cannot be enabled without approval`, await fails(assetInsert, ["p1", "PRT", "spl-token", address(), TOKEN_PROGRAM, 6, TREASURY, true, null, null]))
  check(`${label}: assets: enabled SPL asset needs mint and token program`, await fails(assetInsert, ["p2", "PRT", "spl-token", null, null, 6, TREASURY, true, "PixiMan", new Date()]))
  check(`${label}: assets: native SOL must have no mint and 9 decimals`, await fails(assetInsert, ["p3", "SOL2", "native-sol", address(), null, 9, TREASURY, false, null, null]) && await fails(assetInsert, ["p4", "SOL2", "native-sol", null, null, 6, TREASURY, false, null, null]))
  check(`${label}: assets: unknown token program rejected`, await fails(assetInsert, ["p5", "PRT", "spl-token", address(), address(), 6, TREASURY, false, null, null]))
  check(`${label}: assets: one asset per mint per cluster`, await fails(assetInsert, ["p6", "USDC2", "spl-token", USDC, TOKEN_PROGRAM, 6, TREASURY, false, null, null]))
  await q(assetInsert, ["devnet-partner", "PRT", "spl-token", address(), TOKEN_PROGRAM, 6, TREASURY, false, null, null])
  check(`${label}: assets: a partner token can be configured, disabled by default`, (await one("SELECT is_enabled FROM public.payment_assets WHERE id = 'devnet-partner'")).is_enabled === false)

  const packInsert = "INSERT INTO public.qlc_price_packs (id, cluster, qlc_amount, usd_value_micros, list_usd_value_micros, label) VALUES ($1, 'devnet', $2, $3, $4, 'x')"
  check(`${label}: packs: QLC amount must be on the 0.05 step`, await fails(packInsert, ["bad-1", 101, 1, null]) && await fails(packInsert, ["bad-2", 0, 1, null]))
  check(`${label}: packs: USD value positive, list value above it`, await fails(packInsert, ["bad-3", 5, 0, null]) && await fails(packInsert, ["bad-4", 5, 100, 100]))

  // ── Privileges ──
  const alice = await newUser()
  const bob = await newUser()
  const aliceIntent = await newIntent(alice)
  await newIntent(bob)
  check(`${label}: clients cannot read payment configuration`, await denied("anon", "SELECT * FROM public.payment_assets") && await denied("authenticated", "SELECT * FROM public.qlc_price_packs", [], alice))
  check(`${label}: clients cannot write configuration, quotes or deliveries`,
    await denied("authenticated", "UPDATE public.payment_assets SET is_enabled = true", [], alice) &&
    await denied("authenticated", "UPDATE public.payment_intents SET payment_amount = 1", [], alice) &&
    await denied("authenticated", "INSERT INTO public.qlc_deliveries (delivery_key, delivery_id_hex, source_type, source_id, kind, wallet_address, cluster, qlc_amount) VALUES ('k', $1, 'grant', 'x', 'grant', $2, 'devnet', 5)", [sha256hex("k"), address()], alice) &&
    await denied("authenticated", "DELETE FROM public.qlc_deliveries", [], alice))
  const own = (await asRole("authenticated", "SELECT id FROM public.payment_intents", [], alice)).rows
  check(`${label}: a member reads only their own quotes`, own.length === 1 && own[0].id === aliceIntent.id)
  check(`${label}: clients cannot execute settlement or delivery functions`,
    await denied("anon", SETTLE, [aliceIntent.id, alice, "devnet", signature(), aliceIntent.wallet, USDC, TREASURY, TREASURY_USDC, "12990000", aliceIntent.reference, 1, new Date()]) &&
    await denied("authenticated", SETTLE, [aliceIntent.id, alice, "devnet", signature(), aliceIntent.wallet, USDC, TREASURY, TREASURY_USDC, "12990000", aliceIntent.reference, 1, new Date()], alice) &&
    await denied("authenticated", "SELECT public.record_qlc_delivery_attempt($1, 'x')", [randomUUID()], alice))

  // ── Settlement ──
  const before = await one(`SELECT (SELECT coalesce(sum(credits), 0)::bigint FROM public.profiles) AS credits,
    (SELECT count(*)::int FROM public.credit_transactions) AS ledger,
    (SELECT coalesce(sum(granted_count), 0)::int FROM public.credit_campaigns) AS slots`)
  const paid = await settle(aliceIntent)
  const intentRow = await one("SELECT status, tx_signature, tx_slot, tx_block_time, paid_at, delivery_id FROM public.payment_intents WHERE id = $1", [aliceIntent.id])
  const [delivery] = await deliveriesFor(alice)
  check(`${label}: verified payment → quote paid and exactly one QLC delivery enqueued`,
    paid.status === "paid" && paid.deliveryId === delivery?.id && intentRow.status === "paid" && intentRow.tx_signature === paid.sig && intentRow.delivery_id === delivery.id, JSON.stringify(paid))
  check(`${label}: delivery row: purchase of 1,500.00 QLC to the payer, key and on-chain id derived from the quote`,
    delivery.delivery_key === `payment:${aliceIntent.id}` && delivery.delivery_id_hex === sha256hex(`payment:${aliceIntent.id}`) &&
    delivery.kind === "purchase" && delivery.source_type === "payment" && Number(delivery.qlc_amount) === 150000 &&
    delivery.wallet_address === aliceIntent.wallet && delivery.status === "pending")
  const after = await one(`SELECT (SELECT coalesce(sum(credits), 0)::bigint FROM public.profiles) AS credits,
    (SELECT count(*)::int FROM public.credit_transactions) AS ledger,
    (SELECT coalesce(sum(granted_count), 0)::int FROM public.credit_campaigns) AS slots`)
  check(`${label}: settlement never touches database credits, the credit ledger or campaign slots`,
    String(after.credits) === String(before.credits) && after.ledger === before.ledger && after.slots === before.slots, JSON.stringify({ before, after }))

  const repeat = await settle({ ...aliceIntent, sig: paid.sig })
  check(`${label}: repeating the same settlement → already_paid with the same delivery, nothing added`,
    repeat.status === "already_paid" && repeat.deliveryId === paid.deliveryId && (await deliveriesFor(alice)).length === 1)
  check(`${label}: another signature on a paid quote → intent_already_paid`, (await settle(aliceIntent)).status === "intent_already_paid")
  const second = await newIntent(alice)
  check(`${label}: a used signature cannot pay another quote`, (await settle({ ...second, sig: paid.sig })).status === "signature_used" && (await deliveriesFor(alice)).length === 1)

  const carolIntent = await newIntent(bob)
  const mismatches = [
    ["cluster", { cluster: "mainnet-beta" }, "cluster_mismatch"],
    ["payer", { payer: address() }, "payer_mismatch"],
    ["asset (mint)", { mint: address() }, "asset_mismatch"],
    ["asset (SOL instead of USDC)", { mint: null }, "asset_mismatch"],
    ["treasury", { treasury: address() }, "destination_mismatch"],
    ["destination account", { destination: address() }, "destination_mismatch"],
    ["amount (one base unit short)", { amount: "12989999" }, "amount_mismatch"],
    ["reference", { reference: address() }, "reference_mismatch"],
    ["owner", { userId: alice }, "unknown_intent"],
    ["intent id", { intentId: randomUUID() }, "unknown_intent"],
    ["signature format", { sig: "not-a-signature" }, "invalid_request"],
    ["missing block time", { blockTime: null }, "invalid_request"],
  ]
  for (const [what, overrides, status] of mismatches) {
    const r = await settle(carolIntent, overrides)
    check(`${label}: wrong ${what} → ${status}, nothing enqueued`, r.status === status, JSON.stringify(r))
  }
  check(`${label}: after all mismatches the quote is pending and no delivery exists`,
    (await one("SELECT status FROM public.payment_intents WHERE id = $1", [carolIntent.id])).status === "pending" && (await deliveriesFor(bob)).length === 0)

  const solIntent = await newIntent(bob, { assetId: "devnet-sol", symbol: "SOL", kind: "native-sol", mint: null, tokenProgram: null, decimals: 9, amount: "40960424", destination: TREASURY, packId: "devnet-500", qlc: "50000", usd: "4990000" })
  const solPaid = await settle(solIntent)
  check(`${label}: SOL payment settles through the same function (no mint)`, solPaid.status === "paid" && Number((await deliveriesFor(bob))[0].qlc_amount) === 50000)

  const expiring = await newIntent(bob, { expiresAt: new Date(Date.now() - 60000) })
  check(`${label}: payment that landed after expiry → expired`, (await settle(expiring, { blockTime: new Date() })).status === "expired")
  check(`${label}: payment that landed before expiry settles even when verified later`, (await settle(expiring, { blockTime: new Date(Date.now() - 120000) })).status === "paid")
  check(`${label}: a paid quote cannot exist without signature and delivery (status constraint)`,
    await fails("UPDATE public.payment_intents SET status = 'paid' WHERE id = $1", [second.id]))

  // ── Recovery: closing unpaid quotes ── (the statement src/lib/payments/paymentEngine.ts closeExpiredIntent runs)
  const CLOSE = "UPDATE public.payment_intents SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at < $2 RETURNING id"
  const cutoff = () => new Date(Date.now() - 5 * 60000)
  const stale = await newIntent(bob, { expiresAt: new Date(Date.now() - 10 * 60000) })
  const open = await newIntent(bob)
  check(`${label}: recovery closes an unpaid quote past expiry + grace, not an open one`,
    (await asRole("service_role", CLOSE, [stale.id, cutoff()])).rowCount === 1 && (await asRole("service_role", CLOSE, [open.id, cutoff()])).rowCount === 0 &&
    (await one("SELECT status FROM public.payment_intents WHERE id = $1", [stale.id])).status === "expired")
  check(`${label}: a paid quote is never closed`, (await asRole("service_role", CLOSE, [expiring.id, new Date()])).rowCount === 0 &&
    (await one("SELECT status FROM public.payment_intents WHERE id = $1", [expiring.id])).status === "paid")
  check(`${label}: an expired quote cannot carry a payment (status constraint)`,
    await fails("UPDATE public.payment_intents SET tx_signature = $2, paid_at = NOW() WHERE id = $1", [stale.id, signature()]))
  check(`${label}: closed quote: a payment that landed after expiry is still refused`, (await settle(stale, { blockTime: new Date() })).status === "expired")
  const latePaid = await settle(stale, { blockTime: new Date(Date.now() - 11 * 60000) })
  check(`${label}: closed quote: a payment that landed before expiry still settles and enqueues its delivery`,
    latePaid.status === "paid" && (await one("SELECT status, delivery_id FROM public.payment_intents WHERE id = $1", [stale.id])).delivery_id === latePaid.deliveryId)
  check(`${label}: recovery indexes exist`,
    (await one("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('payment_intents_pending_idx', 'qlc_deliveries_due_idx')")).n === 2)

  // ── Delivery queue ──
  const [pending] = await deliveriesFor(alice)
  await asRole("service_role", "SELECT public.record_qlc_delivery_attempt($1, 'rpc timeout')", [pending.id])
  const attempted = await one("SELECT attempts, last_error, extract(epoch FROM next_attempt_at - last_attempt_at)::int AS delay FROM public.qlc_deliveries WHERE id = $1", [pending.id])
  check(`${label}: failed attempts are recorded on pending deliveries`, attempted.attempts === 1 && attempted.last_error === "rpc timeout")
  check(`${label}: first failed attempt → retry in 1 minute`, attempted.delay === 60, String(attempted.delay))
  // The due-delivery listing src/lib/payments/qlcDeliveries.ts listDueDeliveries runs.
  const DUE = "SELECT id FROM public.qlc_deliveries WHERE cluster = 'devnet' AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY next_attempt_at NULLS FIRST"
  const dueIds = (await asRole("service_role", DUE)).rows.map((r) => r.id)
  const fresh = (await deliveriesFor(bob)).find((d) => d.status === "pending" && d.attempts === 0)
  check(`${label}: recovery lists never-attempted deliveries, not ones waiting for their retry time`,
    !!fresh && dueIds.includes(fresh.id) && !dueIds.includes(pending.id))
  const delays = []
  for (let n = 0; n < 8; n++) {
    await asRole("service_role", "SELECT public.record_qlc_delivery_attempt($1, 'rpc timeout')", [fresh.id])
    delays.push((await one("SELECT extract(epoch FROM next_attempt_at - last_attempt_at)::int AS d FROM public.qlc_deliveries WHERE id = $1", [fresh.id])).d)
  }
  check(`${label}: retry backoff doubles from 1 minute and is capped at 1 hour`, delays.join(",") === "60,120,240,480,960,1920,3600,3600", delays.join(","))
  await q("UPDATE public.qlc_deliveries SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1", [fresh.id])
  check(`${label}: a delivery is listed again once its retry time has come`, (await asRole("service_role", DUE)).rows.some((r) => r.id === fresh.id))
  check(`${label}: delivered rows need a vault + minted split equal to the amount`,
    await fails("UPDATE public.qlc_deliveries SET status = 'delivered', delivered_at = NOW(), from_vault = 1, minted = 1 WHERE id = $1", [pending.id]))
  await q("UPDATE public.qlc_deliveries SET status = 'delivered', delivered_at = NOW(), from_vault = 100000, minted = 50000, tx_signature = $2 WHERE id = $1", [pending.id, signature()])
  await asRole("service_role", "SELECT public.record_qlc_delivery_attempt($1, 'late')", [pending.id])
  check(`${label}: attempts are not recorded once delivered`, (await one("SELECT attempts FROM public.qlc_deliveries WHERE id = $1", [pending.id])).attempts === 1)
  check(`${label}: the on-chain id must be sha256 of the key`,
    await fails("INSERT INTO public.qlc_deliveries (delivery_key, delivery_id_hex, source_type, source_id, kind, wallet_address, cluster, qlc_amount) VALUES ('grant:x', $1, 'grant', 'x', 'grant', $2, 'devnet', 5)", ["0".repeat(64), address()]))
  check(`${label}: a delivery key can be enqueued only once`,
    await fails("INSERT INTO public.qlc_deliveries (delivery_key, delivery_id_hex, source_type, source_id, kind, wallet_address, cluster, qlc_amount) VALUES ($1, $2, 'payment', 'x', 'purchase', $3, 'devnet', 5)", [pending.delivery_key, pending.delivery_id_hex, address()]))

  // ── Concurrency ──
  const dave = await newUser()
  const raced = await newIntent(dave)
  const raceSig = signature()
  const results = await Promise.all(Array.from({ length: 20 }, () => settle({ ...raced, sig: raceSig })))
  const tally = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})
  check(`${label}: 20 concurrent settlements of one payment → one delivery`, tally.paid === 1 && tally.already_paid === 19 && (await deliveriesFor(dave)).length === 1, JSON.stringify(tally))
  const a = await newIntent(dave)
  const b = await newIntent(dave)
  const shared = signature()
  const pair = await Promise.all([settle({ ...a, sig: shared }), settle({ ...b, sig: shared })])
  check(`${label}: one signature presented for two quotes at once → only one is paid`,
    pair.filter((r) => r.status === "paid").length === 1 && pair.filter((r) => r.status === "signature_used").length === 1 && (await deliveriesFor(dave)).length === 2,
    pair.map((r) => r.status).join())

  // ── Audit ──
  await q("DELETE FROM auth.users WHERE id = $1", [dave]).catch(() => {})
  await q("DELETE FROM public.profiles WHERE id = $1", [dave])
  const kept = await one("SELECT (SELECT count(*)::int FROM public.payment_intents WHERE tx_signature IN ($1, $2) AND user_id IS NULL) AS intents, (SELECT count(*)::int FROM public.qlc_deliveries WHERE wallet_address IN ($3, $4, $5) AND user_id IS NULL) AS deliveries", [raceSig, shared, raced.wallet, a.wallet, b.wallet])
  check(`${label}: quotes and deliveries survive profile deletion (user unlinked)`, kept.intents === 2 && kept.deliveries === 2, JSON.stringify(kept))

  // ── Rollback ──
  await q(sql("supabase/rollbacks/20261002000002_qlc_payments.sql"))
  const left = (await one("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('payment_assets', 'qlc_price_packs', 'payment_intents', 'qlc_deliveries')")).n
  const fns = (await one("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('settle_payment_intent', 'record_qlc_delivery_attempt')")).n
  check(`${label}: rollback removes tables and functions`, left === 0 && fns === 0)
  await q(sql("supabase/proposed/20261002000002_qlc_payments.sql"))
  check(`${label}: migration re-applies cleanly after rollback`, (await one("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('payment_assets', 'qlc_price_packs', 'payment_intents', 'qlc_deliveries')")).n === 4)
}

try {
  await useDatabase("dev_snapshot")
  await q(SUPABASE_STUBS)
  await q(sql("supabase/snapshots/dev-credit-schema-2026-10-02.sql"))
  await q(sql("supabase/proposed/20261002000001_credit_campaigns.sql"))
  await q(sql("supabase/campaigns/devnet.sql"))
  console.log("════ Suite 1: dev project (snapshot + applied credit migration + devnet campaigns) ════")
  await q(sql("supabase/proposed/20261002000002_qlc_payments.sql"))
  await paymentSuite("dev")

  await useDatabase("repo_schema")
  await q(SUPABASE_STUBS)
  for (const m of ["20260506000001_initial_schema.sql", "20260506000002_nextauth.sql", "20260511000001_explore.sql", "20260511000002_leaderboard.sql"]) {
    await q(sql(`supabase/migrations/${m}`))
  }
  await q(sql("supabase/proposed/20261002000001_credit_campaigns.sql"))
  console.log("\n════ Suite 2: repo migrations + credit migration ════")
  await q(sql("supabase/proposed/20261002000002_qlc_payments.sql"))
  await paymentSuite("repo")
} catch (err) {
  failures++
  console.error("ERROR", err)
} finally {
  for (const p of pools) await p.end().catch(() => {})
  await server.stop().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
