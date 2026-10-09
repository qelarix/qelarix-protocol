// Database checks for supabase/proposed/20261006000001_qlc_generation_billing.sql against a throwaway
// local Postgres (never a Supabase project), on the verified dev-project schema
// (supabase/snapshots/dev-credit-schema-2026-10-02.sql + credit campaigns + QLC payments):
//   - the 15,000.00 QLC test epoch under real concurrency (row lock): never exceeded, paused for
//     everyone by the first request that does not fit, no automatic reset, owner reopen with history;
//   - charge lifecycle compare-and-sets (idempotent), refunds never reopening the budget, only charges
//     that never landed releasing their reservation, per-wallet sequence numbers;
//   - the QLC campaign payout (500 QLC once per wallet as an exactly-once delivery; profiles.credits untouched);
//   - server-only privileges (RLS, no anon/authenticated access);
//   - rollback restores the previous grant function, and the migration re-applies.
//
// Needs `pg` and `embedded-postgres`, which are not project dependencies:
//   npm install --prefix /tmp/qlc-billing-db-check pg embedded-postgres
//   node scripts/qlc-billing-db-check.mjs /tmp/qlc-billing-db-check
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
const sha256hex = (text) => createHash("sha256").update(text, "utf8").digest("hex")
const LIMIT = 1_500_000 // 15,000.00 QLC

const dataDir = mkdtempSync(join(tmpdir(), "qlc-billing-db-check-"))
const port = 55000 + randomInt(4000)
const server = new EmbeddedPostgres({ databaseDir: dataDir, port, user: "postgres", password: "postgres", persistent: false, onLog: () => {} })
await server.initialise()
await server.start()
await server.createDatabase("dev_snapshot")
const pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "dev_snapshot", max: 40 })
pool.on("error", () => {})
const q = (text, params) => pool.query(text, params)
const one = async (text, params) => (await q(text, params)).rows[0]

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

async function asRole(role, text, params) {
  const c = await pool.connect()
  try {
    await c.query(`SET ROLE ${role}`)
    return await c.query(text, params)
  } finally {
    await c.query("RESET ROLE; RESET ALL").catch(() => {})
    c.release()
  }
}
async function denied(role, text, params) {
  try { await asRole(role, text, params); return false } catch (e) { return /permission denied/.test(e.message) }
}
async function newUser() {
  const id = randomUUID()
  await q("INSERT INTO auth.users (id, raw_user_meta_data) VALUES ($1, '{}')", [id])
  return id
}
const svc = async (text, params) => (await asRole("service_role", text, params)).rows[0]
const reserve = (generationId, userId, wallet, amount, minSeq = 1) =>
  svc("SELECT public.reserve_qlc_generation_charge($1, 'devnet', $2, $3, $4, $5) AS r", [generationId, userId, wallet, amount, minSeq]).then((row) => row.r)
const fn = (name, ...args) => svc(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args).then((row) => row.r)
const epochs = async () => (await q("SELECT id, status, limit_amount::bigint AS limit, reserved_amount::bigint AS reserved, released_amount::bigint AS released, refunded_amount::bigint AS refunded, reservations, pause_reason, rejected_amount::bigint AS rejected FROM public.qlc_generation_epochs ORDER BY id")).rows
const current = async () => (await epochs()).at(-1)
const charge = (generationId) => one("SELECT * FROM public.qlc_charges WHERE generation_id = $1", [generationId])
const openEpoch = (key, limit = LIMIT) => fn("open_qlc_generation_epoch", "devnet", limit, "owner-cli", "Devnet test cycle", key)

try {
  await q(SUPABASE_STUBS)
  await q(sql("supabase/snapshots/dev-credit-schema-2026-10-02.sql"))
  await q(sql("supabase/proposed/20261002000001_credit_campaigns.sql"))
  await q(sql("supabase/campaigns/devnet.sql"))
  await q(sql("supabase/proposed/20261002000002_qlc_payments.sql"))
  console.log("════ dev project schema + credit campaigns + QLC payments ════")
  await q(sql("supabase/proposed/20261006000001_qlc_generation_billing.sql"))
  await q(sql("supabase/campaigns/devnet-qlc.sql"))

  // ── Privileges ──
  const tables = ["qlc_generation_epochs", "qlc_charge_wallets", "qlc_charges"]
  const rls = (await q("SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)", [tables])).rows
  check("RLS enabled on every new table", rls.length === 3 && rls.every((r) => r.relrowsecurity))
  let clientDenied = true
  for (const role of ["anon", "authenticated"]) {
    for (const t of [...tables, "qlc_generation_epoch_totals"]) clientDenied &&= await denied(role, `SELECT * FROM public.${t}`)
    clientDenied &&= await denied(role, "SELECT public.reserve_qlc_generation_charge($1, 'devnet', $2, $3, 100, 1)", [randomUUID(), randomUUID(), address()])
    clientDenied &&= await denied(role, "SELECT public.open_qlc_generation_epoch('devnet', 100, 'x', 'x', 'x')")
    clientDenied &&= await denied(role, "SELECT public.mark_qlc_charge_refunded($1, NULL)", [randomUUID()])
  }
  check("anon / authenticated cannot read the tables or call any billing function", clientDenied)
  check("no epoch → reservations report no_epoch", (await reserve(randomUUID(), await newUser(), address(), 100)).status === "no_epoch")

  // ── Owner epoch controls ──
  const opened = await openEpoch("open-1")
  check("owner opens a 15,000.00 QLC epoch", opened.status === "opened" && Number(opened.limit) === LIMIT)
  check("the same request key returns the same epoch", (await openEpoch("open-1")).status === "already_opened" && (await epochs()).length === 1)
  check("a second active epoch is refused", (await openEpoch("open-2")).status === "already_active")
  check("invalid limits are refused (non-positive, off the 0.05 step)", (await openEpoch("bad-1", 0)).status === "invalid_request" && (await openEpoch("bad-2", 1_500_002)).status === "invalid_request")

  // ── 500 concurrent 40 QLC reservations from 500 wallets over 40 connections ──
  const user = await newUser()
  const wallets = Array.from({ length: 500 }, address)
  const results = await Promise.all(wallets.map((w) => reserve(randomUUID(), user, w, 4000)))
  const admitted = results.filter((r) => r.status === "reserved").length
  let e = await current()
  check("concurrency: exactly 375 admitted, reserved = 15,000.00 QLC, never above", admitted === 375 && Number(e.reserved) === LIMIT && Number(e.reserved) <= Number(e.limit), `admitted=${admitted} reserved=${e.reserved}`)
  check("concurrency: the epoch paused itself (budget_exhausted, rejected 40.00 QLC)", e.status === "paused" && e.pause_reason === "budget_exhausted" && Number(e.rejected) === 4000)
  const statuses = results.map((r) => r.status)
  check("concurrency: every other request was refused as budget_exhausted or paused", statuses.filter((s) => s === "budget_exhausted").length >= 1 && statuses.every((s) => ["reserved", "budget_exhausted", "paused"].includes(s)))
  check("concurrency: one charge row per admitted reservation", (await one("SELECT count(*)::int AS n FROM public.qlc_charges")).n === 375)
  check("after the pause even 0.05 QLC is refused", (await reserve(randomUUID(), user, address(), 5)).status === "paused")
  check("no automatic reset: still paused", (await current()).status === "paused")

  // ── Reopen: history kept ──
  const reopened = await openEpoch("open-2")
  check("owner reopen creates a new epoch; the old one is kept", reopened.status === "opened" && (await epochs()).length === 2 && (await epochs())[0].status === "paused" && Number((await epochs())[0].reserved) === LIMIT)

  // ── Mixed sizes concurrently (largest 1,200.00 QLC) ──
  const sizes = [40000, 100, 12000, 1500, 31500, 200, 8000, 120000, 4000, 500]
  const mixed = await Promise.all(Array.from({ length: 400 }, (_, i) => reserve(randomUUID(), user, address(), sizes[i % sizes.length])))
  e = await current()
  const mixedSum = (await one("SELECT coalesce(sum(amount), 0)::bigint AS s FROM public.qlc_charges WHERE epoch_id = $1", [e.id])).s
  check("mixed concurrency: admitted total = reserved ≤ 15,000.00 QLC, epoch paused", Number(mixedSum) === Number(e.reserved) && Number(e.reserved) <= LIMIT && e.status === "paused",
    `admitted=${mixed.filter((r) => r.status === "reserved").length} reserved=${e.reserved}`)

  // ── Charge lifecycle on a fresh epoch ──
  await openEpoch("open-3")
  const wallet = address()
  const g1 = randomUUID()
  const r1 = await reserve(g1, user, wallet, 4000, 1)
  check("reserve: per-wallet sequence starts at the program's next number", r1.status === "reserved" && Number(r1.seq) === 1)
  const dup = await Promise.all([1, 2, 3, 4, 5].map(() => reserve(g1, user, wallet, 4000)))
  check("the same generation reserved again (concurrently) → existing, one row", dup.every((r) => r.status === "existing" && Number(r.seq) === 1) && (await one("SELECT count(*)::int AS n FROM public.qlc_charges WHERE generation_id = $1", [g1])).n === 1)
  const g2 = randomUUID()
  check("minSeq above the counter (later charges landed on chain) is honored", Number((await reserve(g2, user, wallet, 4000, 9)).seq) === 9)
  check("reassign gives a pending charge a higher number", (await fn("reassign_qlc_charge_seq", g2, 12)).status === "reassigned" && Number((await charge(g2)).seq) === 12)
  check("charged: pending → charged once", (await fn("mark_qlc_charge_charged", g1, "sig1")).status === "charged" && (await fn("mark_qlc_charge_charged", g1, "sig1b")).status === "unchanged" && (await charge(g1)).charge_signature === "sig1")
  check("reassign never changes a charged sequence", (await fn("reassign_qlc_charge_seq", g1, 50)).status === "not_pending" && Number((await charge(g1)).seq) === 1)
  check("settle: charged → settled once", (await fn("settle_qlc_charge", g1)).status === "settled" && (await fn("settle_qlc_charge", g1)).status === "unchanged")
  check("a settled charge cannot start a refund", (await fn("begin_qlc_charge_refund", g1)).status === "unchanged" && (await charge(g1)).status === "settled")

  e = await current()
  const reservedBefore = Number(e.reserved)
  check("fail: pending → charge_failed releases its reservation", (await fn("fail_qlc_charge", g2, "allowance too low")).status === "charge_failed" && Number((await current()).reserved) === reservedBefore - 4000 && Number((await current()).released) === 4000)
  check("fail is idempotent and never releases twice", (await fn("fail_qlc_charge", g2, "again")).status === "unchanged" && Number((await current()).released) === 4000)
  check("a charged generation cannot be failed (its QLC moved)", (await fn("fail_qlc_charge", g1, "late")).status === "unchanged")

  const g3 = randomUUID()
  await reserve(g3, user, wallet, 4000, 1)
  await fn("mark_qlc_charge_charged", g3, "sig3")
  const reservedAtRefund = Number((await current()).reserved)
  const started = await fn("begin_qlc_charge_refund", g3)
  check("refund: charged → refund_pending once, with wallet and sequence", started.status === "refund_pending" && started.wallet === wallet && Number(started.seq) === 13)
  check("refund start is idempotent", (await fn("begin_qlc_charge_refund", g3)).status === "unchanged")
  const refundRace = await Promise.all([1, 2, 3].map(() => fn("mark_qlc_charge_refunded", g3, "rsig")))
  e = await current()
  check("refunded once under concurrent confirmations", refundRace.filter((r) => r.status === "refunded").length === 1 && Number(e.refunded) === 4000)
  check("a refund never reopens the budget (reserved unchanged)", Number(e.reserved) === reservedAtRefund)

  const g4 = randomUUID()
  await reserve(g4, user, wallet, 4000, 1)
  check("release of a pending (unknown outcome) charge only flags it", (await fn("begin_qlc_charge_refund", g4)).status === "release_requested" && (await charge(g4)).release_requested === true && (await charge(g4)).status === "pending")
  check("the flag survives the late confirmation (recovery then refunds)", (await fn("mark_qlc_charge_charged", g4, null)).releaseRequested === true)

  check("close: settled / refunded → closed with outcome", (await fn("mark_qlc_charge_closed", g1, "c1")).outcome === "settled" && (await fn("mark_qlc_charge_closed", g3, "c3")).outcome === "refunded" && (await fn("mark_qlc_charge_closed", g4, "c4")).status === "unchanged")
  check("a closed charge keeps its sequence number (never reused)", (await reserve(randomUUID(), user, wallet, 100, 1)).seq > 13)

  // ── Refunds never reopen the epoch ──
  await fn("pause_qlc_generation_epoch", "devnet", "owner-cli", "switch to the refund test")
  check("owner pause → paused for everyone", (await current()).pause_reason === "owner" && (await reserve(randomUUID(), user, address(), 100)).status === "paused")
  await openEpoch("open-4", 100_000) // 1,000.00 QLC for a compact test
  const refundWallet = address()
  const gens = []
  for (let i = 0; i < 9; i++) {
    const g = randomUUID()
    gens.push(g)
    await reserve(g, user, refundWallet, 10_000, 1)
    await fn("mark_qlc_charge_charged", g, null)
  }
  for (const g of gens.slice(0, 5)) {
    await fn("begin_qlc_charge_refund", g)
    await fn("mark_qlc_charge_refunded", g, null)
  }
  e = await current()
  check("refunded charges still count: reserved 900.00, refunded 500.00", Number(e.reserved) === 90_000 && Number(e.refunded) === 50_000)
  check("a request that only fits if refunds reopened the budget pauses the epoch", (await reserve(randomUUID(), user, refundWallet, 20_000)).status === "budget_exhausted" && (await current()).status === "paused")
  const totals = (await q("SELECT epoch_id, status, reserved_amount::bigint AS reserved, refunded_amount::bigint AS refunded, remaining_amount::bigint AS remaining, refunded_count::int, settled_count::int, charge_failed_count::int FROM public.qlc_generation_epoch_totals ORDER BY epoch_id")).rows
  check("per-epoch totals for every epoch (history preserved)", totals.length === 4 && totals[3].refunded_count === 5 && Number(totals[3].remaining) === 10_000 && totals[2].settled_count === 1 && totals[2].charge_failed_count === 1, JSON.stringify(totals.at(-1)))

  // ── QLC campaign payout: 500 QLC once per wallet ──
  await q("UPDATE public.credit_campaigns SET is_active = true WHERE id = 'devnet-open-qlc'")
  const grantee = await newUser()
  const granteeWallet = address()
  const creditsBefore = (await one("SELECT credits FROM public.profiles WHERE id = $1", [grantee])).credits
  const GRANT = "SELECT public.grant_campaign_credits('devnet-open-qlc', 'devnet', 'claim', $1, $2, NULL, NULL, 'devnet auto claim', 'system') AS r"
  const grants = await Promise.all([1, 2, 3, 4].map(() => svc(GRANT, [grantee, granteeWallet]).then((row) => row.r)))
  const granted = grants.filter((g) => g.status === "granted")
  const delivery = await one("SELECT * FROM public.qlc_deliveries WHERE delivery_key = $1", [`campaign:devnet-open-qlc:wallet:${granteeWallet}`])
  check("500 QLC grant: one delivery of 50000 base units, exactly once under concurrency", granted.length === 1 && delivery && Number(delivery.qlc_amount) === 50_000 && delivery.status === "pending" && delivery.delivery_id_hex === sha256hex(delivery.delivery_key))
  check("repeated claims report already_granted with the same delivery", grants.filter((g) => g.status === "already_granted").length === 3 && (await svc(GRANT, [grantee, granteeWallet])).r.deliveryId === delivery.id)
  check("a QLC grant never changes profiles.credits", (await one("SELECT credits FROM public.profiles WHERE id = $1", [grantee])).credits === creditsBefore)
  check("the grant row links its delivery", (await one("SELECT qlc_delivery_id FROM public.credit_grants WHERE campaign_id = 'devnet-open-qlc' AND user_id = $1", [grantee])).qlc_delivery_id === delivery.id)
  check("another login of another user with the same wallet cannot re-grant", (await svc(GRANT, [await newUser(), granteeWallet])).r.status === "already_granted")
  const legacy = await newUser()
  const legacyBefore = (await one("SELECT credits FROM public.profiles WHERE id = $1", [legacy])).credits
  const legacyGrant = (await svc("SELECT public.grant_campaign_credits('devnet-test-credits', 'devnet', 'claim', $1, $2, NULL, NULL, 'devnet auto claim', 'system') AS r", [legacy, address()])).r
  check("credits payout campaigns keep the legacy behavior", legacyGrant.status === "granted" && (await one("SELECT credits FROM public.profiles WHERE id = $1", [legacy])).credits === legacyBefore + 1000)

  // ── Rollback ──
  await q(sql("supabase/rollbacks/20261006000001_qlc_generation_billing.sql"))
  const left = (await one("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)", [tables])).n
  const fns = (await one("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('reserve_qlc_generation_charge', 'open_qlc_generation_epoch', 'settle_qlc_charge')")).n
  const payout = (await one("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'credit_campaigns' AND column_name = 'payout'")).n
  check("rollback removes tables, functions and the payout column", left === 0 && fns === 0 && payout === 0)
  check("rollback switches QLC campaigns off (they must not turn into credit grants)", (await one("SELECT is_active FROM public.credit_campaigns WHERE id = 'devnet-open-qlc'")).is_active === false)
  const after = await newUser()
  const afterGrant = (await svc("SELECT public.grant_campaign_credits('devnet-manual-grants', 'devnet', 'manual', $1, NULL, $2, 50, 'rollback check', 'owner') AS r", [after, `rollback-${randomUUID()}`])).r
  check("rollback restores the previous grant function (credits payout works)", afterGrant.status === "granted")
  await q(sql("supabase/proposed/20261006000001_qlc_generation_billing.sql"))
  check("migration re-applies cleanly after rollback", (await one("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)", [tables])).n === 3)
} catch (err) {
  failures++
  console.error("ERROR", err)
} finally {
  await pool.end().catch(() => {})
  await server.stop().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
