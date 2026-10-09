import { type NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import type { Database } from "@/types/database"
import { safeReturnPath } from "@/lib/authRedirect"
import { getSolanaWalletAddress } from "@/lib/walletIdentity"

const PROTECTED_PREFIXES = ["/dashboard", "/settings"]
// Wallet sign-in pages. The retired /register redirects to /signup in next.config.mjs.
const AUTH_PAGES = ["/login", "/signup"]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ── 1. Refresh Supabase session (must run first, before any redirects) ──
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user: supabaseUser },
  } = await supabase.auth.getUser()

  // Wallet-only: a session counts only when it is a Solana wallet session (Supabase sessions
  // without a wallet identity, e.g. email sign-ups, are not accepted).
  const isAuthenticated = !!getSolanaWalletAddress(supabaseUser)

  // Redirects keep any session cookies refreshed above.
  const redirectTo = (url: URL) => {
    const response = NextResponse.redirect(url)
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie))
    return response
  }

  // ── 2. Protect dashboard routes ──
  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  if (isProtected && !isAuthenticated) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = "/login"
    loginUrl.search = ""
    loginUrl.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`)
    return redirectTo(loginUrl)
  }

  // ── 3. Send signed-in users from the sign-in pages to their intended destination ──
  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p))
  if (isAuthPage && isAuthenticated) {
    const target = safeReturnPath(request.nextUrl.searchParams, "/dashboard")
    const destination = AUTH_PAGES.some((p) => target.startsWith(p)) ? "/dashboard" : target
    return redirectTo(new URL(destination, request.nextUrl.origin))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
