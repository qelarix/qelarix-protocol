// Database checks for supabase/proposed/20261002000001_credit_campaigns.sql against a throwaway
// local Postgres (never a Supabase project). Two schemas are tested:
//   1. the repo migrations (a fresh project), and
//   2. the verified dev-project schema (supabase/snapshots/dev-credit-schema-2026-10-02.sql).
// Each applies the proposed migration, the campaign files and the rollback, and asserts the rules.
//
// Needs `pg` and `embedded-postgres`, which are not project dependencies:
//   npm install --prefix /tmp/credit-db-check pg embedded-postgres
//   node scripts/credit-campaigns-db-check.mjs /tmp/credit-db-check
import { createRequire } from "node:module"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomInt, randomUUID } from "node:crypto"

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
const wallet = () => Array.from({ length: 44 }, () => B58[randomInt(B58.length)]).join("")

const dataDir = mkdtempSync(join(tmpdir(), "credit-db-check-"))
const port = 55000 + randomInt(4000)
const server = new EmbeddedPostgres({ databaseDir: dataDir, port, user: "postgres", password: "postgres", persistent: false, onLog: () => {} })
await server.initialise()
await server.start()
const pools = []
let pool
async function useDatabase(name) {
  await server.createDatabase(name)
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: name, max: 80 })
  pool.on("error", () => {}) // idle connections dropped while the server shuts down
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
const GRANT = "SELECT public.grant_campaign_credits($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r"
async function grant(campaign, { cluster = "mainnet-beta", mode = "claim", userId, walletAddress = null, key = null, amount = null, reason = "check", by = "claim" } = {}) {
  return (await asRole("service_role", GRANT, [campaign, cluster, mode, userId, walletAddress, key, amount, reason, by])).rows[0].r
}
async function newUser() {
  const id = randomUUID()
  await q("INSERT INTO auth.users (id, raw_user_meta_data) VALUES ($1, '{}')", [id])
  return id
}
const statusCount = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})

// ════ Suite 2: verified dev-project schema ════
async function devSnapshotSuite() {
  await useDatabase("dev_snapshot")
  await q(SUPABASE_STUBS)
  await q(sql("supabase/snapshots/dev-credit-schema-2026-10-02.sql"))
  console.log("\n════ Suite 2: dev project snapshot (qcggkvubogqlmxcepvbr, 2026-10-02) ════\n── Before migration (live state) ──")
  const alice = await newUser()
  const bob = await newUser()
  await q("UPDATE public.profiles SET email = 'bob@qelarix.test' WHERE id = $1", [bob])
  const aliceStart = (await q("SELECT credits FROM public.profiles WHERE id = $1", [alice])).rows[0].credits
  check("live trigger grants early-adopter credits (1,100) with no promo ledger row",
    aliceStart === 1100 && (await q("SELECT count(*)::int AS n FROM public.credit_transactions WHERE type = 'promo'")).rows[0].n === 0)
  check("live: anon can execute add_credits (critical finding reproduced)",
    await asRole("anon", "SELECT public.add_credits($1, 5000, 'minted by anon')", [alice]).then(() => true, () => false))
  check("live: anon can execute deduct_credits on another user",
    await asRole("anon", "SELECT public.deduct_credits($1, 1, 'drained by anon')", [bob]).then(() => true, () => false))
  check("live: anon can execute increment_followers",
    await asRole("anon", "SELECT public.increment_followers($1)", [bob]).then(() => true, () => false))
  const otherUpdate = await asRole("authenticated", "UPDATE public.profiles SET credits = 999999 WHERE id = $1", [bob], alice)
  check("live: a signed-in user can change another user's credits (critical finding reproduced)", otherUpdate.rowCount === 1)
  const ownUpdate = await asRole("authenticated", "UPDATE public.profiles SET credits = 777777 WHERE id = $1", [alice], alice)
  check("live: a signed-in user can change their own credits", ownUpdate.rowCount === 1)
  const emails = (await asRole("authenticated", "SELECT email FROM public.profiles WHERE email IS NOT NULL", [], alice)).rows
  check("live: a signed-in user can read other users' emails", emails.length === 1)

  await q(sql("supabase/proposed/20261002000001_credit_campaigns.sql"))
  console.log("\n── After proposed migration ──")
  const fns = (await q(`SELECT p.oid::regprocedure::text AS fn,
      has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') AS client_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND p.proname NOT IN ('handle_new_user', 'grant_campaign_credits')`)).rows
  check(`all ${fns.length} credit and counter functions closed to anon/authenticated, open to service_role`,
    fns.length === 12 && fns.every((f) => !f.client_execute && f.service_execute), fns.filter((f) => f.client_execute).map((f) => f.fn).join(", "))
  check("anon cannot execute add_credits", await denied("anon", "SELECT public.add_credits($1, 1, 'x')", [alice]))
  check("authenticated cannot execute update_monthly_stats_like", await denied("authenticated", "SELECT public.update_monthly_stats_like($1, 100)", [alice], alice))
  check("service_role add_credits / deduct_credits still work",
    await asRole("service_role", "SELECT public.add_credits($1, 10, 'server top-up'), public.deduct_credits($1, 5, 'server usage')", [alice]).then(() => true, () => false))
  check("signed-in user cannot change another user's credits", await denied("authenticated", "UPDATE public.profiles SET credits = 1 WHERE id = $1", [bob], alice))
  check("signed-in user cannot change their own credits", await denied("authenticated", "UPDATE public.profiles SET credits = 1 WHERE id = $1", [alice], alice))
  check("signed-in user cannot delete profiles", await denied("authenticated", "DELETE FROM public.profiles WHERE id = $1", [alice], alice))
  const visible = (await asRole("authenticated", "SELECT id, early_adopter, early_adopter_number FROM public.profiles", [], alice)).rows
  check("signed-in user reads only their own profile (register page read still works)", visible.length === 1 && visible[0].id === alice)
  check("signed-in user cannot read other users' emails",
    (await asRole("authenticated", "SELECT email FROM public.profiles WHERE email IS NOT NULL", [], alice)).rows.length === 0)
  check("anon cannot truncate credit tables", await denied("anon", "TRUNCATE public.credit_transactions"))
  check("anon has no access to profiles", await denied("anon", "SELECT id FROM public.profiles"))
  const counterBefore = (await q("SELECT count FROM public.early_adopter_counter")).rows[0].count
  const fresh = await newUser()
  const freshProfile = (await q("SELECT credits, early_adopter FROM public.profiles WHERE id = $1", [fresh])).rows[0]
  check("new auth user → 0 credits, no early adopter, counter unchanged",
    freshProfile.credits === 0 && freshProfile.early_adopter === false &&
    (await q("SELECT count FROM public.early_adopter_counter")).rows[0].count === counterBefore, `counter=${counterBefore}`)
  check("handle_new_user runs with a fixed search_path",
    (await q("SELECT proconfig FROM pg_proc WHERE proname = 'handle_new_user'")).rows[0].proconfig?.includes("search_path=public"))

  console.log("\n── Devnet test campaign (1,000 QLC, 20 testers) ──")
  await q(sql("supabase/campaigns/devnet.sql"))
  const testers = await Promise.all(Array.from({ length: 25 }, () => newUser()))
  const wave = statusCount(await Promise.all(testers.map((userId) => grant("devnet-test-credits", { cluster: "devnet", userId }))))
  check("25 concurrent testers → exactly 20 granted, 5 cap_reached", wave.granted === 20 && wave.cap_reached === 5, JSON.stringify(wave))
  const audit = (await q(`SELECT (SELECT count(*)::int FROM public.credit_grants WHERE campaign_id = 'devnet-test-credits') AS grants,
    (SELECT count(*)::int FROM public.credit_transactions WHERE type = 'promo' AND amount = 1000) AS ledger`)).rows[0]
  check("20 grant rows and 20 ledger rows of 1,000 QLC", audit.grants === 20 && audit.ledger === 20, JSON.stringify(audit))
  const granted = (await q("SELECT user_id FROM public.credit_grants WHERE campaign_id = 'devnet-test-credits' ORDER BY recipient_number LIMIT 1")).rows[0].user_id
  check("duplicate claim → already_granted", (await grant("devnet-test-credits", { cluster: "devnet", userId: granted })).status === "already_granted")

  await q("UPDATE public.credit_campaigns SET max_recipients = 30 WHERE id = 'devnet-test-credits'")
  await q("UPDATE public.credit_campaigns SET is_active = false WHERE id = 'devnet-test-credits'")
  const whilePaused = statusCount(await Promise.all(Array.from({ length: 5 }, async () => grant("devnet-test-credits", { cluster: "devnet", userId: await newUser() }))))
  const pausedCount = (await q("SELECT granted_count FROM public.credit_campaigns WHERE id = 'devnet-test-credits'")).rows[0].granted_count
  check("stopped campaign → every new claim inactive, counter unchanged", whilePaused.inactive === 5 && pausedCount === 20, JSON.stringify(whilePaused))
  const manualWhilePaused = await grant("devnet-manual-grants", { cluster: "devnet", mode: "manual", userId: granted, key: "topup-1", amount: 250, by: "operator:check" })
  check("operator top-up has its own switch (works while the test campaign is stopped)", manualWhilePaused.status === "granted")
  check("operator cannot issue into the test campaign", (await grant("devnet-test-credits", { cluster: "devnet", mode: "manual", userId: granted, key: "x", amount: 1000 })).status === "mode_mismatch")
  await q("UPDATE public.credit_campaigns SET is_active = false WHERE id = 'devnet-manual-grants'")
  check("stopped operator campaign → inactive", (await grant("devnet-manual-grants", { cluster: "devnet", mode: "manual", userId: granted, key: "topup-2", amount: 1, by: "operator:check" })).status === "inactive")
  await q("UPDATE public.credit_campaigns SET is_active = true WHERE id = 'devnet-test-credits'")
  const resumed = await grant("devnet-test-credits", { cluster: "devnet", userId: await newUser() })
  check("resume → next tester is #21; earlier testers stay already_granted",
    resumed.status === "granted" && resumed.recipientNumber === 21 &&
    (await grant("devnet-test-credits", { cluster: "devnet", userId: granted })).status === "already_granted")
  const afterResume = (await q(`SELECT (SELECT granted_count FROM public.credit_campaigns WHERE id = 'devnet-test-credits') AS counter,
    (SELECT count(*)::int FROM public.credit_grants WHERE campaign_id = 'devnet-test-credits') AS grants,
    (SELECT count(DISTINCT recipient_key)::int FROM public.credit_grants WHERE campaign_id = 'devnet-test-credits') AS recipients`)).rows[0]
  check("pause/resume kept all grants, no duplicates, no counter reset", afterResume.counter === 21 && afterResume.grants === 21 && afterResume.recipients === 21, JSON.stringify(afterResume))
  check("devnet campaign refused for a mainnet deployment", (await grant("devnet-test-credits", { cluster: "mainnet-beta", userId: await newUser() })).status === "cluster_mismatch")
  check("mainnet launch campaign is not present on devnet", (await grant("mainnet-launch-2026", { userId: await newUser(), walletAddress: wallet() })).status === "unknown_campaign")

  console.log("\n── Rollback on the dev snapshot ──")
  await q(sql("supabase/rollbacks/20261002000001_credit_campaigns.sql"))
  const rolledUser = await newUser()
  const rolled = (await q("SELECT credits, early_adopter FROM public.profiles WHERE id = $1", [rolledUser])).rows[0]
  const fnState = (await q("SELECT proconfig FROM pg_proc WHERE proname = 'handle_new_user'")).rows[0]
  check("rollback restores the live profile creation (early adopter 1,100) and drops campaign tables",
    rolled.credits === 1100 && rolled.early_adopter === true && fnState.proconfig === null &&
    (await q("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('credit_campaigns', 'credit_grants')")).rows[0].n === 0, JSON.stringify(rolled))
  check("rollback keeps credit functions closed to anon", await denied("anon", "SELECT public.add_credits($1, 1, 'x')", [rolledUser]))
  check("rollback keeps users from changing credits", await denied("authenticated", "UPDATE public.profiles SET credits = 1 WHERE id = $1", [rolledUser], rolledUser))
  await q(sql("supabase/proposed/20261002000001_credit_campaigns.sql"))
  check("migration re-applies cleanly after rollback", (await q("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('credit_campaigns', 'credit_grants')")).rows[0].n === 2)
}

try {
  // ════ Suite 1: repo migrations (fresh project) ════
  await useDatabase("repo_schema")
  await q(SUPABASE_STUBS)
  for (const m of ["20260506000001_initial_schema.sql", "20260506000002_nextauth.sql", "20260511000001_explore.sql", "20260511000002_leaderboard.sql"]) {
    await q(sql(`supabase/migrations/${m}`))
  }
  console.log("════ Suite 1: repo migrations ════\n── Current schema (existing migrations) ──")
  const legacyUser = await newUser()
  const legacy = (await q("SELECT credits, early_adopter FROM public.profiles WHERE id = $1", [legacyUser])).rows[0]
  check("current trigger grants credits to every new auth user", legacy?.credits === 1100 && legacy.early_adopter === true, JSON.stringify(legacy))
  const anonMint = await asRole("anon", "SELECT public.add_credits($1, 5000, 'promo', 'minted by anon')", [legacyUser]).then(() => true, () => false)
  check("current schema: anon can execute add_credits (vulnerability reproduced)", anonMint)

  // ── Proposed migration ────────────────────────────────────────────────────
  await q(sql("supabase/proposed/20261002000001_credit_campaigns.sql"))
  console.log("\n── After proposed migration ──")
  for (const role of ["anon", "authenticated"]) {
    check(`${role} cannot execute add_credits`, await denied(role, "SELECT public.add_credits($1, 1, 'promo', 'x')", [legacyUser]))
    check(`${role} cannot execute deduct_credits`, await denied(role, "SELECT public.deduct_credits($1, 1, 'x')", [legacyUser]))
    check(`${role} cannot execute grant_campaign_credits`, await denied(role, GRANT, ["x", "devnet", "claim", legacyUser, null, null, null, "x", "x"]))
  }
  const serviceAdd = await asRole("service_role", "SELECT public.add_credits($1, 1, 'bonus', 'service')", [legacyUser]).then(() => true, (e) => e.message)
  check("service_role can still execute add_credits", serviceAdd === true, String(serviceAdd))
  const openOverloads = (await q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'add_credits'
    AND (has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE'))`)).rows[0].n
  check("every add_credits overload closed to anon/authenticated", openOverloads === 0, `open overloads=${openOverloads}`)
  check("provision_nextauth_profile removed", (await q("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'provision_nextauth_profile'")).rows[0].n === 0)

  const counterBefore = (await q("SELECT count FROM public.early_adopter_counter")).rows[0].count
  const fresh = await newUser()
  const freshProfile = (await q("SELECT credits, early_adopter, early_adopter_number FROM public.profiles WHERE id = $1", [fresh])).rows[0]
  const counterAfter = (await q("SELECT count FROM public.early_adopter_counter")).rows[0].count
  const freshTx = (await q("SELECT count(*)::int AS n FROM public.credit_transactions WHERE user_id = $1", [fresh])).rows[0].n
  check("new auth user → profile with 0 credits, no promotion", freshProfile?.credits === 0 && freshProfile.early_adopter === false && freshProfile.early_adopter_number === null, JSON.stringify(freshProfile))
  check("new auth user → early-adopter counter untouched, no ledger row", counterBefore === counterAfter && freshTx === 0)
  await q("INSERT INTO public.profiles (id) VALUES ($1)", [randomUUID()])
  check("profiles.credits default is 0", (await q("SELECT count(*)::int AS n FROM public.profiles WHERE credits = 100 AND early_adopter = false")).rows[0].n === 0)

  // ── Mainnet launch campaign: first 50 × 200 ──────────────────────────────
  await q(sql("supabase/campaigns/mainnet.sql"))
  await q("UPDATE public.credit_campaigns SET is_active = true WHERE id = 'mainnet-launch-2026'")
  console.log("\n── Mainnet launch campaign ──")
  const contenders = await Promise.all(Array.from({ length: 60 }, async () => ({ userId: await newUser(), walletAddress: wallet() })))
  const race = await Promise.all(contenders.map((c) => grant("mainnet-launch-2026", c)))
  const raceCount = statusCount(race)
  check("60 concurrent wallets → exactly 50 granted, 10 cap_reached", raceCount.granted === 50 && raceCount.cap_reached === 10, JSON.stringify(raceCount))
  const launch = (await q("SELECT granted_count FROM public.credit_campaigns WHERE id = 'mainnet-launch-2026'")).rows[0]
  const numbers = race.filter((r) => r.status === "granted").map((r) => r.recipientNumber).sort((a, b) => a - b)
  check("granted_count = 50 and recipient numbers are exactly 1..50", launch.granted_count === 50 && numbers.join() === Array.from({ length: 50 }, (_, i) => i + 1).join())
  const paid = (await q("SELECT coalesce(sum(credits), 0)::int AS total FROM public.profiles WHERE id = ANY($1)", [contenders.map((c) => c.userId)])).rows[0].total
  const ledger = (await q("SELECT count(*)::int AS n, coalesce(sum(amount), 0)::int AS total FROM public.credit_transactions WHERE type = 'promo' AND description LIKE 'mainnet-launch-2026:%'")).rows[0]
  check("balances +10,000 total; 50 audited promo ledger rows of 200", paid === 10000 && ledger.n === 50 && ledger.total === 10000, `balances=${paid} ledger=${JSON.stringify(ledger)}`)
  const late = await grant("mainnet-launch-2026", { userId: await newUser(), walletAddress: wallet() })
  check("after the cap: no automatic grant", late.status === "cap_reached")

  // ── Idempotency / duplicates ─────────────────────────────────────────────
  console.log("\n── Idempotency and duplicates ──")
  await q(`INSERT INTO public.credit_campaigns (id, cluster, grant_mode, recipient_scope, amount, priority, is_active, description)
           VALUES ('mainnet-check-open', 'mainnet-beta', 'claim', 'wallet', 25, 50, true, 'check')`)
  const repeat = { userId: await newUser(), walletAddress: wallet() }
  const burst = statusCount(await Promise.all(Array.from({ length: 12 }, () => grant("mainnet-check-open", repeat))))
  check("same wallet, 12 concurrent claims → 1 granted, 11 already_granted", burst.granted === 1 && burst.already_granted === 11, JSON.stringify(burst))
  const replay = await grant("mainnet-check-open", repeat)
  const repeatBalance = (await q("SELECT credits FROM public.profiles WHERE id = $1", [repeat.userId])).rows[0].credits
  check("replay after success → already_granted, balance unchanged", replay.status === "already_granted" && repeatBalance === 25, `balance=${repeatBalance}`)
  const otherAccountSameWallet = await grant("mainnet-check-open", { userId: await newUser(), walletAddress: repeat.walletAddress })
  check("same wallet from another account → already_granted", otherAccountSameWallet.status === "already_granted")
  await q("DELETE FROM public.profiles WHERE id = $1", [repeat.userId])
  const kept = (await q("SELECT count(*)::int AS n FROM public.credit_grants WHERE wallet_address = $1 AND user_id IS NULL", [repeat.walletAddress])).rows[0].n
  const reclaim = await grant("mainnet-check-open", { userId: await newUser(), walletAddress: repeat.walletAddress })
  check("profile deleted → grant row kept, wallet cannot claim again", kept === 1 && reclaim.status === "already_granted")

  // ── Devnet / mainnet separation ──────────────────────────────────────────
  console.log("\n── Devnet / mainnet separation ──")
  await q(sql("supabase/campaigns/devnet.sql")) // separate project in production; same DB only for this check
  const tester = await newUser()
  const crossToMainnet = await grant("devnet-test-credits", { cluster: "mainnet-beta", userId: tester })
  const crossToDevnet = await grant("mainnet-launch-2026", { cluster: "devnet", userId: tester, walletAddress: wallet() })
  check("devnet campaign refused for a mainnet deployment", crossToMainnet.status === "cluster_mismatch")
  check("mainnet campaign refused for a devnet deployment", crossToDevnet.status === "cluster_mismatch")
  const devnetGrant = await grant("devnet-test-credits", { cluster: "devnet", userId: tester })
  const launchAfter = (await q("SELECT granted_count FROM public.credit_campaigns WHERE id = 'mainnet-launch-2026'")).rows[0].granted_count
  check("devnet test grant works and leaves mainnet counters untouched", devnetGrant.status === "granted" && devnetGrant.amount === 1000 && launchAfter === 50)
  check("devnet test credits are once per user", (await grant("devnet-test-credits", { cluster: "devnet", userId: tester })).status === "already_granted")
  const devnetRow = (await q("SELECT amount, max_recipients, usage_scope FROM public.credit_campaigns WHERE id = 'devnet-test-credits'")).rows[0]
  check("devnet campaign seeded with 1,000 QLC, 20-tester cap, low-cost model group",
    devnetRow.amount === 1000 && devnetRow.max_recipients === 20 && devnetRow.usage_scope?.modelGroup === "low-cost", JSON.stringify(devnetRow))
  await q("UPDATE public.credit_campaigns SET amount = 1500, max_recipients = 2 WHERE id = 'devnet-test-credits'")
  const edited = await grant("devnet-test-credits", { cluster: "devnet", userId: await newUser() })
  check("amount edited in the database applies to the next grant", edited.status === "granted" && edited.amount === 1500)
  check("tester cap reached → no more devnet grants", (await grant("devnet-test-credits", { cluster: "devnet", userId: await newUser() })).status === "cap_reached")
  await q(sql("supabase/campaigns/devnet.sql"))
  const afterReseed = (await q("SELECT amount, max_recipients, granted_count FROM public.credit_campaigns WHERE id = 'devnet-test-credits'")).rows[0]
  check("re-running devnet.sql keeps operator edits and counters", afterReseed.amount === 1500 && afterReseed.max_recipients === 2 && afterReseed.granted_count === 2, JSON.stringify(afterReseed))
  const allowTester = await newUser()
  await q("UPDATE public.credit_campaigns SET max_recipients = NULL, eligibility = $1::jsonb WHERE id = 'devnet-test-credits'", [JSON.stringify([{ type: "user_allowlist", userIds: [allowTester] }])])
  check("allowed-tester scope is stored as campaign eligibility", (await q("SELECT eligibility->0->>'type' AS t FROM public.credit_campaigns WHERE id = 'devnet-test-credits'")).rows[0].t === "user_allowlist")
  await q("UPDATE public.credit_campaigns SET is_active = false WHERE id = 'devnet-test-credits'")
  check("disabled devnet campaign → inactive", (await grant("devnet-test-credits", { cluster: "devnet", userId: allowTester })).status === "inactive")
  const launchUntouched = (await q("SELECT granted_count, amount, max_recipients FROM public.credit_campaigns WHERE id = 'mainnet-launch-2026'")).rows[0]
  check("devnet edits leave the mainnet campaign untouched", launchUntouched.granted_count === 50 && launchUntouched.amount === 200 && launchUntouched.max_recipients === 50)

  // ── Campaign state, modes and validation ─────────────────────────────────
  console.log("\n── Campaign state and validation ──")
  await q("UPDATE public.credit_campaigns SET is_active = false WHERE id = 'mainnet-check-open'")
  check("inactive campaign → inactive", (await grant("mainnet-check-open", { userId: await newUser(), walletAddress: wallet() })).status === "inactive")
  await q("UPDATE public.credit_campaigns SET is_active = true, starts_at = NOW() + interval '1 day' WHERE id = 'mainnet-check-open'")
  check("campaign before its start → inactive", (await grant("mainnet-check-open", { userId: await newUser(), walletAddress: wallet() })).status === "inactive")
  await q("UPDATE public.credit_campaigns SET starts_at = NULL, ends_at = NOW() - interval '1 second', created_at = NOW() - interval '1 day' WHERE id = 'mainnet-check-open'")
  check("campaign after its end → inactive", (await grant("mainnet-check-open", { userId: await newUser(), walletAddress: wallet() })).status === "inactive")
  check("claim on a manual campaign → mode_mismatch", (await grant("mainnet-manual-grants", { userId: tester, key: "k" })).status === "mode_mismatch")
  check("unknown campaign → unknown_campaign", (await grant("mainnet-nope", { userId: tester })).status === "unknown_campaign")
  check("wallet campaign without wallet → invalid_recipient", (await grant("mainnet-launch-2026", { userId: tester })).status === "invalid_recipient")
  check("malformed wallet → invalid_recipient", (await grant("mainnet-launch-2026", { userId: tester, walletAddress: "0OIl-not-base58" })).status === "invalid_recipient")
  await q("UPDATE public.credit_campaigns SET ends_at = NULL WHERE id = 'mainnet-check-open'")
  check("claim with a client-chosen amount → invalid_amount", (await grant("mainnet-check-open", { userId: await newUser(), walletAddress: wallet(), amount: 9999 })).status === "invalid_amount")
  const ghost = await grant("mainnet-check-open", { userId: randomUUID(), walletAddress: wallet() })
  const openCount = (await q("SELECT granted_count FROM public.credit_campaigns WHERE id = 'mainnet-check-open'")).rows[0].granted_count
  check("unknown user → unknown_user, counter unchanged", ghost.status === "unknown_user" && openCount === 1, `granted_count=${openCount}`)
  check("empty reason → invalid_request", (await grant("mainnet-check-open", { userId: tester, walletAddress: wallet(), reason: " " })).status === "invalid_request")

  // ── Manual / operator grants ─────────────────────────────────────────────
  console.log("\n── Manual grants ──")
  const member = await newUser()
  const manual = (o) => grant("mainnet-manual-grants", { mode: "manual", userId: member, by: "operator:check", ...o })
  const keyBurst = statusCount(await Promise.all(Array.from({ length: 8 }, () => manual({ key: "bug-bounty-42", amount: 300 }))))
  check("same grant key, 8 concurrent → 1 granted", keyBurst.granted === 1 && keyBurst.already_granted === 7, JSON.stringify(keyBurst))
  check("new grant key for the same user → granted again", (await manual({ key: "ambassador-oct", amount: 500 })).status === "granted")
  check("amount above the campaign ceiling → invalid_amount", (await manual({ key: "too-much", amount: 10001 })).status === "invalid_amount")
  check("zero amount → invalid_amount", (await manual({ key: "zero", amount: 0 })).status === "invalid_amount")
  check("missing grant key → invalid_recipient", (await manual({ key: null, amount: 10 })).status === "invalid_recipient")
  check("manual mode on a claim campaign → mode_mismatch", (await grant("mainnet-check-open", { mode: "manual", userId: member, walletAddress: wallet(), key: "x", amount: 25 })).status === "mode_mismatch")
  const memberLedger = (await q("SELECT type, amount FROM public.credit_transactions WHERE user_id = $1 ORDER BY amount", [member])).rows
  check("manual grants are audited as bonus ledger rows", JSON.stringify(memberLedger) === JSON.stringify([{ type: "bonus", amount: 300 }, { type: "bonus", amount: 500 }]), JSON.stringify(memberLedger))

  // ── Exclusion groups ─────────────────────────────────────────────────────
  console.log("\n── Exclusion groups ──")
  await q(`INSERT INTO public.credit_campaigns (id, cluster, grant_mode, recipient_scope, amount, priority, exclusion_group, is_active, description) VALUES
           ('mainnet-check-tier-a', 'mainnet-beta', 'claim', 'wallet', 100, 1, 'check-tier', true, 'check'),
           ('mainnet-check-tier-b', 'mainnet-beta', 'claim', 'wallet', 40, 2, 'check-tier', true, 'check')`)
  const tiered = { userId: await newUser(), walletAddress: wallet() }
  const tierRace = statusCount(await Promise.all(Array.from({ length: 10 }, (_, i) => grant(i % 2 ? "mainnet-check-tier-b" : "mainnet-check-tier-a", tiered))))
  check("same wallet racing two campaigns in one exclusion group → exactly 1 grant", tierRace.granted === 1, JSON.stringify(tierRace))

  // ── Row level security ───────────────────────────────────────────────────
  console.log("\n── Privileges and RLS ──")
  check("anon cannot read campaigns", await denied("anon", "SELECT * FROM public.credit_campaigns"))
  check("authenticated cannot read campaigns", await denied("authenticated", "SELECT * FROM public.credit_campaigns", [], member))
  check("authenticated cannot insert grants", await denied("authenticated", "INSERT INTO public.credit_grants (campaign_id, cluster, recipient_key, amount, recipient_number, reason, granted_by) VALUES ('mainnet-check-open','mainnet-beta','x',1,99,'x','x')", [], member))
  const own = (await asRole("authenticated", "SELECT user_id FROM public.credit_grants", [], member)).rows
  check("authenticated sees only their own grants", own.length === 2 && own.every((r) => r.user_id === member), `rows=${own.length}`)

  // ── Rollback and re-apply ────────────────────────────────────────────────
  console.log("\n── Rollback ──")
  await q(sql("supabase/rollbacks/20261002000001_credit_campaigns.sql"))
  const tables = (await q("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('credit_campaigns', 'credit_grants')")).rows[0].n
  const rolledUser = await newUser()
  const rolled = (await q("SELECT credits FROM public.profiles WHERE id = $1", [rolledUser])).rows[0]
  check("rollback drops campaign tables and restores previous profile creation", tables === 0 && (rolled.credits === 100 || rolled.credits === 1100), JSON.stringify(rolled))
  check("rollback keeps credit functions closed to anon", await denied("anon", "SELECT public.add_credits($1, 1, 'promo', 'x')", [rolledUser]))
  await q(sql("supabase/proposed/20261002000001_credit_campaigns.sql"))
  check("proposed migration re-applies cleanly after rollback", (await q("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('credit_campaigns', 'credit_grants')")).rows[0].n === 2)

  await devSnapshotSuite()
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
