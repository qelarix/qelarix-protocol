// Read-only security / schema verification of a Supabase project's database.
// Every query runs inside a READ ONLY transaction, so Postgres rejects any write.
// Refuses to run unless SUPABASE_DB_URL points at the project in NEXT_PUBLIC_SUPABASE_URL
// and that project is the one passed as --expect-project. Credentials are never printed.
//
//   npm install --prefix /tmp/credit-db-check pg
//   node scripts/supabase-security-verify.mjs /tmp/credit-db-check --expect-project <project ref> [--env .env.local]
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)
const modulesDir = resolve(args[0] ?? ".")
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const envFile = option("--env") ?? ".env.local"
const expected = option("--expect-project")
if (!expected) { console.error("--expect-project <project ref> is required"); process.exit(1) }

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
// Supabase requires TLS; sslmode=disable is honoured only for local test databases.
const ssl = dbUrl.searchParams.get("sslmode") === "disable" ? false : { rejectUnauthorized: false }
dbUrl.searchParams.delete("sslmode")
const client = new pg.Client({ connectionString: dbUrl.toString(), ssl, application_name: "qelarix-security-verify" })

const SECTIONS = [
  ["server", `select current_database() as database, current_user as connected_as,
     split_part(version(), ' ', 2) as postgres_version, current_setting('transaction_read_only') as read_only`],
  ["security definer functions in public (who can execute)", `
     select p.proname as function, pg_get_function_identity_arguments(p.oid) as args,
            pg_get_userbyid(p.proowner) as owner,
            exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
     order by 1, 2`],
  ["credit-related functions (any security mode)", `
     select p.proname as function, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname ~ '(credit|provision|handle_new_user|grant_campaign|early_adopter)'
     order by 1, 2`],
  ["triggers on auth.users", `
     select t.tgname as trigger, t.tgenabled as enabled, p.proname as function, pg_get_triggerdef(t.oid) as definition
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal`],
  ["function bodies", `
     select p.proname as function, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as body
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('handle_new_user', 'add_credits', 'deduct_credits', 'provision_nextauth_profile')
     order by 1, 2`],
  ["other security definer function bodies in public", `
     select p.proname as function, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as body
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and p.proname not in ('handle_new_user', 'add_credits', 'deduct_credits', 'provision_nextauth_profile')
     order by 1, 2`],
  ["columns of tables the credit migration touches", `
     select table_name as table, column_name as column, data_type, column_default, is_nullable
     from information_schema.columns
     where table_schema = 'public' and table_name in ('profiles', 'credit_transactions', 'early_adopter_counter')
     order by table_name, ordinal_position`],
  ["check constraints on profiles / credit_transactions", `
     select conrelid::regclass as table, conname as constraint, pg_get_constraintdef(oid) as definition
     from pg_constraint where contype = 'c' and conrelid in ('public.profiles'::regclass, 'public.credit_transactions'::regclass)`],
  ["triggers on profiles / credit_transactions", `
     select tgrelid::regclass as table, tgname as trigger, pg_get_triggerdef(oid) as definition
     from pg_trigger where not tgisinternal and tgrelid in ('public.profiles'::regclass, 'public.credit_transactions'::regclass)`],
  ["policies on profiles / credit_transactions", `
     select tablename as table, policyname as policy, cmd, roles::text as roles, qual, with_check
     from pg_policies where schemaname = 'public' and tablename in ('profiles', 'credit_transactions')`],
  ["table privileges for anon / authenticated on credit tables", `
     select table_name as table, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
     from information_schema.role_table_grants
     where table_schema = 'public' and table_name in ('profiles', 'credit_transactions', 'early_adopter_counter')
       and grantee in ('anon', 'authenticated') group by 1, 2 order by 1, 2`],
  ["foreign keys on profiles / credit_transactions", `
     select conrelid::regclass as table, conname as constraint, pg_get_constraintdef(oid) as definition
     from pg_constraint where contype = 'f' and conrelid in ('public.profiles'::regclass, 'public.credit_transactions'::regclass)`],
  ["profiles.credits default", `
     select column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'credits'`],
  ["row level security", `
     select c.relname as table, c.relrowsecurity as rls_enabled,
            (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by 1`],
  ["default privileges for new functions", `
     select pg_get_userbyid(defaclrole) as for_role, defaclnamespace::regnamespace as schema, defaclacl::text as acl
     from pg_default_acl where defaclobjtype = 'f'`],
  ["objects the proposed migration creates (expect none)", `
     select 'table' as kind, relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and relname in ('credit_campaigns', 'credit_grants')
     union all select 'function', proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and proname = 'grant_campaign_credits'`],
  ["identity alignment", `
     select (select count(*) from auth.users) as auth_users,
            (select count(*) from public.profiles) as profiles,
            (select count(*) from public.profiles p left join auth.users u on u.id = p.id where u.id is null) as profiles_without_auth_user,
            (select count(*) from auth.users u left join public.profiles p on p.id = u.id where p.id is null) as auth_users_without_profile`],
  ["auth provider mix", `select coalesce(i.provider, '(no identity)') as provider, count(*) as users
     from auth.users u left join auth.identities i on i.user_id = u.id group by 1 order by 2 desc`],
  ["early adopter counter", `select * from public.early_adopter_counter`],
  ["credit ledger by type", `select type, count(*) as rows, coalesce(sum(amount), 0) as total from public.credit_transactions group by type order by type`],
  ["recorded migration history (Supabase CLI)", `
     select case when to_regclass('supabase_migrations.schema_migrations') is null then 'no migration history table'
            else 'present' end as status`],
]

await client.connect()
try {
  await client.query("BEGIN READ ONLY")
  for (const [title, sql] of SECTIONS) {
    console.log(`\n── ${title} ──`)
    const { rows } = await client.query(sql)
    if (rows.length === 0) console.log("(none)")
    for (const row of rows) console.log(JSON.stringify(row))
  }
  const history = await client.query("select to_regclass('supabase_migrations.schema_migrations') is not null as present")
  if (history.rows[0].present) {
    const { rows } = await client.query("select version, name from supabase_migrations.schema_migrations order by version")
    for (const row of rows) console.log(JSON.stringify(row))
  }
  await client.query("ROLLBACK")
} finally {
  await client.end()
}
