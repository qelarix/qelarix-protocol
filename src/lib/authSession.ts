// Shared server-side authentication for Qelarix.
//
// Server code resolves the signed-in user only through this module, never through the auth
// library directly. Wallet-only: the one identity source is the Solana wallet session (Supabase
// Web3 / Sign In With Solana). Supabase sessions without a Solana wallet identity (e.g. email
// sign-ups) are not accepted, and no other session type exists.
import type { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createServerClient } from "@supabase/ssr"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { getSolanaWalletAddress } from "@/lib/walletIdentity"
import type { Plan } from "@/types/database"

export interface AuthUser {
  /** Qelarix user id (`profiles.id`). */
  id: string
  /** Always null: wallet accounts have no email. Kept for existing call sites. */
  email: string | null
  /** Plan from the profile. */
  plan: Plan | null
  /** Solana wallet the session was signed in with. */
  walletAddress: string | null
}

type CookieList = { name: string; value: string }[]

/** Supabase stores the session in `sb-<project>-auth-token` (optionally chunked as `.0`, `.1`, ...). */
const hasSupabaseSessionCookie = (list: CookieList) => list.some((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))

async function getWalletAuthUser(readCookies: () => CookieList): Promise<AuthUser | null> {
  if (!hasSupabaseSessionCookie(readCookies())) return null
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    // Read-only here; the middleware refreshes and writes session cookies.
    cookies: { getAll: readCookies, setAll() {} },
  })
  // getUser() validates the access token with Supabase Auth instead of trusting the cookie.
  const { data } = await supabase.auth.getUser()
  const walletAddress = getSolanaWalletAddress(data.user)
  if (!data.user || !walletAddress) return null

  const { data: profile } = await createSupabaseAdmin()
    .from("profiles")
    .select("plan")
    .eq("id", data.user.id)
    .maybeSingle<{ plan: Plan | null }>()
  return { id: data.user.id, email: null, plan: profile?.plan ?? null, walletAddress }
}

/** Signed-in user for an API route handler, or null when the request has no valid wallet session. */
export async function getRequestAuthUser(req: NextRequest): Promise<AuthUser | null> {
  return getWalletAuthUser(() => req.cookies.getAll())
}

/**
 * Signed-in user for a server component or a handler without a request object, or null when
 * there is no valid wallet session.
 */
export async function getServerAuthUser(): Promise<AuthUser | null> {
  const cookieStore = cookies()
  return getWalletAuthUser(() => cookieStore.getAll())
}
