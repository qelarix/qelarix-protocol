"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { PlanId } from "@/lib/plans"
import { hasPageAccess } from "@/lib/plans"
import UpgradeModal from "@/components/UpgradeModal"

interface SidebarProps {
  plan: PlanId | 'tester'
}

interface NavItem {
  href: string
  label: string
  icon: React.ReactNode
  comingSoon?: boolean
  badge?: string
  badgeColor?: string
  section?: string
  pageKey?: 'canvas' | 'viralMode' | 'storyboard' | 'cinemaStudio' | 'aiInfluencer' | 'apps'
  requiredPlan?: 'starter' | 'pro' | 'business' | 'ultra'
}

const NAV: NavItem[] = [
  {
    href: "/playground",
    icon: "⚡",
    label: "Playground",
    section: "Create",
  },
  {
    href: "/dashboard",
    label: "Dashboard",
    section: "Home",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v9a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1v-9" />
      </svg>
    ),
  },
  {
    href: "/video",
    label: "Video",
    section: "Generators",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    href: "/image",
    label: "Images",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
      </svg>
    ),
  },
  {
    href: "/character",
    label: "Character AI",
    badge: "NOVO",
    badgeColor: "#ec4899",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
    ),
  },
  {
    href: "/audio",
    label: "Audio",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
      </svg>
    ),
  },
  {
    href: "/edit",
    label: "Editing",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
      </svg>
    ),
  },
  {
    href: "/community",
    label: "Community",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
    ),
  },
  {
    href: "/brand-kit",
    label: "Brand Kit",
    badge: "Starter+",
    badgeColor: "#3b82f6",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" /><path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
      </svg>
    ),
  },
  // ── Studio ────────────────────────────────────────────────────────────────
  {
    href: "/storyboard",
    label: "Storyboard",
    section: undefined,
    pageKey: 'storyboard',
    requiredPlan: 'pro',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
      </svg>
    ),
  },
  {
    href: "/influencer",
    label: "AI Influencer",
    pageKey: 'aiInfluencer',
    requiredPlan: 'pro',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
    ),
    badge: "Business",
    badgeColor: "#f59e0b",
  },
  {
    href: "/canvas",
    label: "Canvas",
    badge: "NOVO",
    badgeColor: "#10b981",
    pageKey: 'canvas',
    requiredPlan: 'starter',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
      </svg>
    ),
  },
  {
    href: "/marketing",
    label: "Viral Mode",
    badge: "Starter+",
    badgeColor: "#3b82f6",
    pageKey: 'viralMode',
    requiredPlan: 'starter',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46" />
      </svg>
    ),
  },
  // ── Apps ──────────────────────────────────────────────────────────────────
  {
    href: "/apps",
    label: "AI Apps",
    section: "Apps",
    badge: "24",
    badgeColor: "#a855f7",
    pageKey: 'apps',
    requiredPlan: 'pro',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
      </svg>
    ),
  },
  {
    href: "/apps/shorts-generator",
    label: "Shorts Generator",
    badge: "NOVO",
    badgeColor: "#ec4899",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
      </svg>
    ),
  },
  {
    href: "/apps/lip-sync",
    label: "Lip Sync Studio",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
      </svg>
    ),
  },
  {
    href: "/profile",
    icon: "👤",
    label: "Profile",
    section: "Account",
  },
]

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function Sidebar({ plan }: SidebarProps) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [upgradeModal, setUpgradeModal] = useState<{
    open: boolean
    requiredPlan: 'starter' | 'pro' | 'business' | 'ultra'
    featureName: string
  }>({ open: false, requiredPlan: 'starter', featureName: '' })

  const sidebarContent = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Nav */}
      <nav
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "12px",
          scrollbarWidth: "none",
        }}
      >
        {NAV.map((item, idx) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" &&
              item.href !== "/apps" &&
              pathname.startsWith(item.href))
          const prevItem = NAV[idx - 1]
          const showSection = item.section && item.section !== prevItem?.section
          const isLocked = !!(item.pageKey && !hasPageAccess(plan, item.pageKey))

          const itemStyle = isActive ? {
            background: "rgba(123,97,255,0.12)",
            borderLeft: "2px solid #7B61FF",
            color: "#7B61FF",
            paddingLeft: "10px",
          } : isLocked ? {
            color: "rgba(255,255,255,0.35)",
          } : item.comingSoon ? undefined : {
            color: "rgba(255,255,255,0.6)",
          }

          const innerContent = (
            <>
              <span style={isActive ? { color: "#7B61FF" } : isLocked ? { color: "rgba(255,255,255,0.25)" } : {}}>{item.icon}</span>
              <span>{item.label}</span>
              {isLocked && (
                <span className="ml-auto" style={{ color: "rgba(255,255,255,0.25)", fontSize: 12 }}>🔒</span>
              )}
              {!isLocked && item.comingSoon && (
                <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-white/5 text-white/30">
                  Soon
                </span>
              )}
              {!isLocked && item.badge && !item.comingSoon && (
                <span
                  className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{
                    color: item.badgeColor || "#a855f7",
                    background: `${item.badgeColor || "#a855f7"}22`,
                    border: `1px solid ${item.badgeColor || "#a855f7"}44`,
                  }}
                >
                  {item.badge}
                </span>
              )}
              {!isLocked && isActive && !item.badge && !item.comingSoon && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-violet-500" />
              )}
            </>
          )

          return (
            <div key={item.href}>
              {showSection && (
                <div className="px-3 pt-4 pb-1">
                  <span className="text-[10px] font-semibold text-white/25 uppercase tracking-widest">
                    {item.section}
                  </span>
                </div>
              )}
              {isLocked ? (
                <button
                  onClick={() => setUpgradeModal({
                    open: true,
                    requiredPlan: item.requiredPlan!,
                    featureName: item.label,
                  })}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer"
                  style={itemStyle}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "";
                  }}
                >
                  {innerContent}
                </button>
              ) : (
                <Link
                  href={item.comingSoon ? "#" : item.href}
                  onClick={() => setMobileOpen(false)}
                  className={[
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                    item.comingSoon ? "text-white/25 cursor-not-allowed" : "",
                  ].join(" ")}
                  style={itemStyle}
                  onMouseEnter={!isActive && !item.comingSoon ? (e) => {
                    (e.currentTarget as HTMLAnchorElement).style.background = "rgba(123,97,255,0.06)";
                    (e.currentTarget as HTMLAnchorElement).style.color = "#F4F7FB";
                  } : undefined}
                  onMouseLeave={!isActive && !item.comingSoon ? (e) => {
                    (e.currentTarget as HTMLAnchorElement).style.background = "";
                    (e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.6)";
                  } : undefined}
                >
                  {innerContent}
                </Link>
              )}
            </div>
          )
        })}
      </nav>

    </div>
  )

  return (
    <>
      <UpgradeModal
        isOpen={upgradeModal.open}
        onClose={() => setUpgradeModal(prev => ({ ...prev, open: false }))}
        requiredPlan={upgradeModal.requiredPlan}
        featureName={upgradeModal.featureName}
      />
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex flex-col w-60 flex-shrink-0"
        style={{
          background: "#080808",
          borderRight: "1px solid rgba(42,47,58,0.6)",
          height: "100vh",
          position: "sticky",
          top: 0,
        }}
      >
        {sidebarContent}
      </aside>

      {/* Mobile: hamburger button */}
      <button
        className="md:hidden fixed top-4 left-4 z-50 p-2 rounded-lg text-white/70 hover:text-white transition-colors"
        style={{ background: "rgba(13,13,20,0.9)", border: "1px solid rgba(255,255,255,0.1)" }}
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Mobile: drawer overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 flex"
          onClick={() => setMobileOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <aside
            className="relative w-60 h-full flex flex-col"
            style={{ background: "#080808", borderRight: "1px solid rgba(42,47,58,0.6)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="absolute top-4 right-4 text-white/50 hover:text-white transition-colors"
              onClick={() => setMobileOpen(false)}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  )
}
