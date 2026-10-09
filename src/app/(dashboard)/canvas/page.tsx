"use client"

import { useState } from "react"
import dynamic from "next/dynamic"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { hasPageAccess } from "@/lib/plans"
import type { PlanId } from "@/lib/plans"
import UpgradeModal from "@/components/UpgradeModal"

const CanvasApp = dynamic(() => import("@/components/canvas/CanvasApp"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center min-h-screen bg-[#050505]">
      <div className="flex flex-col items-center gap-3">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl animate-pulse"
          style={{ background: "rgba(123,97,255,0.15)", border: "1px solid rgba(123,97,255,0.3)" }}
        >
          🎨
        </div>
        <p className="text-white/40 text-sm">Loading canvas...</p>
      </div>
    </div>
  ),
})

export default function CanvasPage() {
  const { data: session } = useAuthSession()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userPlan = ((session?.user as any)?.plan ?? "free") as PlanId
  const [showUpgrade, setShowUpgrade] = useState(false)
  const hasAccess = hasPageAccess(userPlan, "canvas")

  if (!hasAccess) return (
    <>
      <div style={{
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        minHeight: "60vh", gap: 16, textAlign: "center",
      }}>
        <div style={{ fontSize: 48 }}>🔒</div>
        <h2 style={{ color: "#F4F7FB", fontSize: 22, fontWeight: 800 }}>
          This feature requires a higher plan
        </h2>
        <p style={{ color: "#AAB2BF", fontSize: 14 }}>
          Upgrade your plan to unlock this feature.
        </p>
        <button
          onClick={() => setShowUpgrade(true)}
          style={{
            background: "#7B61FF", color: "white",
            border: "none", borderRadius: 10,
            padding: "12px 28px", fontSize: 14,
            fontWeight: 700, cursor: "pointer",
          }}
        >
          Upgrade Now →
        </button>
      </div>
      <UpgradeModal
        isOpen={showUpgrade}
        onClose={() => setShowUpgrade(false)}
        requiredPlan="starter"
        featureName="Canvas"
      />
    </>
  )

  return <CanvasApp />
}
