// Read-only verification of the QLC payment schema on a Supabase project, before and after
// supabase/proposed/20261002000002_qlc_payments.sql and the configuration files are applied.
// Every query runs inside a READ ONLY transaction, so Postgres rejects any write. Refuses to run
// unless SUPABASE_DB_URL points at the project in NEXT_PUBLIC_SUPABASE_URL and that project is the
// one passed as --expect-project. Credentials are never printed.
//
//   npm install --prefix /tmp/payments-db-check pg
//   node scripts/payments-verify.mjs /tmp/payments-db-check --expect-project <ref> --stage before|after [--cluster devnet] [--env .env.local]
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)
const modulesDir = resolve(args[0] ?? ".")
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const envFile = option("--env") ?? ".env.local"
const expected = option("--expect-project")
const stage = option("--stage")
const cluster = option("--cluster") ?? "devnet"
if (!expected || !["before", "after"].includes(stage)) {
  console.error("--expect-project <project ref> and --stage before|after are required")
  process.exit(1)
}

const env = Object.fromEntries(readFileSync(envFile, "utf8").split("\n")
  .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
  .map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]))
if (!env.SUPABASE_DB_URL) { console.error(`SUPABASE_DB_URL is not set in ${envFile}`); process.exit(1) }

const apiRef = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/)?.[1]
const dbUrl = new URL(env.SUPABASE_DB_URL)
const dbRef = `${dbUrl.username} ${dbUrl.hostname}`.match(/([a-z0-9]{20})/)?.[1]
console.log(`project check → expected ${expected}, API URL ${apiRef ?? "?"}, database ${dbRef ?? "?"}`)
if (apiRef !== expected || dbRef !== expected) { console.error("Refusing: the database is not the expected project"); process.exit(1) }

const require = createRequire(join(modulesDir, "package.json"))
const pg = require("pg")
const ssl = dbUrl.searchParams.get("sslmode") === "disable" ? false : { rejectUnauthorized: false }
dbUrl.searchParams.delete("sslmode")
const client = new pg.Client({ connectionString: dbUrl.toString(), ssl, application_name: "qelarix-payments-verify" })

let failures = 0
function check(name, ok, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
const one = async (text, params) => (await client.query(text, params)).rows[0]
const TABLES = ["payment_assets", "qlc_price_packs", "payment_intents", "qlc_deliveries"]
const FUNCTIONS = ["settle_payment_intent", "record_qlc_delivery_attempt"]

await client.connect()
try {
  await client.query("BEGIN READ ONLY")
  check("session is read-only", (await one("select current_setting('transaction_read_only') as ro")).ro === "on")

  const present = await one(`select
    (select count(*)::int from pg_tables where schemaname = 'public' and tablename = any($1)) as tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($2)) as functions`,
    [TABLES, FUNCTIONS])
  const baseline = await one(`select (select count(*)::int from public.profiles) as profiles,
    (select coalesce(sum(credits), 0)::bigint::text from public.profiles) as total_credits,
    (select count(*)::int from public.credit_transactions) as ledger_rows,
    (select count(*)::int from public.credit_grants) as credit_grants,
    (select coalesce(sum(granted_count), 0)::int from public.credit_campaigns) as campaign_slots_used`)
  console.log(`baseline: ${JSON.stringify(baseline)}`)

  if (stage === "before") {
    check("payment tables and functions are not present yet", present.tables === 0 && present.functions === 0, JSON.stringify(present))
    check("superseded USDC-only objects are absent", (await one("select to_regclass('public.usdc_payment_intents') is null and not exists (select 1 from pg_proc where proname = 'settle_usdc_payment') as ok")).ok)
    check("credit migration prerequisite present (credit_campaigns, grant_campaign_credits)",
      (await one("select to_regclass('public.credit_campaigns') is not null as ok")).ok &&
      (await one("select count(*)::int as n from pg_proc where proname = 'grant_campaign_credits'")).n === 1)
  } else {
    check("all four tables and both functions exist", present.tables === 4 && present.functions === 2, JSON.stringify(present))
    if (present.tables !== 4 || present.functions !== 2) throw new Error("payment schema is not applied; remaining checks skipped")
    const rls = (await client.query("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)", [TABLES])).rows
    check("row level security enabled on every table", rls.length === 4 && rls.every((r) => r.relrowsecurity))
    const policies = (await client.query("select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename = any($1) order by policyname", [TABLES])).rows
    check("only policies: members read their own quotes and deliveries",
      policies.map((p) => `${p.policyname}:${p.cmd}`).join() === "payment_intents_select_own:SELECT,qlc_deliveries_select_own:SELECT", JSON.stringify(policies))
    const grants = (await client.query(`select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC')
      group by 1, 2 order by 1, 2`, [TABLES])).rows
    check("anon has no access; authenticated may only SELECT quotes and deliveries",
      grants.map((g) => `${g.table_name}:${g.grantee}:${g.privileges}`).join() === "payment_intents:authenticated:SELECT,qlc_deliveries:authenticated:SELECT", JSON.stringify(grants))
    const fns = (await client.query(`select p.proname, p.prosecdef as definer, array_to_string(p.proconfig, ',') as config,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1)`, [FUNCTIONS])).rows
    check("functions: SECURITY DEFINER, fixed search_path, service_role only",
      fns.length === 2 && fns.every((f) => f.definer && /search_path=public/.test(f.config ?? "") && !f.anon_exec && !f.auth_exec && !f.public_exec && f.service_exec), JSON.stringify(fns))
    const assets = (await client.query("select id, symbol, kind, is_enabled, approved_by is not null as approved from public.payment_assets where cluster = $1 order by sort_order", [cluster])).rows
    check(`${cluster} payment assets: USDC enabled; every enabled asset is owner-approved`,
      assets.some((a) => a.symbol === "USDC" && a.is_enabled && a.approved) && assets.every((a) => !a.is_enabled || a.approved),
      assets.map((a) => `${a.id}=${a.is_enabled ? "enabled" : "disabled"}`).join(" "))
    const packs = (await client.query("select id, qlc_amount::text as qlc, usd_value_micros::text as usd from public.qlc_price_packs where cluster = $1 and is_active order by sort_order", [cluster])).rows
    check(`${cluster} price packs active on the 0.05 QLC step`, packs.length > 0 && packs.every((p) => BigInt(p.qlc) % 5n === 0n), packs.map((p) => `${p.id}=${p.qlc}/${p.usd}`).join(" "))
    check("nothing active for another cluster on this project",
      (await one("select (select count(*)::int from public.qlc_price_packs where cluster <> $1 and is_active) + (select count(*)::int from public.payment_assets where cluster <> $1 and is_enabled) as n", [cluster])).n === 0)
    const uniques = (await one(`select count(*)::int as n from pg_indexes where schemaname = 'public' and (
        (tablename = 'payment_intents' and (indexdef ilike '%UNIQUE%(reference)%' or indexdef ilike '%UNIQUE%(tx_signature)%' or indexdef ilike '%UNIQUE%(delivery_id)%'))
        or (tablename = 'qlc_deliveries' and (indexdef ilike '%UNIQUE%(delivery_key)%' or indexdef ilike '%UNIQUE%(delivery_id_hex)%')))`)).n
    check("replay guards: unique reference, signature, delivery link, delivery key and on-chain id", uniques === 5, `${uniques} unique indexes`)
    const recovery = await one(`select
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'qlc_deliveries' and column_name = 'next_attempt_at') as backoff,
        (select count(*)::int from pg_indexes where schemaname = 'public' and indexname in ('payment_intents_pending_idx', 'qlc_deliveries_due_idx')) as indexes,
        exists (select 1 from pg_constraint where conrelid = 'public.payment_intents'::regclass and pg_get_constraintdef(oid) ilike '%expired%') as expired_status,
        exists (select 1 from pg_proc where proname = 'record_qlc_delivery_attempt' and prosrc ilike '%next_attempt_at%') as attempt_backoff`)
    check("recovery: delivery backoff column + function, recovery indexes, expired quote status",
      recovery.backoff && recovery.indexes === 2 && recovery.expired_status && recovery.attempt_backoff, JSON.stringify(recovery))
    const queue = await one("select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'delivered')::int as delivered from public.qlc_deliveries")
    console.log(`delivery queue: ${JSON.stringify(queue)}`)
  }
} catch (err) {
  failures++
  console.log(`STOP  ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await client.query("ROLLBACK").catch(() => {})
  await client.end()
}
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
