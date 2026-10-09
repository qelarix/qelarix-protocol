"use client"

// Client-side counterpart of src/lib/authSession.ts: the one place client components read the
// signed-in user. Wallet-only: the session is the Solana wallet session (Supabase Web3).
// useAuthSession() keeps the { data, status, update } shape existing callers use.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { Session as SupabaseSession } from "@supabase/supabase-js"
import { getWalletFeature, useWallets, type UiWallet } from "@wallet-standard/react"
import { queueWalletStatus, toast } from "@/components/Toaster"
import { getSolanaCluster } from "@/lib/solanaCluster"
import { createClient } from "@/lib/supabase/client"
import { getSolanaWalletAddress, shortWalletAddress } from "@/lib/walletIdentity"
import type { Plan } from "@/types/database"

export type AuthSessionStatus = "loading" | "authenticated" | "unauthenticated"

export interface AuthSession {
  user: {
    id: string
    name?: string | null
    /** Always null: wallet accounts have no email. */
    email?: string | null
    image?: string | null
    plan: Plan
    credits: number
    walletAddress: string | null
    /** Approved internal (founder / team) wallet, computed on the server. */
    isInternal: boolean
  }
  expires: string
}

interface AuthSessionValue {
  data: AuthSession | null
  status: AuthSessionStatus
  /** Re-reads plan and credits for the current session. */
  update: () => Promise<AuthSession | null>
}

interface WalletSessionValue {
  walletAddress: string | null
  /** Records the wallet that just signed in so a wallet-side disconnect or account switch ends the session. */
  setSignedInWallet: (wallet: UiWallet | null) => void
  /** Ends the wallet session and disconnects the signed-in wallet. */
  signOut: (options?: { callbackUrl?: string }) => Promise<void>
}

interface WalletUser {
  id: string
  address: string
  expires: string
}

interface WalletProfile {
  internal?: boolean
  plan: Plan | null
  credits: number | null
  username: string | null
  avatar_url: string | null
}

const AuthSessionContext = createContext<AuthSessionValue | null>(null)
const WalletSessionContext = createContext<WalletSessionValue | null>(null)

function walletUserFrom(session: SupabaseSession | null): WalletUser | null {
  const address = getSolanaWalletAddress(session?.user)
  if (!session || !address) return null
  return { id: session.user.id, address, expires: new Date((session.expires_at ?? 0) * 1000).toISOString() }
}

// Display name of the signed-in wallet (e.g. "Phantom") for the sign-out status after a page reload.
const WALLET_NAME_KEY = "qelarix.signedInWalletName"

function rememberWalletName(name: string | null) {
  try {
    if (name) localStorage.setItem(WALLET_NAME_KEY, name)
    else localStorage.removeItem(WALLET_NAME_KEY)
  } catch {
    // Storage unavailable: the status falls back to a generic "Wallet".
  }
}

function rememberedWalletName(): string | null {
  try {
    return localStorage.getItem(WALLET_NAME_KEY)
  } catch {
    return null
  }
}

async function fetchWalletProfile(): Promise<WalletProfile | null> {
  const res = await fetch("/api/profile", { cache: "no-store" })
  if (!res.ok) return null
  const { profile, internal } = (await res.json()) as { profile?: WalletProfile; internal?: boolean }
  return profile ? { ...profile, internal: internal === true } : null
}

// Devnet test infrastructure: the Devnet beta credits are claimed once per browser session after
// wallet sign-in. The server refuses on any other cluster and decides campaign, eligibility, amount
// and idempotency; this only avoids a request on every page load.
interface DevnetBetaGrant {
  amount: number
  /** Granted as on-chain QLC (GENERATION_BILLING=qlc) rather than database credits. */
  qlc: boolean
  /** QLC only: already delivered to the wallet (otherwise it waits until the wallet enables QLC spending). */
  delivered: boolean
}

const devnetBetaClaims = new Map<string, Promise<DevnetBetaGrant | null>>()

/** The grant made by this call, otherwise null (already granted, not eligible, failed). */
function claimDevnetBetaCreditsOnce(userId: string): Promise<DevnetBetaGrant | null> {
  if (getSolanaCluster() !== "devnet") return Promise.resolve(null)
  const key = `qelarix.devnetBetaClaim.${userId}`
  try {
    if (sessionStorage.getItem(key)) return Promise.resolve(null)
  } catch {
    // Storage unavailable: the server-side claim is idempotent anyway.
  }
  let pending = devnetBetaClaims.get(userId)
  if (!pending) {
    pending = fetch("/api/credits/claim/devnet-beta", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) return null // Retried on a later page load; the session stays valid.
        const { grants, billing, delivery } = (await res.json()) as {
          grants?: { status?: string; amount?: number }[]
          billing?: string
          delivery?: { delivered?: number } | null
        }
        try {
          sessionStorage.setItem(key, "done")
        } catch {
          // Storage unavailable: a later call is a harmless already_granted.
        }
        const amount = grants?.find((grant) => grant.status === "granted")?.amount
        return amount ? { amount, qlc: billing === "qlc", delivered: (delivery?.delivered ?? 0) > 0 } : null
      })
      .catch(() => null)
      .finally(() => devnetBetaClaims.delete(userId))
    devnetBetaClaims.set(userId, pending)
  }
  return pending
}

export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), [])
  const wallets = useWallets()
  const [walletUser, setWalletUser] = useState<WalletUser | null>(null)
  const [walletChecked, setWalletChecked] = useState(false)
  const [walletProfile, setWalletProfile] = useState<WalletProfile | null>(null)
  const signedInWallet = useRef<UiWallet | null>(null)

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setWalletUser(walletUserFrom(data.session))
      setWalletChecked(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setWalletUser(walletUserFrom(session))
      setWalletChecked(true)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [supabase])

  useEffect(() => {
    if (!walletUser) {
      setWalletProfile(null)
      return
    }
    let active = true
    // On Devnet the beta credits are claimed first, so the profile read below already shows them.
    claimDevnetBetaCreditsOnce(walletUser.id)
      .then(async (granted) => {
        const profile = await fetchWalletProfile()
        if (!active) return
        setWalletProfile(profile)
        if (granted) {
          window.dispatchEvent(new Event("credits-updated"))
          const amount = granted.amount.toLocaleString("en-US")
          if (!granted.qlc) toast.success(`${amount} Devnet test credits added`, { id: "devnet-beta-credits", duration: 4000 })
          else if (granted.delivered) toast.success(`${amount} Devnet QLC added to your wallet`, { id: "devnet-beta-credits", duration: 4000 })
          else toast.success(`${amount} Devnet QLC reserved. Enable QLC spending in Top up to receive it.`, { id: "devnet-beta-credits", duration: 6000 })
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [walletUser])

  const signOut = useCallback(
    async ({ callbackUrl = "/" }: { callbackUrl?: string } = {}) => {
      const wallet = signedInWallet.current
      const walletName = wallet?.name ?? rememberedWalletName()
      signedInWallet.current = null
      if (wallet) {
        try {
          await (getWalletFeature(wallet, "standard:disconnect") as { disconnect: () => Promise<void> }).disconnect()
        } catch {
          // Wallet without disconnect support, or already disconnected.
        }
      }
      const signedOut = await supabase.auth.signOut().then(({ error }) => !error, () => false)
      setWalletUser(null)
      rememberWalletName(null)
      // Shown on the page the navigation lands on.
      if (signedOut) queueWalletStatus("disconnected", walletName)
      window.location.assign(callbackUrl)
    },
    [supabase],
  )

  // The wallet that signed in switched to another account or disconnected: end the session.
  useEffect(() => {
    const wallet = signedInWallet.current
    if (!wallet || !walletUser) return
    const current = wallets.find((w) => w.name === wallet.name)
    if (current && !current.accounts.some((account) => account.address === walletUser.address)) {
      void signOut({ callbackUrl: "/login?reason=wallet-changed" })
    }
  }, [wallets, walletUser, signOut])

  const walletSession = useMemo<AuthSession | null>(
    () =>
      walletUser && {
        user: {
          id: walletUser.id,
          name: walletProfile?.username || shortWalletAddress(walletUser.address),
          email: null,
          image: walletProfile?.avatar_url ?? null,
          plan: walletProfile?.plan ?? "free",
          credits: walletProfile?.credits ?? 0,
          walletAddress: walletUser.address,
          isInternal: walletProfile?.internal === true,
        },
        expires: walletUser.expires,
      },
    [walletUser, walletProfile],
  )

  const authValue = useMemo<AuthSessionValue>(() => {
    if (walletSession) {
      return {
        data: walletSession,
        status: "authenticated",
        update: async () => {
          const profile = await fetchWalletProfile().catch(() => null)
          if (profile) setWalletProfile(profile)
          return walletSession
        },
      }
    }
    return { data: null, status: walletChecked ? "unauthenticated" : "loading", update: async () => null }
  }, [walletSession, walletChecked])

  const walletValue = useMemo<WalletSessionValue>(
    () => ({
      walletAddress: walletUser?.address ?? null,
      setSignedInWallet: (wallet) => {
        signedInWallet.current = wallet
        rememberWalletName(wallet?.name ?? null)
      },
      signOut,
    }),
    [walletUser, signOut],
  )

  return (
    <AuthSessionContext.Provider value={authValue}>
      <WalletSessionContext.Provider value={walletValue}>{children}</WalletSessionContext.Provider>
    </AuthSessionContext.Provider>
  )
}

export function useAuthSession(): AuthSessionValue {
  const value = useContext(AuthSessionContext)
  if (!value) throw new Error("useAuthSession must be used inside AuthSessionProvider")
  return value
}

export function useWalletSession(): WalletSessionValue {
  const value = useContext(WalletSessionContext)
  if (!value) throw new Error("useWalletSession must be used inside AuthSessionProvider")
  return value
}
