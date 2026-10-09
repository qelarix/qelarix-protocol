"use client"

// Wallet-only sign-in: Wallet Standard discovery and connect, then Sign In With Solana through
// Supabase (src/lib/walletSignIn.ts). The session is a Supabase cookie session that server code
// resolves through src/lib/authSession.ts.
import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useConnect, useDisconnect, useWallets, type UiWallet, type UiWalletAccount } from "@wallet-standard/react"
import { useSignIn, useSignMessage } from "@solana/react"
import { useWalletSession } from "@/components/providers/AuthSessionProvider"
import { showWalletStatus } from "@/components/Toaster"
import { safeReturnPath } from "@/lib/authRedirect"
import { createClient } from "@/lib/supabase/client"
import { getSolanaCluster } from "@/lib/solanaCluster"
import { shortWalletAddress } from "@/lib/walletIdentity"
import {
  isUserRejection,
  isWalletSignInEnabled,
  signInWithSolanaWallet,
  walletChainFor,
  walletSignInMethod,
  type WalletSignInOutcome,
  type WalletSigner,
} from "@/lib/walletSignIn"

const COLORS = { text: "#F4F7FB", muted: "#AAB2BF", faint: "#4A5568", error: "#F87171", warning: "#F5B85A", accent: "#7B61FF" }

const optionButton: React.CSSProperties = {
  width: "100%", background: "#1A1F2A", border: "1px solid #2A2F3A", color: COLORS.text, borderRadius: 12,
  padding: "13px 24px", cursor: "pointer", fontSize: 15, fontWeight: 500, marginBottom: 10, display: "flex",
  alignItems: "center", justifyContent: "flex-start", gap: 14, paddingLeft: 28,
}

const textButton: React.CSSProperties = {
  background: "transparent", border: "none", color: COLORS.muted, fontSize: 13, cursor: "pointer", padding: "6px 0",
}

// Wallets Qelarix supports. They are always listed on the sign-in screen, installed or not, so users see
// their options. An installed wallet connects through Wallet Standard; a missing one explains how to get it.
const SUPPORTED_WALLETS = [
  { name: "Phantom", url: "https://phantom.com/download", tile: "#AB9FF2", tileText: "#1B1036" },
  { name: "Solflare", url: "https://solflare.com/download", tile: "#FCE94B", tileText: "#15130A" },
  { name: "Backpack", url: "https://backpack.app/download", tile: "#E33E3F", tileText: "#FFFFFF" },
] as const
type SupportedWallet = (typeof SUPPORTED_WALLETS)[number]

const matchesSupported = (wallet: UiWallet, supported: SupportedWallet) =>
  wallet.name.toLowerCase().includes(supported.name.toLowerCase())

/** A supported wallet that is not installed in this browser: visible, but it explains instead of connecting. */
function MissingWalletOption({ supported, onPick }: { supported: SupportedWallet; onPick: (w: SupportedWallet) => void }) {
  return (
    <button type="button" style={{ ...optionButton, color: COLORS.muted, background: "#141821" }} onClick={() => onPick(supported)}>
      <span
        aria-hidden
        style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 6, background: supported.tile, color: supported.tileText, fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
      >
        {supported.name[0]}
      </span>
      Continue with {supported.name}
    </button>
  )
}

function Notice({ tone, children }: { tone: "error" | "warning" | "muted"; children: React.ReactNode }) {
  const color = tone === "error" ? COLORS.error : tone === "warning" ? COLORS.warning : COLORS.muted
  return <p role={tone === "muted" ? undefined : "alert"} style={{ color, fontSize: 13, lineHeight: 1.6, margin: "4px 0 14px", textAlign: "center" }}>{children}</p>
}

function WalletOption({ wallet, onConnected, onError }: {
  wallet: UiWallet
  onConnected: (wallet: UiWallet, account: UiWalletAccount) => void
  onError: (message: string, status: "failed" | "cancelled") => void
}) {
  const [isConnecting, connect] = useConnect(wallet)
  return (
    <button
      type="button"
      style={{ ...optionButton, opacity: isConnecting ? 0.7 : 1 }}
      disabled={isConnecting}
      onClick={async () => {
        try {
          const accounts = await connect()
          const account = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0]
          if (account) onConnected(wallet, account)
          else onError("The wallet did not share an account.", "failed")
        } catch (err) {
          if (isUserRejection(err)) onError("You declined the connection request.", "cancelled")
          else onError(`Could not connect to ${wallet.name}.`, "failed")
        }
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={wallet.icon} alt="" width={22} height={22} style={{ borderRadius: 6, flexShrink: 0 }} />
      {isConnecting ? `Connecting to ${wallet.name}…` : `Continue with ${wallet.name}`}
    </button>
  )
}

interface SigningProps {
  wallet: UiWallet
  account: UiWalletAccount
  onDone: (outcome: WalletSignInOutcome) => void
  onBack: () => void
}

/** Wallets with Sign In With Solana (`solana:signIn`) build and sign the standard SIWS message themselves. */
function SignInStep(props: SigningProps) {
  const signIn = useSignIn(props.wallet)
  const signer = useMemo<WalletSigner>(() => ({
    signIn: async (input) => {
      const { account, signedMessage, signature } = await signIn(input)
      return { account: { ...account, publicKey: Uint8Array.from(account.publicKey) }, signedMessage, signature }
    },
  }), [signIn])
  return <SigningPrompt {...props} signer={signer} />
}

/** Wallets without Sign In With Solana sign Supabase's message text through `solana:signMessage`. */
function SignMessageStep(props: SigningProps) {
  const signMessage = useSignMessage(props.account)
  const signer = useMemo<WalletSigner>(() => ({
    signMessage: async (message) => (await signMessage({ message })).signature,
  }), [signMessage])
  return <SigningPrompt {...props} signer={signer} />
}

function SigningStep(props: SigningProps) {
  return walletSignInMethod(props.wallet.features) === "sign-in" ? <SignInStep {...props} /> : <SignMessageStep {...props} />
}

/** Runs the sign-in request once and shows the wallet prompt. */
function SigningPrompt({ wallet, account, signer, onDone, onBack }: SigningProps & { signer: WalletSigner }) {
  const [, disconnect] = useDisconnect(wallet)
  const supabase = useMemo(() => createClient(), [])
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    signInWithSolanaWallet(supabase, account.address, signer)
      .then(onDone)
      .catch((err) => onDone({ kind: "error", detail: err instanceof Error ? err.message : String(err) }))
  }, [supabase, account.address, signer, onDone])

  return (
    <div style={{ textAlign: "center" }}>
      <p style={{ color: COLORS.text, fontSize: 15, margin: "0 0 6px" }}>Approve the sign-in message in {wallet.name}</p>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: "0 0 14px" }}>
        {shortWalletAddress(account.address)} · no transaction, no fee
      </p>
      <button type="button" style={textButton} onClick={async () => { await disconnect().catch(() => {}); onBack() }}>
        Use a different wallet
      </button>
    </div>
  )
}

export default function WalletSignIn() {
  const router = useRouter()
  const params = useSearchParams()
  const { setSignedInWallet } = useWalletSession()
  const cluster = getSolanaCluster()
  const enabled = isWalletSignInEnabled(cluster)
  const chain = enabled ? walletChainFor(cluster) : null
  const wallets = useWallets()
  const signingWallets = useMemo(
    () => wallets.filter((w) => walletSignInMethod(w.features) !== null && w.chains.some((c) => c.startsWith("solana:"))),
    [wallets],
  )
  const [selected, setSelected] = useState<{ wallet: UiWallet; account: UiWalletAccount } | null>(null)
  const [message, setMessage] = useState<{ tone: "error" | "warning" | "muted"; text: string } | null>(
    params.get("reason") === "wallet-changed" ? { tone: "warning", text: "Your wallet account changed, so you were signed out. Sign in again to continue." } : null,
  )
  const [redirecting, setRedirecting] = useState(false)
  const [missing, setMissing] = useState<SupportedWallet | null>(null)

  if (!enabled) {
    return <Notice tone="muted">Wallet sign-in is not enabled in this environment.</Notice>
  }

  const handleConnected = (wallet: UiWallet, account: UiWalletAccount) => {
    if (chain && !account.chains.includes(chain) && !wallet.chains.includes(chain)) {
      setMessage({ tone: "warning", text: `Switch ${wallet.name} to Solana ${cluster === "devnet" ? "Devnet" : cluster} and try again.` })
      return
    }
    setMessage(null)
    setSelected({ wallet, account })
  }

  const handleOutcome = (outcome: WalletSignInOutcome) => {
    if (outcome.kind === "signed-in" && selected) {
      setSignedInWallet(selected.wallet)
      showWalletStatus("connected", selected.wallet.name)
      setRedirecting(true)
      router.replace(safeReturnPath(params))
      router.refresh()
      return
    }
    const walletName = selected?.wallet.name
    setSelected(null)
    if (outcome.kind === "rejected") {
      setMessage({ tone: "warning", text: "You declined the signature request. Nothing was signed." })
      showWalletStatus("cancelled")
    } else if (outcome.kind === "unavailable") {
      setMessage({ tone: "error", text: "Wallet sign-in is temporarily unavailable. Please try again later." })
      showWalletStatus("failed", walletName)
    } else if (outcome.kind === "error") {
      setMessage({ tone: "error", text: `Sign-in failed: ${outcome.detail}` })
      showWalletStatus("failed", walletName)
    }
  }

  if (redirecting) return <Notice tone="muted">Signed in. Redirecting…</Notice>

  return (
    <div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {selected ? (
        <SigningStep key={selected.account.address} wallet={selected.wallet} account={selected.account} onDone={handleOutcome} onBack={() => setSelected(null)} />
      ) : (
        <>
          {missing && (
            <Notice tone="warning">
              {missing.name} is not installed in this browser. Choose an installed wallet below, or{" "}
              <a href={missing.url} target="_blank" rel="noreferrer" style={{ color: COLORS.accent }}>install {missing.name}</a>{" "}
              and reload this page.
            </Notice>
          )}
          {SUPPORTED_WALLETS.map((supported) => {
            const installed = signingWallets.find((w) => matchesSupported(w, supported))
            return installed ? (
              <WalletOption
                key={supported.name}
                wallet={installed}
                onConnected={handleConnected}
                onError={(text, status) => {
                  setMessage({ tone: status === "cancelled" ? "warning" : "error", text })
                  showWalletStatus(status, installed.name)
                }}
              />
            ) : (
              <MissingWalletOption key={supported.name} supported={supported} onPick={(w) => { setMessage(null); setMissing(w) }} />
            )
          })}
          {/* Any other Wallet Standard wallet the browser offers is listed after the supported ones. */}
          {signingWallets
            .filter((w) => !SUPPORTED_WALLETS.some((supported) => matchesSupported(w, supported)))
            .map((wallet) => (
              <WalletOption
                key={wallet.name}
                wallet={wallet}
                onConnected={handleConnected}
                onError={(text, status) => {
                  setMessage({ tone: status === "cancelled" ? "warning" : "error", text })
                  showWalletStatus(status, wallet.name)
                }}
              />
            ))}
        </>
      )}
      <p style={{ color: COLORS.faint, fontSize: 12, textAlign: "center", margin: "16px 0 0", lineHeight: 1.6 }}>
        Your wallet signs a message to prove ownership. Qelarix never asks for your seed phrase or private key.
      </p>
    </div>
  )
}
