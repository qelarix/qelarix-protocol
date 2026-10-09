"use client"

import { useEffect, useRef, useState } from "react"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { useRouter } from "next/navigation"

interface SubscriptionModalProps {
  isOpen: boolean
  isAnnual?: boolean
  onClose: () => void
}

type PlanId = "free" | "starter" | "pro" | "business" | "ultra"

interface PlanDef {
  id: PlanId
  name: string
  price: number
  annualPrice: number
  credits: string
  features: string[]
  notIncluded?: string[]
  highlighted?: boolean
  planId?: string
}

const PLANS: PlanDef[] = [
  {
    id: "free",
    name: "Free",
    price: 0,
    annualPrice: 0,
    credits: "50",
    features: [
      "50 credits every month",
      "Flux Schnell & SDXL",
      "CogVideoX (video)",
      "Public gallery",
      "720p output",
    ],
    notIncluded: ["Priority generation", "Pro models", "API access"],
  },
  {
    id: "starter",
    name: "Starter",
    price: 15,
    annualPrice: 12,
    credits: "600",
    planId: "starter",
    features: [
      "500 credits every month",
      "12 image models",
      "5 video models",
      "1080p output",
      "Private gallery",
      "Faster generation",
    ],
    notIncluded: ["Pro models (Kling, Runway)", "API access"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 36,
    annualPrice: 29,
    credits: "2.500",
    planId: "pro",
    highlighted: true,
    features: [
      "2,000 credits every month",
      "All 22 models included",
      "Cinema Studio access",
      "4K output",
      "API access (REST)",
      "Priority queue",
      "Rollover credits (1 mo.)",
    ],
    notIncluded: ["White label"],
  },
  {
    id: "ultra",
    name: "Ultra",
    price: 79,
    annualPrice: 62,
    credits: "3.500",
    planId: "ultra",
    features: [
      "3,500 credits every month",
      "All 22 models included",
      "White Label option",
      "Client Portal",
      "Make.com integration",
      "Dedicated support",
      "API (no rate limit)",
      "Rollover credits (2 mo.)",
    ],
  },
  {
    id: "business",
    name: "Business",
    price: 237,
    annualPrice: 185,
    credits: "10.000",
    planId: "business",
    features: [
      "10,000 credits every month",
      "All 22 models + early access",
      "Zero queue priority",
      "White Label option",
      "Client Portal (unlimited)",
      "Make.com integration",
      "Dedicated support + SLA",
      "API (no rate limit)",
      "Rollover credits (3 mo.)",
    ],
  },
]

export default function SubscriptionModal({ isOpen, isAnnual = false, onClose }: SubscriptionModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const { data: session } = useAuthSession()
  const router = useRouter()
  const [loadingPlan, setLoadingPlan] = useState<PlanId | null>(null)
  const [portalLoading, setPortalLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentPlan = (session?.user as { plan?: PlanId } | undefined)?.plan ?? "free"
  const userId = session?.user?.id

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

  if (!isOpen) return null

  async function handleSelectPlan(plan: PlanDef) {
    if (plan.id === "free") {
      onClose()
      return
    }
    if (!userId) {
      router.push("/login")
      return
    }
    if (plan.id === currentPlan) return

    setError(null)
    setLoadingPlan(plan.id)
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.planId, userId, mode: "subscription" }),
      })
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data.error ?? "Checkout failed")
      window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.")
      setLoadingPlan(null)
    }
  }

  async function handlePortal() {
    if (!userId) {
      router.push("/login")
      return
    }
    setPortalLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      })
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data.error ?? "Portal failed")
      window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.")
      setPortalLoading(false)
    }
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(10px)" }}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div
        className="w-full max-w-4xl my-8 rounded-2xl p-6 sm:p-8"
        style={{
          background: "rgba(12,12,20,0.98)",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 25px 80px rgba(0,0,0,0.7)",
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-2">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Choose a plan</h2>
            <p className="text-white/50 text-sm mt-1">No hidden fees. Cancel anytime.</p>
          </div>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white transition-colors p-1 ml-4 flex-shrink-0"
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {isAnnual && (
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-6"
            style={{ background: "rgba(16,185,129,0.15)", color: "#34D399", border: "1px solid rgba(16,185,129,0.3)" }}
          >
            <span>✓</span>
            Annual plan — save up to 20%
          </div>
        )}

        {/* Plan grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
          {PLANS.map((plan) => {
            const price = isAnnual ? plan.annualPrice : plan.price
            const isCurrent = plan.id === currentPlan
            const isLoading = loadingPlan === plan.id

            return (
              <div
                key={plan.id}
                className="rounded-xl p-5 flex flex-col relative"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: plan.highlighted
                    ? "2px solid #7B61FF"
                    : isCurrent
                    ? "1px solid rgba(255,255,255,0.25)"
                    : "1px solid rgba(255,255,255,0.07)",
                  boxShadow: plan.highlighted ? "0 0 30px rgba(123,97,255,0.25)" : "none",
                }}
              >
                {/* Badges */}
                {plan.highlighted && !isCurrent && (
                  <div
                    className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] font-bold px-3 py-0.5 rounded-full text-white whitespace-nowrap"
                    style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
                  >
                    Most popular
                  </div>
                )}
                {isCurrent && (
                  <div
                    className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] font-bold px-3 py-0.5 rounded-full whitespace-nowrap"
                    style={{
                      background: "rgba(255,255,255,0.15)",
                      color: "#ffffff",
                      border: "1px solid rgba(255,255,255,0.3)",
                    }}
                  >
                    Your plan
                  </div>
                )}

                {/* Name & price */}
                <div className="mb-4 mt-2">
                  <h3 className="text-base font-bold text-white mb-1">{plan.name}</h3>
                  <div className="flex items-end gap-1">
                    <span className="text-2xl font-extrabold text-white">
                      {plan.id === "free" ? "€0" : `€${price}`}
                    </span>
                    {plan.id !== "free" && (
                      <span className="text-white/40 text-xs mb-1">/mj.</span>
                    )}
                  </div>
                  <p className="text-white/40 text-xs mt-1">{plan.credits} credits/mo.</p>
                </div>

                {/* Features */}
                <ul className="space-y-1.5 flex-1 mb-4">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-xs text-white/70">
                      <span className="text-green-400 flex-shrink-0 mt-0.5">✓</span>
                      {f}
                    </li>
                  ))}
                  {plan.notIncluded?.map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-xs text-white/25">
                      <span className="flex-shrink-0 mt-0.5">✗</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <button
                  onClick={() => handleSelectPlan(plan)}
                  disabled={isCurrent || isLoading}
                  className="w-full py-2.5 rounded-lg font-semibold text-sm text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed hover:opacity-90 active:scale-[0.98]"
                  style={{
                    background: isCurrent
                      ? "rgba(255,255,255,0.08)"
                      : plan.highlighted
                      ? "linear-gradient(135deg, #7B61FF, #3BE7FF)"
                      : plan.id === "free"
                      ? "rgba(255,255,255,0.08)"
                      : "rgba(255,255,255,0.1)",
                    border:
                      isCurrent || plan.id === "free"
                        ? "1px solid rgba(255,255,255,0.15)"
                        : "none",
                    boxShadow: plan.highlighted && !isCurrent ? "0 0 20px rgba(123,97,255,0.3)" : "none",
                  }}
                >
                  {isLoading ? (
                    <span className="inline-flex items-center gap-2">
                      <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                      Redirecting...
                    </span>
                  ) : isCurrent ? (
                    "Current plan"
                  ) : plan.id === "free" ? (
                    "Start for free"
                  ) : (
                    `Choose ${plan.name} →`
                  )}
                </button>
              </div>
            )
          })}
        </div>

        {/* Error */}
        {error && (
          <div
            className="mt-4 px-4 py-3 rounded-xl text-sm text-red-300"
            style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
          >
            {error}
          </div>
        )}

        {/* Manage subscription */}
        {currentPlan !== "free" && userId && (
          <div className="mt-6 pt-5" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <p className="text-white/40 text-xs">
                Manage billing, cancel or change your plan in the Stripe portal.
              </p>
              <button
                onClick={handlePortal}
                disabled={portalLoading}
                className="flex-shrink-0 px-5 py-2 rounded-lg text-sm font-semibold text-white/70 hover:text-white transition-all disabled:opacity-50"
                style={{ border: "1px solid rgba(255,255,255,0.15)" }}
              >
                {portalLoading ? "Loading..." : "Manage subscription →"}
              </button>
            </div>
          </div>
        )}

        <p className="text-center text-white/25 text-xs mt-5">
          Secure SSL payment · Cancel anytime · GDPR compliant
        </p>
      </div>
    </div>
  )
}
