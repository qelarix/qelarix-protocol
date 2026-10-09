"use client"

import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { useWalletSession } from "@/components/providers/AuthSessionProvider"
import QlcSpending from "@/components/payments/QlcSpending"
import QlcTopUp from "@/components/payments/QlcTopUp"
import { QLC_COLORS, qlcPrimaryButton, qlcPrimaryButtonClass } from "@/components/payments/qlcUi"

interface TopUpModalProps {
  isOpen: boolean
  onClose: () => void
}

// Buy QLC: QLC spending (allowance) plus QLC packs paid on Solana. Qelarix is wallet-only, so a
// session without a wallet is sent to wallet sign-in instead of any legacy card checkout.
export default function TopUpModal({ isOpen, onClose }: TopUpModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const { walletAddress } = useWalletSession()

  useEffect(() => {
    if (!isOpen) return
    document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = "" }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isOpen, onClose])

  if (!isOpen || typeof document === "undefined") return null

  // Rendered into <body> so it always sits above every page layer (header, prompt bars, studios),
  // no matter which stacking context opened it.
  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", zIndex: 10000 }}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="buy-qlc-title"
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl p-6"
        style={{
          background: "linear-gradient(180deg, rgba(30, 24, 52, 0.94), rgba(16, 13, 28, 0.96))",
          border: `1px solid ${QLC_COLORS.line}`,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 24px 64px rgba(0,0,0,0.6)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
        }}
      >
        <div className="flex items-start justify-between" style={{ marginBottom: 18 }}>
          <div>
            <h2 id="buy-qlc-title" style={{ color: QLC_COLORS.text, fontSize: 20, fontWeight: 650, margin: 0 }}>Buy QLC</h2>
            <p style={{ color: QLC_COLORS.muted, fontSize: 13, margin: "4px 0 0" }}>One-time payment on Solana. No subscription.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="transition-colors hover:text-white"
            style={{ color: QLC_COLORS.faint, background: "transparent", border: "none", padding: 4, marginLeft: 16, cursor: "pointer" }}
            aria-label="Close"
          >
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {walletAddress ? (
          <>
            <QlcSpending />
            <QlcTopUp />
          </>
        ) : (
          <div style={{ textAlign: "center", padding: "8px 0" }}>
            <p style={{ color: QLC_COLORS.muted, fontSize: 14, lineHeight: 1.6, margin: "0 0 16px" }}>
              Sign in with your Solana wallet to buy and spend QLC.
            </p>
            <Link href="/signup" className={qlcPrimaryButtonClass} style={{ ...qlcPrimaryButton, display: "block" }} onClick={onClose}>
              Connect wallet
            </Link>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
