"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useAuthSession, useWalletSession } from "@/components/providers/AuthSessionProvider"
import QlcSpending from "@/components/payments/QlcSpending"
import QlcTopUp from "@/components/payments/QlcTopUp"
import { QLC_COLORS, qlcPackCard, qlcPanel, qlcPrimaryButton, qlcPrimaryButtonClass } from "@/components/payments/qlcUi"
import QelarixBackdrop from "@/components/ui/QelarixBackdrop"
import { qlcPackEstimate } from "@/components/payments/qlcEstimates"
import { CREDITS, VIDEO_PRICES } from "@/lib/credits"
import { formatTokenAmount, formatUsd } from "@/lib/payments/tokenAmount"

// Pricing is QLC only: one-time QLC packs paid on Solana, spent per generation. There are no plans
// or subscriptions. Example costs are read from the same price list the billing layer charges.

interface PublicPack {
  id: string
  qlcAmount: string
  usdValueMicros: string
  listUsdValueMicros: string | null
  label: string
  highlighted: boolean
}

type PacksState = { status: "loading" } | { status: "ok"; cluster: string; packs: PublicPack[] } | { status: "unavailable" }

const EXAMPLES: Array<{ label: string; detail: string; qlc: number }> = [
  { label: "Background removal", detail: "Apps", qlc: CREDITS.muapi.background_remover },
  { label: "Nano Banana 2 image", detail: "1K", qlc: CREDITS.image.nanobanana2 },
  { label: "GPT Image 2", detail: "Standard", qlc: CREDITS.image.gptimage2 },
  { label: "Kling 3.0 video", detail: "5 s", qlc: VIDEO_PRICES.kling3_standard[5].no },
  { label: "Veo 3.1 Fast video", detail: "8 s with audio", qlc: VIDEO_PRICES.veo31[8].yes },
]

const STEPS = [
  { title: "Connect your wallet", body: "Sign in with a Solana wallet such as Phantom. Your wallet is your Qelarix account." },
  { title: "Get QLC", body: "Buy a pack with USDC or SOL. QLC is delivered to your wallet on chain." },
  { title: "Create", body: "Each generation is charged in QLC from a spending limit you set once. Failed generations are refunded automatically." },
]

const FAQ = [
  { q: "What is QLC?", a: "QLC (Qelarix Credit) is an on-chain credit on Solana that pays for generations on Qelarix. Your balance lives in your own wallet." },
  { q: "Is there a subscription?", a: "No. You buy QLC once and spend it as you create. Unused QLC stays in your wallet." },
  { q: "What happens if a generation fails?", a: "The QLC for that generation is returned to your wallet automatically. You only pay for results." },
  { q: "Why approve a spending limit?", a: "You approve a limit once, so generations can be charged without a wallet popup each time. You can change or turn it off at any time." },
  { q: "Which payment methods are supported?", a: "USDC and SOL on Solana. The price is quoted at payment time and confirmed on chain before QLC is delivered." },
]

const qlcAmount = (baseUnits: string) => formatTokenAmount(baseUnits, 2, 0)

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ color: QLC_COLORS.text, fontSize: 18, fontWeight: 600, margin: "0 0 16px" }}>{children}</h2>
}

function PublicPacks({ state }: { state: PacksState }) {
  if (state.status === "loading") {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...qlcPackCard(false), height: 128, opacity: 0.5 }} />)}
      </div>
    )
  }
  if (state.status !== "ok" || state.packs.length === 0) {
    return <p style={{ color: QLC_COLORS.muted, fontSize: 14 }}>QLC packs are not available right now.</p>
  }
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {state.packs.map((pack) => (
        <div key={pack.id} style={qlcPackCard(pack.highlighted)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <span style={{ color: QLC_COLORS.muted, fontSize: 12 }}>{pack.label}</span>
            {pack.highlighted && <span style={{ color: QLC_COLORS.active, fontSize: 11, fontWeight: 600 }}>Most popular</span>}
          </div>
          <p style={{ margin: "10px 0 2px", fontSize: 24, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {qlcAmount(pack.qlcAmount)} <span style={{ fontSize: 13, fontWeight: 500, color: QLC_COLORS.muted }}>QLC</span>
          </p>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: QLC_COLORS.text }}>
            {pack.listUsdValueMicros && (
              <span style={{ color: QLC_COLORS.faint, textDecoration: "line-through", fontWeight: 400, marginRight: 6 }}>{formatUsd(pack.listUsdValueMicros)}</span>
            )}
            {formatUsd(pack.usdValueMicros)}
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 12, color: QLC_COLORS.muted }}>{qlcPackEstimate(pack.qlcAmount)}</p>
        </div>
      ))}
    </div>
  )
}

export default function PricingPage() {
  const { status } = useAuthSession()
  const { walletAddress } = useWalletSession()
  const [packs, setPacks] = useState<PacksState>({ status: "loading" })
  const signedIn = status === "authenticated" && !!walletAddress

  useEffect(() => {
    let cancelled = false
    fetch("/api/payments/packs", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setPacks(data?.status === "ok" ? { status: "ok", cluster: data.cluster, packs: data.packs ?? [] } : { status: "unavailable" })
      })
      .catch(() => { if (!cancelled) setPacks({ status: "unavailable" }) })
    return () => { cancelled = true }
  }, [])

  const devnet = packs.status === "ok" && packs.cluster === "devnet"

  return (
    <div className="min-h-screen" style={{ color: QLC_COLORS.text }}>
      <QelarixBackdrop />
      <main className="relative max-w-4xl mx-auto px-4 sm:px-6 pt-14 pb-24" style={{ zIndex: 1 }}>
        <header style={{ marginBottom: 40 }}>
          <p style={{ color: QLC_COLORS.muted, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", margin: "0 0 14px" }}>Pricing</p>
          <h1 style={{ fontSize: "clamp(30px, 5vw, 44px)", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, margin: "0 0 14px" }}>
            Pay per creation.
          </h1>
          <p style={{ color: QLC_COLORS.muted, fontSize: 16, lineHeight: 1.65, maxWidth: 560, margin: 0 }}>
            Qelarix runs on QLC, an on-chain credit on Solana. Buy QLC once and spend it as you create. No subscription, and failed generations are refunded automatically.
          </p>
        </header>

        <section style={{ marginBottom: 48 }}>
          <SectionTitle>{signedIn ? "Your QLC" : "QLC packs"}</SectionTitle>
          {signedIn ? (
            <div style={{ ...qlcPanel, padding: 20 }}>
              <QlcSpending />
              <QlcTopUp />
            </div>
          ) : (
            <>
              <PublicPacks state={packs} />
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, marginTop: 18 }}>
                <Link
                  href="/signup?callbackUrl=%2Fpricing"
                  className={qlcPrimaryButtonClass}
                  style={{ ...qlcPrimaryButton, width: "auto", display: "inline-block", textAlign: "center", padding: "11px 22px" }}
                >
                  Connect wallet to buy
                </Link>
                <span style={{ color: QLC_COLORS.muted, fontSize: 13 }}>Pay with USDC or SOL on Solana.</span>
              </div>
            </>
          )}
          {devnet && (
            <p style={{ color: QLC_COLORS.faint, fontSize: 12, margin: "14px 0 0" }}>
              Solana Devnet: payments use test USDC and SOL and have no monetary value.
            </p>
          )}
        </section>

        <section style={{ marginBottom: 48 }}>
          <SectionTitle>What QLC buys</SectionTitle>
          <div style={{ ...qlcPanel, overflow: "hidden" }}>
            {EXAMPLES.map((row, i) => (
              <div
                key={row.label}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "13px 18px",
                  borderTop: i === 0 ? "none" : `1px solid ${QLC_COLORS.line}`,
                }}
              >
                <span style={{ fontSize: 14 }}>
                  {row.label} <span style={{ color: QLC_COLORS.faint, fontSize: 13 }}>· {row.detail}</span>
                </span>
                <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{row.qlc} QLC</span>
              </div>
            ))}
          </div>
          <p style={{ color: QLC_COLORS.faint, fontSize: 12, margin: "10px 0 0" }}>
            Each generation shows its exact QLC cost before you start it. Pack estimates use Nano Banana 2 images and 5 s Kling 3.0 videos.
          </p>
        </section>

        <section style={{ marginBottom: 48 }}>
          <SectionTitle>How it works</SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {STEPS.map((step, i) => (
              <div key={step.title} style={{ ...qlcPanel, padding: 18 }}>
                <p style={{ color: QLC_COLORS.active, fontSize: 12, fontWeight: 600, margin: "0 0 10px", fontVariantNumeric: "tabular-nums" }}>
                  {String(i + 1).padStart(2, "0")}
                </p>
                <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 6px" }}>{step.title}</p>
                <p style={{ color: QLC_COLORS.muted, fontSize: 13, lineHeight: 1.6, margin: 0 }}>{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle>Questions</SectionTitle>
          <div style={{ ...qlcPanel, overflow: "hidden" }}>
            {FAQ.map((item, i) => (
              <details key={item.q} style={{ borderTop: i === 0 ? "none" : `1px solid ${QLC_COLORS.line}` }}>
                <summary style={{ cursor: "pointer", listStyle: "none", padding: "14px 18px", fontSize: 14, fontWeight: 500 }}>{item.q}</summary>
                <p style={{ color: QLC_COLORS.muted, fontSize: 14, lineHeight: 1.65, margin: 0, padding: "0 18px 16px" }}>{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
