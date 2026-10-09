// Wallet-only authentication guard. Verifies that src/lib/authSession.ts resolves no session other
// than the Solana wallet session (a NextAuth session cookie or bearer token of the retired
// Google/GitHub sign-in resolves to no user), that the post-sign-in redirect in
// src/lib/authRedirect.ts stays same-origin, and that no legacy sign-in or registration path is back
// in src/. Offline: no network, no real credentials.
//
//   npm run check:auth-session
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { NextRequest } from "next/server"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://abcdefghijklmnopqrst.supabase.co"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key"
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}

function request(opts: { cookie?: string; bearer?: string } = {}) {
  const headers = new Headers()
  if (opts.cookie) headers.set("cookie", opts.cookie)
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`)
  return new NextRequest("http://localhost:3000/api/check", { headers })
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : []
  })
}

async function main() {
  console.log("── Session resolution is wallet-only ──")
  const { getRequestAuthUser } = await import("../src/lib/authSession")
  let networkCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    networkCalls++
    return new Response("{}", { status: 500 })
  }) as typeof fetch
  const legacy = randomBytes(48).toString("base64url")
  check("no session → null", (await getRequestAuthUser(request())) === null)
  check("NextAuth session cookie → null", (await getRequestAuthUser(request({ cookie: `next-auth.session-token=${legacy}` }))) === null)
  check("secure NextAuth session cookie → null", (await getRequestAuthUser(request({ cookie: `__Secure-next-auth.session-token=${legacy}` }))) === null)
  check("Authorization: Bearer token → null", (await getRequestAuthUser(request({ bearer: legacy }))) === null)
  check("no wallet session cookie → Supabase is not contacted", networkCalls === 0, `${networkCalls} request(s)`)
  globalThis.fetch = realFetch

  console.log("\n── Post-sign-in redirect (src/lib/authRedirect.ts) ──")
  const { safeReturnPath } = await import("../src/lib/authRedirect")
  const back = (query: string, fallback?: string) => safeReturnPath(new URLSearchParams(query), fallback)
  check("callbackUrl path kept", back("callbackUrl=/pricing") === "/pricing")
  check("redirect path kept", back("redirect=/audio") === "/audio")
  check("callbackUrl wins over redirect", back("callbackUrl=/pricing&redirect=/audio") === "/pricing")
  check("query and hash kept", back(`callbackUrl=${encodeURIComponent("/dashboard?tab=plan#top")}`) === "/dashboard?tab=plan#top")
  check("missing → fallback", back("") === "/" && back("", "/dashboard") === "/dashboard")
  for (const target of ["//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example/", "javascript:alert(1)", "evil.example"]) {
    check(`external or malformed target ${JSON.stringify(target)} → fallback`, back(`callbackUrl=${encodeURIComponent(target)}`, "/dashboard") === "/dashboard")
  }

  console.log("\n── No legacy sign-in or registration path in src/ ──")
  const files = sourceFiles(join(ROOT, "src"))
  const offenders = (pattern: RegExp) => files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))
  const imports = offenders(/from\s+["']next-auth|require\(["']next-auth/)
  check("no next-auth import", imports.length === 0, imports.join(", "))
  const legacyCalls = offenders(/signInWithPassword|signInWithOAuth|signInWithOtp|auth\.signUp\(|GoogleProvider|GitHubProvider|EmailProvider|\/api\/auth\//)
  check("no Google / GitHub / email-password / magic-link sign-in call", legacyCalls.length === 0, legacyCalls.join(", "))
  const registerLinks = offenders(/["'`]\/register(["'`?#/]|$)/m)
  check("no link or redirect to /register", registerLinks.length === 0, registerLinks.join(", "))
  for (const route of ["src/app/(auth)/register", "src/app/api/auth", "src/app/api/settings/password", "src/app/api/email/welcome", "src/lib/auth.ts"]) {
    check(`retired route or module absent: ${route}`, !existsSync(join(ROOT, route)))
  }
  const nextConfig = readFileSync(join(ROOT, "next.config.mjs"), "utf8")
  check("/register redirects to wallet sign-up /signup", /source:\s*"\/register",\s*destination:\s*"\/signup"/.test(nextConfig))

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
