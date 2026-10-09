"use client";

import { Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useAuthSession, useWalletSession } from "@/components/providers/AuthSessionProvider";
import Logo from "@/components/Logo";
import TopUpModal from "@/components/TopUpModal";
import QIcon from "@/components/ui/QIcon";
import { QLC_COLORS } from "@/components/payments/qlcUi";
import { NavLinks, PricingLink, MobileNavLinks } from "@/components/NavLinks";
import "@/components/header.css";

// ─── Credits pill ───────────────────────────────────────────────────────────────

function CreditsPill({ credits, onClick }: { credits: number; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Your QLC balance — buy QLC"
      className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors hover:bg-white/10"
      style={{
        background: "rgba(109,94,246,0.12)",
        border: "1px solid rgba(140,124,255,0.28)",
        color: "#E4E0FF",
        cursor: onClick ? "pointer" : "default",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: QLC_COLORS.active }} aria-hidden="true" />
      <span>{credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      <span style={{ color: "#A79EFF", fontWeight: 600, letterSpacing: "0.04em" }}>QLC</span>
    </button>
  );
}

// ─── Nav skeleton — shown while NavLinks suspends ───────────────────────────────

function NavSkeleton() {
  return <div className="hidden md:flex flex-1" />;
}

// ─── Main Header ───────────────────────────────────────────────────────────────

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [credits, setCredits] = useState(0);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [profile, setProfile] = useState<any>(null);
  const router = useRouter();
  const { data: session, status } = useAuthSession();
  const { signOut, walletAddress } = useWalletSession();
  const isOwner = session?.user?.isInternal === true;
  const shortWallet = walletAddress ? `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}` : '';
  // Fetch credits when session loads
  useEffect(() => {
    if (!session?.user) return;
    fetch("/api/user/credits")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.credits != null) setCredits(data.credits); })
      .catch(() => {});
  }, [session]);

  // Fetch profile (username + avatar) when session loads
  useEffect(() => {
    if (!session?.user) return;
    fetch('/api/profile')
      .then(r => r.json())
      .then(data => { if (data.profile) setProfile(data.profile); });
  }, [session]);

  // Live-refresh profile after settings save
  useEffect(() => {
    const refresh = () => {
      fetch('/api/profile')
        .then(r => r.json())
        .then(data => { if (data.profile) setProfile(data.profile); });
    };
    window.addEventListener('profile-updated', refresh);
    return () => window.removeEventListener('profile-updated', refresh);
  }, []);

  useEffect(() => {
    const refresh = () => {
      fetch('/api/user/credits')
        .then(r => r.json())
        .then(data => { if (data.credits !== undefined) setCredits(data.credits); });
    };
    window.addEventListener('credits-updated', refresh);
    return () => window.removeEventListener('credits-updated', refresh);
  }, []);

  return (
    <>
      {/* header rendered immediately — no opacity:0 initial state */}
      <header
        className="fixed left-0 right-0 top-0 z-50"
        style={{
          // Clean solid dark navbar (reference): no liquid/glass overlay, no heavy blur. Subtle border bottom.
          background: "#08080c",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        {/* Near-full-width container (matches the source navbar's calc(100% - 20px)): logo far-left, actions far-right. */}
        <div className="w-full mx-auto px-4 sm:px-6 flex items-center justify-between h-14">

          {/* Logo */}
          <Link href="/" className="flex-shrink-0 mr-6">
            <Logo size="sm" />
          </Link>

          {/* Desktop nav — NavLinks uses usePathname, wrapped in Suspense */}
          <Suspense fallback={<NavSkeleton />}>
            <NavLinks />
          </Suspense>

          {/* Right side */}
          <div
            className="hidden md:flex items-center gap-3 flex-shrink-0"
            style={{
              // Source navbar divider between the nav (…Apps) and the actions group (Pricing/Profile/avatar):
              // .qhp-actions { border-left: 1px solid rgba(167,139,250,0.16); padding-left: 18px } + leading gap.
              marginLeft: 18,
              paddingLeft: 18,
              borderLeft: "1px solid rgba(167,139,250,0.16)",
            }}
          >
            <Suspense fallback={<div className="w-14 h-5 rounded" style={{ background: "rgba(255,255,255,0.05)" }} />}>
              <PricingLink />
            </Suspense>

            {status === "authenticated" ? (
              <>
                <CreditsPill credits={credits} onClick={() => setTopUpOpen(true)} />
                <Link
                  href="/profile"
                  style={{
                    color: '#F4F7FB',
                    fontSize: 14,
                    fontWeight: 500,
                    textDecoration: 'none',
                    padding: '6px 10px',
                    borderRadius: 8,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#7B61FF')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#F4F7FB')}
                >
                  Profile
                </Link>
                {/* Avatar with dropdown */}
                <div style={{ position: 'relative' }}>
                  <div
                    onClick={() => setDropdownOpen(v => !v)}
                    style={{ cursor: 'pointer' }}
                  >
                    {isOwner ? (
                      <div style={{ width: 40, height: 40, borderRadius: '50%', border: '2px solid #3BE7FF', boxShadow: '0 0 12px rgba(59,231,255,0.4)', overflow: 'hidden', background: '#0A0A0F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/qelarix_logo.png" alt="Owner" style={{ width: 28, height: 28, objectFit: 'contain' }} />
                      </div>
                    ) : profile?.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={profile.avatar_url} alt="Avatar" style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(143,207,255,0.72)', boxShadow: '0 0 18px rgba(143,207,255,0.26)', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(143,207,255,0.72)', boxShadow: '0 0 18px rgba(143,207,255,0.26)', background: QLC_COLORS.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: 'white' }}>
                        {(profile?.username ?? session?.user?.name ?? session?.user?.email ?? 'U')[0].toUpperCase()}
                      </div>
                    )}
                  </div>

                  {dropdownOpen && (
                    <>
                      <div
                        style={{ position: 'fixed', inset: 0, zIndex: 9990 }}
                        onClick={() => setDropdownOpen(false)}
                      />
                      <div style={{
                        position: 'absolute',
                        top: 'calc(100% + 10px)',
                        right: 0,
                        width: 220,
                        background: 'rgba(18, 15, 30, 0.97)',
                        border: `1px solid ${QLC_COLORS.line}`,
                        borderRadius: 12,
                        padding: 8,
                        zIndex: 9991,
                        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                      }}>
                        <div style={{ padding: '10px 12px 12px', borderBottom: `1px solid ${QLC_COLORS.line}`, marginBottom: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <p style={{ color: '#F4F7FB', fontSize: 13, fontWeight: 600, margin: 0 }}>
                              {profile?.username || session?.user?.name || 'User'}
                            </p>
                            {isOwner && (
                              <span style={{
                                border: `1px solid ${QLC_COLORS.line}`, borderRadius: 999, padding: '1px 7px',
                                fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: QLC_COLORS.active,
                              }}>ADMIN</span>
                            )}
                          </div>
                          <p style={{ color: '#8E95A3', fontSize: 11, margin: '3px 0 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                            {shortWallet || session?.user?.email || ''}
                          </p>
                        </div>
                        <DropdownItem icon='user' label='Profile' onClick={() => { setDropdownOpen(false); router.push('/profile') }} />
                        <DropdownItem icon='wallet' label='Buy QLC' onClick={() => { setDropdownOpen(false); setTopUpOpen(true) }} />
                        <DropdownItem icon='settings' label='Settings' onClick={() => { setDropdownOpen(false); router.push('/settings') }} />
                        <div style={{ height: 1, background: QLC_COLORS.line, margin: '4px 8px' }} />
                        <DropdownItem icon='logout' label='Sign out' onClick={() => { setDropdownOpen(false); signOut({ callbackUrl: '/' }) }} danger />
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              // Always visible — shown while loading AND unauthenticated
              <Link
                href="/signup"
                className="text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-all hover:opacity-90"
                style={{ background: QLC_COLORS.accent }}
              >
                Connect Wallet
              </Link>
            )}
          </div>

          {/* Mobile right (credits + hamburger) */}
          <div className="flex md:hidden items-center gap-2 ml-auto">
            {session?.user && <CreditsPill credits={credits} onClick={() => setTopUpOpen(true)} />}
            <button className="p-2 text-white/80 hover:text-white" onClick={() => setMobileOpen((v) => !v)} aria-label="Toggle menu">
              <div className="w-5 h-4 flex flex-col justify-between">
                <motion.span animate={mobileOpen ? { rotate: 45, y: 7 } : { rotate: 0, y: 0 }} transition={{ duration: 0.22 }} className="h-0.5 bg-current block origin-center" />
                <motion.span animate={mobileOpen ? { opacity: 0 } : { opacity: 1 }} transition={{ duration: 0.15 }} className="h-0.5 bg-current block" />
                <motion.span animate={mobileOpen ? { rotate: -45, y: -7 } : { rotate: 0, y: 0 }} transition={{ duration: 0.22 }} className="h-0.5 bg-current block origin-center" />
              </div>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile backdrop */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            key="bd"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 md:hidden bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            key="drawer"
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 280 }}
            className="fixed top-0 right-0 bottom-0 z-50 w-72 md:hidden overflow-y-auto"
            style={{ background: "rgba(5,5,5,0.97)", borderLeft: "1px solid #2A2F3A" }}
          >
            <div className="flex flex-col h-full px-6 pt-16 pb-8 gap-1">
              <Suspense fallback={null}>
                <MobileNavLinks onClose={() => setMobileOpen(false)} />
              </Suspense>

              <div className="mt-auto flex flex-col gap-3 pt-4 border-t border-white/10">
                {session?.user ? (
                  <>
                    <div className="flex items-center justify-between px-1">
                      <span className="text-white/50 text-sm">{profile?.username || session.user.name?.split(" ")[0]}</span>
                      <CreditsPill credits={credits} onClick={() => { setMobileOpen(false); setTopUpOpen(true); }} />
                    </div>
                    <button className="text-center text-white text-sm font-semibold px-4 py-3 rounded-lg w-full" style={{ background: QLC_COLORS.accent, border: 'none', cursor: 'pointer' }} onClick={() => { setMobileOpen(false); router.push('/playground') }}>
                      Playground
                    </button>
                  </>
                ) : (
                  <Link href="/signup" className="text-center text-white text-sm font-semibold px-4 py-3 rounded-lg" style={{ background: QLC_COLORS.accent }} onClick={() => setMobileOpen(false)}>
                    Connect Wallet
                  </Link>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* TopUp Modal */}
      <TopUpModal isOpen={topUpOpen} onClose={() => setTopUpOpen(false)} />

    </>
  );
}

function DropdownItem({ icon, label, onClick, danger }: { icon: "user" | "wallet" | "settings" | "logout"; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', background: 'transparent', border: 'none',
        borderRadius: 8, padding: '9px 12px',
        display: 'flex', alignItems: 'center', gap: 10,
        color: danger ? '#F2A3A3' : '#F4F7FB',
        fontSize: 13, cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <QIcon name={icon} size={16} style={{ opacity: 0.8 }} />
      {label}
    </button>
  )
}
