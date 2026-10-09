"use client"

// QLC spending for generations (GENERATION_BILLING=qlc): the wallet approves one finite spending limit
// ("Enable QLC"); generations then charge QLC without a wallet popup, and failed generations are refunded.
// The limit can be changed or revoked at any time. Qelarix pays the network fee and any rent. Each action
// is one transaction the wallet signs in its own app; the server confirms it before the UI reports success.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getBase58Decoder, getBase64Encoder } from "@solana/kit"
import { useSignAndSendTransaction } from "@solana/react"
import { useWallets, type UiWalletAccount } from "@wallet-standard/react"
import { useAuthSession, useWalletSession } from "@/components/providers/AuthSessionProvider"
import { DEVNET_PAUSED_DETAIL, DEVNET_PAUSED_MESSAGE } from "@/lib/billing/billingMessages"
import { formatTokenAmount } from "@/lib/payments/tokenAmount"
import { parseSolanaCluster } from "@/lib/solanaCluster"
import { isUserRejection, walletChainFor } from "@/lib/walletSignIn"
import { QLC_COLORS, qlcPanel, qlcPrimaryButton, qlcPrimaryButtonClass, qlcTextButton } from "./qlcUi"

const SIGN_AND_SEND_FEATURE = "solana:signAndSendTransaction"
const POLL_INTERVAL_MS = 2000
const POLL_LIMIT_MS = 90_000

interface SpendingState {
  amount: string
  allowance: string
  frozen: boolean
  member: boolean
  generationOpen: boolean | null
  allowanceDefault: number
  allowanceMax: number
}

type SignAndSend = ReturnType<typeof useSignAndSendTransaction>
type Action = { action: "approve"; amount: string } | { action: "revoke" }

const COLORS = QLC_COLORS
const primaryButton = qlcPrimaryButton
const textButton = qlcTextButton

const amountInput: React.CSSProperties = {
  width: 96, background: "rgba(255,255,255,0.05)", border: "none", borderRadius: 8, color: COLORS.text,
  fontSize: 14, padding: "6px 10px", textAlign: "right", outline: "none",
}

const qlc = (baseUnits: string) => formatTokenAmount(baseUnits, 2, 0)

/** The limit to offer in the input: the wallet's current limit when it has one, otherwise the default. */
function suggestedLimit(s: SpendingState): string {
  const current = Number(s.allowance) / 100
  return current > 0 ? String(current) : String(s.allowanceDefault)
}

async function readSpending(): Promise<SpendingState | null> {
  try {
    const res = await fetch("/api/qlc/balance", { cache: "no-store" })
    const data = (await res.json()) as Partial<SpendingState> & { status?: string; billing?: string }
    if (data.status !== "ok" || data.billing !== "qlc") return null
    return {
      amount: data.amount ?? "0",
      allowance: data.allowance ?? "0",
      frozen: data.frozen === true,
      member: data.member === true,
      generationOpen: data.generationOpen ?? null,
      allowanceDefault: data.allowanceDefault ?? 500,
      allowanceMax: data.allowanceMax ?? 10_000,
    }
  } catch {
    return null
  }
}

function SignButton({ account, chain, label, onSign, quiet }: {
  account: UiWalletAccount
  chain: `solana:${string}`
  label: string
  onSign: (signAndSend: SignAndSend) => void
  quiet?: boolean
}) {
  const signAndSend = useSignAndSendTransaction(account, chain)
  return (
    <button type="button" className={quiet ? undefined : qlcPrimaryButtonClass} style={quiet ? { ...textButton, color: COLORS.danger } : primaryButton} onClick={() => onSign(signAndSend)}>
      {label}
    </button>
  )
}

export default function QlcSpending() {
  const { walletAddress } = useWalletSession()
  const { update } = useAuthSession()
  const wallets = useWallets()
  const [state, setState] = useState<SpendingState | null>(null)
  const [limit, setLimit] = useState("")
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null)
  const active = useRef(true)
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

  const cluster = parseSolanaCluster(process.env.NEXT_PUBLIC_SOLANA_CLUSTER)
  const chain = cluster ? walletChainFor(cluster) : null
  // The wallet account that signed in, if its wallet is connected and can send transactions.
  const signer = useMemo(() => {
    for (const wallet of wallets) {
      if (!wallet.features.includes(SIGN_AND_SEND_FEATURE)) continue
      const account = wallet.accounts.find((a) => a.address === walletAddress)
      if (account) return account
    }
    return null
  }, [wallets, walletAddress])

  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    void readSpending().then((next) => {
      if (cancelled) return
      setState(next)
      if (next) setLimit(suggestedLimit(next))
    })
    return () => {
      cancelled = true
    }
  }, [walletAddress])

  const run = useCallback(async (request: Action, signAndSend: SignAndSend) => {
    setNotice(null)
    setBusy("Preparing…")
    const built = await fetch("/api/qlc/allowance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) })
      .then(async (res) => ({ ok: res.ok, data: (await res.json().catch(() => ({}))) as { transaction?: string; error?: string } }))
      .catch(() => ({ ok: false, data: { error: "Solana network is unavailable. Please try again." } as { transaction?: string; error?: string } }))
    if (!active.current) return
    if (!built.ok || !built.data.transaction) {
      setBusy(null)
      setNotice({ tone: "error", text: built.data.error ?? "The transaction could not be prepared. Please try again." })
      return
    }

    setBusy("Approve in your wallet within a minute…")
    let signature: string
    try {
      const sent = await signAndSend({ transaction: getBase64Encoder().encode(built.data.transaction) as Uint8Array })
      signature = getBase58Decoder().decode(sent.signature)
    } catch (err) {
      if (!active.current) return
      setBusy(null)
      if (!isUserRejection(err)) console.warn("[qlc/spending] wallet could not send:", err instanceof Error ? err.message : err)
      setNotice({
        tone: "error",
        text: isUserRejection(err)
          ? "You declined the transaction. Nothing changed."
          : "The request expired or could not be sent. This usually happens when the wallet stays open for more than a minute. Nothing changed. Please try again and approve right away.",
      })
      return
    }

    setBusy("Confirming on Solana…")
    const deadline = Date.now() + POLL_LIMIT_MS
    while (active.current) {
      const res = await fetch("/api/qlc/allowance/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signature }) }).catch(() => null)
      const data = res ? ((await res.json().catch(() => ({}))) as { status?: string; error?: string; delivery?: { delivered?: number } | null }) : {}
      if (!active.current) return
      if (data.status === "confirmed") {
        const next = await readSpending()
        if (!active.current) return
        setState(next)
        if (next) setLimit(suggestedLimit(next))
        setBusy(null)
        setEditing(false)
        const delivered = (data.delivery?.delivered ?? 0) > 0
        setNotice({
          tone: "success",
          text: request.action === "revoke"
            ? "QLC spending is off. Re-enable it to generate."
            : delivered ? "QLC spending is on, and your Devnet QLC was delivered to your wallet." : "QLC spending is on.",
        })
        window.dispatchEvent(new Event("credits-updated"))
        void refreshSession.current()
        return
      }
      if (data.status === "failed") {
        setBusy(null)
        setNotice({ tone: "error", text: data.error ?? "The transaction failed on chain. Nothing changed." })
        return
      }
      if (Date.now() >= deadline) {
        setBusy(null)
        setNotice({ tone: "error", text: "Not confirmed yet. If your wallet sent it, it applies once Solana confirms it." })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }, [])

  if (!walletAddress || !state || !chain) return null

  // On only while the wallet can actually be charged: a member with a limit left. After "Turn off" the
  // wallet stays a member but has no limit, so the card offers "Enable QLC" again.
  const enabled = state.member && !state.frozen && BigInt(state.allowance || "0") > BigInt(0)
  const paused = state.generationOpen === false
  const limitAction: Action = { action: "approve", amount: limit }
  const limitLabel = `${Number(limit || 0).toLocaleString("en-US")} QLC`

  return (
    <div style={{ ...qlcPanel, marginBottom: 20, padding: "16px 18px" }}>
      {paused && (
        <div role="status" style={{ marginBottom: 10 }}>
          <p style={{ color: COLORS.text, fontSize: 14, fontWeight: 600, margin: "0 0 2px" }}>{DEVNET_PAUSED_MESSAGE}</p>
          <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>{DEVNET_PAUSED_DETAIL}</p>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ color: COLORS.text, fontSize: 14, fontWeight: 600 }}>QLC spending</span>
        <span style={{ color: enabled ? COLORS.success : COLORS.muted, fontSize: 12 }}>{enabled ? "On" : "Off"}</span>
      </div>
      <p style={{ color: COLORS.muted, fontSize: 12, margin: "4px 0 12px", lineHeight: 1.6 }}>
        {enabled
          ? `Balance ${qlc(state.amount)} QLC · spending limit left ${qlc(state.allowance)} QLC. Generations are charged from this limit without a wallet popup; failed generations are refunded.`
          : "Approve a spending limit once. Generations are then charged in QLC without a wallet popup, and failed generations are refunded. Qelarix pays the network fee."}
      </p>

      {busy ? (
        <p style={{ color: COLORS.active, fontSize: 13, margin: 0 }}>{busy}</p>
      ) : !signer ? (
        <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>Connect the wallet you signed in with to change QLC spending.</p>
      ) : !enabled || editing ? (
        <div>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, color: COLORS.muted, fontSize: 13 }}>
            Spending limit
            <span>
              <input
                inputMode="decimal"
                value={limit}
                onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ""))}
                style={amountInput}
                aria-label="Spending limit in QLC"
              />
              <span style={{ marginLeft: 6 }}>QLC</span>
            </span>
          </label>
          <SignButton
            account={signer}
            chain={chain}
            label={enabled ? `Set limit to ${limitLabel}` : `Enable QLC (${limitLabel})`}
            onSign={(signAndSend) => void run(limitAction, signAndSend)}
          />
          {editing && (
            <button type="button" style={textButton} onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 18 }}>
          <button type="button" style={{ ...textButton, color: COLORS.active }} onClick={() => setEditing(true)}>
            Change limit
          </button>
          <SignButton account={signer} chain={chain} label="Turn off" quiet onSign={(signAndSend) => void run({ action: "revoke" }, signAndSend)} />
        </div>
      )}

      {notice && (
        <p role={notice.tone === "error" ? "alert" : "status"} style={{ color: notice.tone === "error" ? COLORS.error : COLORS.success, fontSize: 12, margin: "10px 0 0" }}>
          {notice.text}
        </p>
      )}
    </div>
  )
}
