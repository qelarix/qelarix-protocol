"use client"

import { useEffect, useRef, useState } from "react"
import TopUpModal from "@/components/TopUpModal"
import { QLC_COLORS, qlcPrimaryButton, qlcPrimaryButtonClass, qlcTextButton } from "@/components/payments/qlcUi"

// One global prompt for every page: when any Qelarix API call is refused because the wallet cannot pay
// (HTTP 402 with a billing code), show a clear popup with a direct way to fix it (Buy QLC / raise limit).
// Pages keep their own error handling; this only adds the shared next step. Access is never locked —
// the only limit on a generation is the user's balance and spending allowance.
// The same patch also catches a signed-out visitor trying to create (HTTP 401 on a POST to /api/)
// and shows a "Connect your wallet" popup that leads to the wallet sign-in and back.

type FundsCode = "insufficient_qlc" | "insufficient_credits" | "qlc_allowance_low" | "qlc_setup_required"

const COPY: Record<FundsCode, { title: string; action: string }> = {
  insufficient_qlc: { title: "Not enough QLC", action: "Buy QLC" },
  insufficient_credits: { title: "Not enough QLC", action: "Buy QLC" },
  qlc_allowance_low: { title: "Spending limit too low", action: "Raise limit" },
  qlc_setup_required: { title: "Enable QLC first", action: "Enable QLC" },
}

const EVENT = "qelarix:funds-required"
const SIGN_IN_EVENT = "qelarix:sign-in-required"
const LIMIT_EVENT = "qelarix:charge-above-limit"
let fetchPatched = false

function patchFetchOnce() {
  if (fetchPatched || typeof window === "undefined") return
  fetchPatched = true
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init)
    if (res.status === 401) {
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
        const path = url.startsWith(window.location.origin) ? url.slice(window.location.origin.length) : url
        // Only actions (POST and friends) prompt; background reads by signed-out visitors stay silent.
        if (method !== "GET" && path.startsWith("/api/") && !path.startsWith("/api/auth/")) {
          window.dispatchEvent(new Event(SIGN_IN_EVENT))
        }
      } catch {
        /* never break the original request */
      }
    }
    if (res.status === 503) {
      // A creation above the on-chain per-charge cap: show it in the middle of the screen, not as a toast.
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const sameOriginApi = url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`)
        if (sameOriginApi) {
          const body = (await res.clone().json().catch(() => null)) as { code?: string; error?: string } | null
          if (body?.code === "charge_above_limit") {
            window.dispatchEvent(new CustomEvent(LIMIT_EVENT, { detail: { message: body.error ?? "" } }))
          }
        }
      } catch {
        /* never break the original request */
      }
    }
    if (res.status === 402) {
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const sameOriginApi = url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`)
        if (sameOriginApi) {
          const body = (await res.clone().json().catch(() => null)) as { code?: string; error?: string } | null
          const code = body?.code as FundsCode | undefined
          if (code && code in COPY) {
            window.dispatchEvent(new CustomEvent(EVENT, { detail: { code, message: body?.error ?? "" } }))
          }
        }
      } catch {
        /* never break the original request */
      }
    }
    return res
  }
}

export default function QlcFundsPrompt() {
  const [prompt, setPrompt] = useState<{ code: FundsCode; message: string } | null>(null)
  const [buyOpen, setBuyOpen] = useState(false)
  const [signIn, setSignIn] = useState(false)
  const [limitMessage, setLimitMessage] = useState<string | null>(null)
  const limitOverlayRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const signInOverlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    patchFetchOnce()
    const onFunds = (e: Event) => {
      const detail = (e as CustomEvent<{ code: FundsCode; message: string }>).detail
      if (detail?.code) setPrompt(detail)
    }
    const onSignIn = () => setSignIn(true)
    const onLimit = (e: Event) => {
      const message = (e as CustomEvent<{ message: string }>).detail?.message ?? ""
      // The modal states "Nothing was charged." on its own line, so drop it from the server text.
      setLimitMessage(message.replace(/\s*Nothing was charged\.?\s*$/, ""))
    }
    window.addEventListener(EVENT, onFunds)
    window.addEventListener(SIGN_IN_EVENT, onSignIn)
    window.addEventListener(LIMIT_EVENT, onLimit)
    return () => {
      window.removeEventListener(EVENT, onFunds)
      window.removeEventListener(SIGN_IN_EVENT, onSignIn)
      window.removeEventListener(LIMIT_EVENT, onLimit)
    }
  }, [])

  useEffect(() => {
    if (limitMessage === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLimitMessage(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [limitMessage])

  useEffect(() => {
    if (!signIn) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSignIn(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [signIn])

  const goToSignIn = () => {
    const here = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?callbackUrl=${encodeURIComponent(here)}`)
  }

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPrompt(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [prompt])

  const copy = prompt ? COPY[prompt.code] : null

  return (
    <>
      {prompt && copy && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-[10001] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          onClick={(e) => { if (e.target === overlayRef.current) setPrompt(null) }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="qlc-funds-title"
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 text-center"
            style={{
              background: "linear-gradient(180deg, rgba(30, 24, 52, 0.95), rgba(16, 13, 28, 0.97))",
              border: `1px solid ${QLC_COLORS.line}`,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 24px 64px rgba(0,0,0,0.6)",
            }}
          >
            <p style={{ margin: 0, color: QLC_COLORS.active, fontSize: 11, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase" }}>QLC</p>
            <h2 id="qlc-funds-title" style={{ margin: "8px 0 0", color: QLC_COLORS.text, fontSize: 20, fontWeight: 650 }}>{copy.title}</h2>
            {prompt.message && (
              <p style={{ margin: "8px 0 0", color: QLC_COLORS.muted, fontSize: 14, lineHeight: 1.5 }}>{prompt.message}</p>
            )}
            <p style={{ margin: "6px 0 0", color: QLC_COLORS.faint, fontSize: 12 }}>Nothing was charged.</p>
            <button
              type="button"
              className={qlcPrimaryButtonClass}
              style={{ ...qlcPrimaryButton, marginTop: 20 }}
              onClick={() => { setPrompt(null); setBuyOpen(true) }}
            >
              {copy.action}
            </button>
            <button type="button" style={{ ...qlcTextButton, marginTop: 8 }} onClick={() => setPrompt(null)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {signIn && !prompt && (
        <div
          ref={signInOverlayRef}
          className="fixed inset-0 z-[10001] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          onClick={(e) => { if (e.target === signInOverlayRef.current) setSignIn(false) }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="qlc-sign-in-title"
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 text-center"
            style={{
              background: "linear-gradient(180deg, rgba(30, 24, 52, 0.95), rgba(16, 13, 28, 0.97))",
              border: `1px solid ${QLC_COLORS.line}`,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 24px 64px rgba(0,0,0,0.6)",
            }}
          >
            <p style={{ margin: 0, color: QLC_COLORS.active, fontSize: 11, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase" }}>Wallet</p>
            <h2 id="qlc-sign-in-title" style={{ margin: "8px 0 0", color: QLC_COLORS.text, fontSize: 20, fontWeight: 650 }}>Connect your wallet</h2>
            <p style={{ margin: "8px 0 0", color: QLC_COLORS.muted, fontSize: 14, lineHeight: 1.5 }}>
              Sign in with your Solana wallet to create. New wallets receive free devnet QLC to try Qelarix.
            </p>
            <p style={{ margin: "6px 0 0", color: QLC_COLORS.faint, fontSize: 12 }}>Nothing was charged.</p>
            <button
              type="button"
              className={qlcPrimaryButtonClass}
              style={{ ...qlcPrimaryButton, marginTop: 20 }}
              onClick={goToSignIn}
            >
              Connect wallet
            </button>
            <button type="button" style={{ ...qlcTextButton, marginTop: 8 }} onClick={() => setSignIn(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {limitMessage !== null && !prompt && (
        <div
          ref={limitOverlayRef}
          className="fixed inset-0 z-[10001] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          onClick={(e) => { if (e.target === limitOverlayRef.current) setLimitMessage(null) }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="qlc-limit-title"
        >
          <div
            className="w-full max-w-md rounded-2xl p-7 text-center"
            style={{
              background: "linear-gradient(180deg, rgba(30, 24, 52, 0.95), rgba(16, 13, 28, 0.97))",
              border: `1px solid ${QLC_COLORS.line}`,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 24px 64px rgba(0,0,0,0.6)",
            }}
          >
            <p style={{ margin: 0, color: QLC_COLORS.active, fontSize: 12, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase" }}>Devnet test</p>
            <h2 id="qlc-limit-title" style={{ margin: "10px 0 0", color: QLC_COLORS.text, fontSize: 24, fontWeight: 650 }}>Above the test limit</h2>
            {limitMessage && (
              <p style={{ margin: "12px 0 0", color: QLC_COLORS.muted, fontSize: 16, lineHeight: 1.55 }}>{limitMessage}</p>
            )}
            <p style={{ margin: "10px 0 0", color: QLC_COLORS.faint, fontSize: 13 }}>Nothing was charged.</p>
            <button
              type="button"
              className={qlcPrimaryButtonClass}
              style={{ ...qlcPrimaryButton, marginTop: 22 }}
              onClick={() => setLimitMessage(null)}
            >
              Choose another option
            </button>
          </div>
        </div>
      )}
      <TopUpModal isOpen={buyOpen} onClose={() => setBuyOpen(false)} />
    </>
  )
}
