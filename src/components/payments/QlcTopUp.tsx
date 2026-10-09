"use client"

// Buy QLC with any payable asset (USDC, SOL, …): pick a pack, get a server quote, approve one
// transfer in the wallet, then the server verifies the finalized payment and delivers QLC on chain.
// The UI never reports success before the server confirms the payment and the delivery.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getBase58Decoder, getBase64Encoder } from "@solana/kit"
import { useSignAndSendTransaction } from "@solana/react"
import { useConnect, useWallets, type UiWallet, type UiWalletAccount } from "@wallet-standard/react"
import { useAuthSession, useWalletSession } from "@/components/providers/AuthSessionProvider"
import { formatTokenAmount, formatUsd } from "@/lib/payments/tokenAmount"
import { shortWalletAddress } from "@/lib/walletIdentity"
import { isUserRejection } from "@/lib/walletSignIn"
import { qlcPackEstimate } from "./qlcEstimates"
import { QLC_COLORS, qlcPackCard, qlcPrimaryButton, qlcPrimaryButtonClass, qlcTextButton } from "./qlcUi"

const SIGN_AND_SEND_FEATURE = "solana:signAndSendTransaction"
const PENDING_PAYMENT_KEY = "qelarix:qlc-payment"
const POLL_INTERVAL_MS = 3000
const POLL_LIMIT_MS = 120_000

interface OfferedPack {
  id: string
  qlcAmount: string
  usdValueMicros: string
  listUsdValueMicros: string | null
  label: string
  badge: string | null
  highlighted: boolean
}

interface OfferedAsset {
  id: string
  symbol: string
  kind: string
  decimals: number
}

interface Offer {
  cluster: string
  chain: `solana:${string}`
  packs: OfferedPack[]
  assets: OfferedAsset[]
}

interface Quote {
  id: string
  qlcAmount: string
  usdValueMicros: string
  asset: OfferedAsset
  paymentAmount: string
  expiresAt: string
}

interface PendingPayment {
  walletAddress: string
  intentId: string
  signature: string | null
}

type SignAndSend = ReturnType<typeof useSignAndSendTransaction>

type Phase =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "packs" }
  | { kind: "quoting"; pack: OfferedPack }
  | { kind: "confirm"; pack: OfferedPack; quote: Quote }
  | { kind: "working"; step: "preparing" | "signing" | "verifying" | "delivering" }
  | { kind: "unconfirmed"; pending: PendingPayment }
  | { kind: "success"; qlcAmount: string; signature: string; balance: string | null }
  | { kind: "failed"; message: string; retry: OfferedPack | null }

const COLORS = QLC_COLORS
const primaryButton = qlcPrimaryButton
const textButton = { ...qlcTextButton, padding: "8px 0" }

const START_ERRORS: Record<string, string> = {
  disabled: "QLC purchases are not available right now.",
  wallet_required: "Sign in with your Solana wallet to buy QLC.",
  unknown_pack: "This pack is no longer offered. Please choose another one.",
  unknown_asset: "This payment option is not available right now.",
  too_many_open_intents: "You have several unfinished payments. Wait a few minutes before starting a new one.",
  treasury_not_ready: "This payment option is not available right now.",
  insufficient_sol: "Your wallet needs a small amount of SOL to pay the network fee.",
  price_unavailable: "A reliable price is not available right now. Please try again in a moment.",
  expired: "This quote expired. Please get a new one.",
  unavailable: "The Solana network is unavailable. Please try again.",
}

const VERIFY_ERRORS: Record<string, string> = {
  transaction_failed: "The transaction failed on Solana, so nothing was transferred and no QLC was delivered.",
  expired: "The payment arrived after this quote expired, so no QLC was delivered. Contact support with the transaction signature.",
  signature_used: "This transaction was already used for another purchase. No QLC was delivered.",
  unknown_intent: "This payment could not be found.",
}

const qlc = (baseUnits: string) => formatTokenAmount(baseUnits, 2, 0)

function readPending(walletAddress: string): PendingPayment | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_PAYMENT_KEY) ?? "null") as PendingPayment | null
    return value && value.walletAddress === walletAddress && typeof value.intentId === "string" ? value : null
  } catch {
    return null
  }
}

function writePending(value: PendingPayment | null) {
  try {
    if (value) localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify(value))
    else localStorage.removeItem(PENDING_PAYMENT_KEY)
  } catch {
    // Storage unavailable: verification still works while this view stays open.
  }
}

/** POSTs JSON and never throws: network failures and 503s come back as status "unavailable". */
async function postJson<T>(url: string, body: unknown): Promise<Partial<T> & { status: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const data = (await res.json().catch(() => ({}))) as Partial<T> & { status?: string }
    return { ...data, status: res.status === 503 ? "unavailable" : data.status ?? "error" }
  } catch {
    return { status: "unavailable" } as Partial<T> & { status: string }
  }
}

function networkName(cluster: string): string {
  return cluster === "devnet" ? "Solana Devnet" : "Solana"
}

function useCountdown(expiresAt: string | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  return expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000)) : 0
}

function PayButton({ account, chain, label, onPay }: {
  account: UiWalletAccount
  chain: `solana:${string}`
  label: string
  onPay: (signAndSend: SignAndSend) => void
}) {
  const signAndSend = useSignAndSendTransaction(account, chain)
  return (
    <button type="button" className={qlcPrimaryButtonClass} style={primaryButton} onClick={() => onPay(signAndSend)}>
      {label}
    </button>
  )
}

function ConnectButton({ wallet, walletAddress, onConnected, onMismatch }: {
  wallet: UiWallet
  walletAddress: string
  onConnected: (wallet: UiWallet) => void
  onMismatch: (wallet: UiWallet) => void
}) {
  const [isConnecting, connect] = useConnect(wallet)
  return (
    <button
      type="button"
      className={qlcPrimaryButtonClass} style={{ ...primaryButton, marginBottom: 8, opacity: isConnecting ? 0.75 : 1 }}
      disabled={isConnecting}
      onClick={async () => {
        try {
          const accounts = await connect()
          if (accounts.some((account) => account.address === walletAddress)) onConnected(wallet)
          else onMismatch(wallet)
        } catch {
          onMismatch(wallet)
        }
      }}
    >
      {isConnecting ? `Connecting to ${wallet.name}…` : `Connect ${wallet.name} to pay`}
    </button>
  )
}

export default function QlcTopUp() {
  const { walletAddress, setSignedInWallet } = useWalletSession()
  const { update } = useAuthSession()
  const wallets = useWallets()
  const [offer, setOffer] = useState<Offer | null>(null)
  const [assetId, setAssetId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [walletNotice, setWalletNotice] = useState<string | null>(null)
  const active = useRef(true)
  // Refreshing the session after a payment recreates `update`; a ref keeps verify (and the offer
  // effect that depends on it) stable so the success view is not replaced.
  const refreshSession = useRef(update)
  useEffect(() => {
    refreshSession.current = update
  }, [update])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  // The wallet account that signed in, if its wallet is connected and can send transactions.
  const payer = useMemo(() => {
    for (const wallet of wallets) {
      if (!wallet.features.includes(SIGN_AND_SEND_FEATURE)) continue
      const account = wallet.accounts.find((a) => a.address === walletAddress)
      if (account) return { wallet, account }
    }
    return null
  }, [wallets, walletAddress])
  const payWallets = useMemo(() => wallets.filter((w) => w.features.includes(SIGN_AND_SEND_FEATURE)), [wallets])
  const confirmExpiry = useCountdown(phase.kind === "confirm" ? phase.quote.expiresAt : null)

  const verify = useCallback(async (pending: PendingPayment) => {
    setPhase({ kind: "working", step: "verifying" })
    const deadline = Date.now() + POLL_LIMIT_MS
    while (active.current) {
      const result = await postJson<{ qlcAmount?: string; signature?: string; reason?: string; delivery?: { status: string } }>(
        `/api/payments/intents/${pending.intentId}/confirm`,
        { signature: pending.signature },
      )
      if (!active.current) return
      if (result.status === "paid") {
        if (result.delivery?.status === "delivered") {
          writePending(null)
          const balance = await fetch("/api/qlc/balance", { cache: "no-store" })
            .then((res) => res.json() as Promise<{ status: string; amount?: string }>)
            .then((data) => (data.status === "ok" && data.amount ? data.amount : null))
            .catch(() => null)
          if (!active.current) return
          setPhase({ kind: "success", qlcAmount: result.qlcAmount ?? "0", signature: result.signature ?? "", balance })
          void refreshSession.current()
          return
        }
        // Paid and recorded; the QLC delivery is still being executed. Keep the record so a reopened
        // view resumes, and never ask the user to pay again.
        writePending({ ...pending, signature: result.signature ?? pending.signature })
        setPhase({ kind: "working", step: "delivering" })
      } else if (result.status !== "pending" && result.status !== "unavailable") {
        writePending(null)
        if (result.status === "intent_already_paid") {
          setPhase({ kind: "failed", message: "This quote was already paid by another transaction. If you paid twice, contact support.", retry: null })
        } else if (result.status === "expired") {
          setPhase({ kind: "failed", message: "This quote expired and no payment was found for it. Nothing was delivered.", retry: null })
        } else {
          const reason = result.reason ?? result.status
          setPhase({ kind: "failed", message: VERIFY_ERRORS[reason] ?? `The payment could not be verified (${reason}). No QLC was delivered.`, retry: null })
        }
        return
      }
      if (Date.now() >= deadline) {
        setPhase({ kind: "unconfirmed", pending })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }, [])

  // Load the offer; resume a payment that was sent but not yet confirmed or delivered.
  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    fetch("/api/payments/offer", { cache: "no-store" })
      .then((res) => res.json().catch(() => ({ status: res.status === 503 ? "unavailable" : "error" })))
      .then((data: { status: string } & Partial<Offer>) => {
        if (cancelled) return
        if (data.status !== "ok" || !data.packs || !data.assets || !data.chain || !data.cluster) {
          setPhase({ kind: "unavailable", message: START_ERRORS[data.status] ?? "QLC purchases are not available right now." })
          return
        }
        setOffer({ cluster: data.cluster, chain: data.chain, packs: data.packs, assets: data.assets })
        setAssetId((current) => current ?? data.assets![0]?.id ?? null)
        const pending = readPending(walletAddress)
        if (pending) void verify(pending)
        else setPhase(data.packs.length > 0 ? { kind: "packs" } : { kind: "unavailable", message: "No QLC packs are offered right now." })
      })
      .catch(() => !cancelled && setPhase({ kind: "unavailable", message: START_ERRORS.unavailable }))
    return () => {
      cancelled = true
    }
  }, [walletAddress, verify])

  const requestQuote = useCallback(
    async (pack: OfferedPack) => {
      if (!assetId) return
      setWalletNotice(null)
      setPhase({ kind: "quoting", pack })
      const created = await postJson<{ intent?: Quote; symbol?: string; decimals?: number; required?: string; available?: string }>(
        "/api/payments/intents",
        { packId: pack.id, assetId },
      )
      if (!active.current) return
      if (created.status !== "ok" || !created.intent) {
        const message =
          created.status === "insufficient_funds"
            ? `Your wallet has ${formatTokenAmount(created.available ?? "0", created.decimals ?? 0)} ${created.symbol}; this pack needs ${formatTokenAmount(created.required ?? "0", created.decimals ?? 0)} ${created.symbol}.`
            : START_ERRORS[created.status] ?? "The payment could not be started. Please try again."
        setPhase({ kind: "failed", message, retry: created.status === "unknown_pack" ? null : pack })
        return
      }
      setPhase({ kind: "confirm", pack, quote: created.intent })
    },
    [assetId],
  )

  const pay = useCallback(
    async (quote: Quote, pack: OfferedPack, signAndSend: SignAndSend) => {
      if (!walletAddress) return
      setPhase({ kind: "working", step: "preparing" })
      // Always sign a freshly built transaction (new blockhash) for the stored quote.
      const fresh = await postJson<{ transaction?: string }>(`/api/payments/intents/${quote.id}/transaction`, {})
      if (!active.current) return
      if (fresh.status !== "ok" || !fresh.transaction) {
        setPhase({ kind: "failed", message: START_ERRORS[fresh.status] ?? "The payment could not be prepared. Please try again.", retry: pack })
        return
      }

      const pending: PendingPayment = { walletAddress, intentId: quote.id, signature: null }
      writePending(pending)
      setPhase({ kind: "working", step: "signing" })
      let signature: string
      try {
        const sent = await signAndSend({ transaction: getBase64Encoder().encode(fresh.transaction) as Uint8Array })
        signature = getBase58Decoder().decode(sent.signature)
      } catch (err) {
        if (!active.current) return
        if (isUserRejection(err)) {
          writePending(null)
          setPhase({ kind: "failed", message: "You declined the transaction. No payment was made.", retry: pack })
          return
        }
        // The wallet may have sent the transaction before failing: look it up by the quote reference.
        setPhase({ kind: "unconfirmed", pending })
        return
      }
      const sentPayment = { ...pending, signature }
      writePending(sentPayment)
      await verify(sentPayment)
    },
    [walletAddress, verify],
  )

  if (!walletAddress) {
    return <p style={{ color: COLORS.muted, fontSize: 14, textAlign: "center" }}>Sign in with your Solana wallet to buy QLC.</p>
  }

  const network = offer ? networkName(offer.cluster) : "Solana"
  const centered = (text: string, sub?: string) => (
    <div style={{ textAlign: "center", padding: "24px 0" }}>
      <p style={{ color: COLORS.text, fontSize: 15, margin: "0 0 6px" }}>{text}</p>
      {sub && <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>{sub}</p>}
    </div>
  )

  if (phase.kind === "loading") return centered("Loading QLC packs…")
  if (phase.kind === "unavailable") return centered(phase.message)
  if (phase.kind === "quoting") return centered("Getting your quote…")

  if (phase.kind === "working") {
    if (phase.step === "preparing") return centered("Preparing your payment…")
    if (phase.step === "signing") return centered(`Approve the payment in ${payer?.wallet.name ?? "your wallet"}`)
    if (phase.step === "verifying") return centered(`Confirming your payment on ${network}… This usually takes under a minute.`, "Keep this window open. Do not pay again.")
    return centered("Payment confirmed. Delivering your QLC…", "This takes a few seconds. Do not pay again.")
  }

  if (phase.kind === "unconfirmed") {
    return (
      <div style={{ textAlign: "center", padding: "16px 0" }}>
        <p style={{ color: COLORS.text, fontSize: 15, margin: "0 0 6px" }}>Your payment is not confirmed yet</p>
        <p style={{ color: COLORS.muted, fontSize: 13, margin: "0 0 16px", lineHeight: 1.6 }}>
          If your wallet sent it, your QLC is delivered as soon as the transaction is finalized. Do not pay again.
        </p>
        <button type="button" className={qlcPrimaryButtonClass} style={primaryButton} onClick={() => void verify(phase.pending)}>
          Check payment again
        </button>
        <button
          type="button"
          style={textButton}
          onClick={() => {
            writePending(null)
            setPhase({ kind: "packs" })
          }}
        >
          I did not send a payment
        </button>
      </div>
    )
  }

  if (phase.kind === "success") {
    return (
      <div style={{ textAlign: "center", padding: "16px 0" }}>
        <p style={{ color: COLORS.success, fontSize: 16, fontWeight: 600, margin: "0 0 6px" }}>+{qlc(phase.qlcAmount)} QLC delivered to your wallet</p>
        {phase.balance !== null && <p style={{ color: COLORS.text, fontSize: 14, margin: "0 0 6px" }}>QLC balance: {qlc(phase.balance)} QLC</p>}
        {phase.signature && offer && (
          <a
            href={`https://explorer.solana.com/tx/${phase.signature}${offer.cluster === "devnet" ? "?cluster=devnet" : ""}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: COLORS.muted, fontSize: 12 }}
          >
            View payment
          </a>
        )}
        <div>
          <button type="button" style={textButton} onClick={() => setPhase({ kind: "packs" })}>
            Buy more QLC
          </button>
        </div>
      </div>
    )
  }

  if (phase.kind === "failed") {
    return (
      <div style={{ textAlign: "center", padding: "16px 0" }}>
        <p role="alert" style={{ color: COLORS.error, fontSize: 14, margin: "0 0 16px", lineHeight: 1.6 }}>{phase.message}</p>
        {phase.retry && (
          <button type="button" className={qlcPrimaryButtonClass} style={primaryButton} onClick={() => void requestQuote(phase.retry!)}>
            Try again
          </button>
        )}
        <button type="button" style={textButton} onClick={() => setPhase({ kind: "packs" })}>
          Back to packs
        </button>
      </div>
    )
  }

  if (phase.kind === "confirm" && offer) {
    const { pack, quote } = phase
    const amount = `${formatTokenAmount(quote.paymentAmount, quote.asset.decimals)} ${quote.asset.symbol}`
    const expired = confirmExpiry === 0
    return (
      <div>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <p style={{ color: COLORS.text, fontSize: 18, fontWeight: 700, margin: "0 0 4px" }}>
            {qlc(quote.qlcAmount)} QLC for {amount}
          </p>
          <p style={{ color: COLORS.muted, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
            Pack value {formatUsd(quote.usdValueMicros)} · one payment on {network} from {shortWalletAddress(walletAddress)}.
            {" "}
            {expired ? "This quote expired." : `Quote valid for ${Math.floor(confirmExpiry / 60)}:${String(confirmExpiry % 60).padStart(2, "0")}.`}
          </p>
        </div>
        {walletNotice && <p role="alert" style={{ color: COLORS.error, fontSize: 13, textAlign: "center", margin: "0 0 12px" }}>{walletNotice}</p>}
        {expired ? (
          <button type="button" className={qlcPrimaryButtonClass} style={primaryButton} onClick={() => void requestQuote(pack)}>
            Get a new quote
          </button>
        ) : payer ? (
          <PayButton account={payer.account} chain={offer.chain} label={`Pay ${amount}`} onPay={(signAndSend) => void pay(quote, pack, signAndSend)} />
        ) : payWallets.length > 0 ? (
          payWallets.map((wallet) => (
            <ConnectButton
              key={wallet.name}
              wallet={wallet}
              walletAddress={walletAddress}
              onConnected={(connected) => {
                setWalletNotice(null)
                setSignedInWallet(connected)
              }}
              onMismatch={(other) => setWalletNotice(`Switch ${other.name} to ${shortWalletAddress(walletAddress)}, the wallet you signed in with.`)}
            />
          ))
        ) : (
          <p style={{ color: COLORS.muted, fontSize: 13, textAlign: "center" }}>No wallet that can send transactions was found in this browser.</p>
        )}
        <div style={{ textAlign: "center" }}>
          <button type="button" style={textButton} onClick={() => setPhase({ kind: "packs" })}>
            Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {offer && offer.assets.length > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 18, marginBottom: 14 }}>
          <span style={{ color: COLORS.muted, fontSize: 13 }}>Pay with</span>
          {offer.assets.map((asset) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => setAssetId(asset.id)}
              style={{ ...textButton, padding: 0, color: asset.id === assetId ? COLORS.active : COLORS.muted, fontWeight: asset.id === assetId ? 600 : 400 }}
            >
              {asset.symbol}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {(offer?.packs ?? []).map((pack) => (
          <button
            key={pack.id}
            onClick={() => void requestQuote(pack)}
            className="transition-colors hover:bg-white/[0.05]"
            style={{ ...qlcPackCard(pack.highlighted), cursor: "pointer" }}
          >
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <span style={{ color: COLORS.muted, fontSize: 12 }}>{pack.label}</span>
              {pack.highlighted && <span style={{ color: COLORS.active, fontSize: 11, fontWeight: 600 }}>Most popular</span>}
            </span>
            <span style={{ display: "block", margin: "10px 0 2px", fontSize: 22, fontWeight: 700 }}>
              {qlc(pack.qlcAmount)} <span style={{ fontSize: 13, fontWeight: 500, color: COLORS.muted }}>QLC</span>
            </span>
            <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>
              {pack.listUsdValueMicros && (
                <span style={{ color: COLORS.faint, textDecoration: "line-through", fontWeight: 400, marginRight: 6 }}>{formatUsd(pack.listUsdValueMicros)}</span>
              )}
              {formatUsd(pack.usdValueMicros)}
            </span>
            <span style={{ display: "block", marginTop: 8, fontSize: 12, color: COLORS.muted }}>{qlcPackEstimate(pack.qlcAmount)}</span>
          </button>
        ))}
      </div>
      <p style={{ color: COLORS.faint, fontSize: 12, textAlign: "center", margin: "16px 0 0" }}>
        Paid on {network}. QLC is delivered to your wallet after on-chain confirmation.
      </p>
    </div>
  )
}
