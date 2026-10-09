'use client'
/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element */
import { useState, useEffect, type CSSProperties, type ReactNode } from 'react'
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import QelarixBackdrop from "@/components/ui/QelarixBackdrop"
import { QLC_COLORS, qlcPrimaryButtonClass } from "@/components/payments/qlcUi"

type TabType = 'video' | 'image' | 'audio' | 'character' | 'influencer'

// Brushed-steel palette for the creator profile. Buttons keep the single brand accent.
const STEEL = {
  text: '#EEF1F5',
  muted: '#9AA4B2',
  faint: '#5F6875',
  surface: 'rgba(20, 23, 28, 0.62)',
  surfaceSoft: 'rgba(255, 255, 255, 0.035)',
  line: 'rgba(200, 212, 228, 0.14)',
  lineStrong: 'rgba(214, 224, 238, 0.32)',
  silver: '#C9D2DE',
}

const glass: CSSProperties = {
  background: STEEL.surface,
  border: `1px solid ${STEEL.line}`,
  borderRadius: 18,
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 24px 60px rgba(0,0,0,0.45)',
}

function Icon({ name, size = 18 }: { name: TabType | 'user' | 'share' | 'play'; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  const paths: Record<string, ReactNode> = {
    video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 9" /></>,
    audio: <><path d="M9 18V6l11-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>,
    character: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5" /></>,
    influencer: <><circle cx="12" cy="9" r="3" /><path d="M6.5 19c1-2.8 3.1-4 5.5-4s4.5 1.2 5.5 4" /><path d="M4 5.5a10 10 0 0 0 0 9M20 5.5a10 10 0 0 1 0 9" /></>,
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5" /></>,
    share: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
    play: <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
  }
  return <svg {...p}>{paths[name]}</svg>
}

export default function DashboardPage() {
  const { data: session } = useAuthSession()
  const [profile, setProfile] = useState<any>(null)
  const [activeTab, setActiveTab] = useState<TabType>('video')
  const [generations, setGenerations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [totalCount, setTotalCount] = useState<number | null>(null)

  // Load profile
  useEffect(() => {
    if (!session?.user) return
    fetch('/api/profile')
      .then(r => r.json())
      .then(data => { if (data.profile) setProfile(data.profile) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [session])

  // Load generations by type
  useEffect(() => {
    if (!session?.user) return
    const load = async () => {
      const type = activeTab === 'character' ? 'image'
        : activeTab === 'influencer' ? 'image'
        : activeTab
      const res = await fetch(`/api/generations?type=${type}&limit=50`)
      const json = res.ok ? await res.json() : { generations: [] }
      setGenerations(json.generations || [])
    }
    load()
  }, [session, activeTab])

  // Total creations across all types (the grid below is per tab)
  useEffect(() => {
    if (!session?.user) return
    fetch('/api/generations?limit=200')
      .then(r => (r.ok ? r.json() : { generations: [] }))
      .then(json => setTotalCount((json.generations || []).length))
      .catch(() => setTotalCount(null))
  }, [session])

  // Refresh profile when settings are saved
  useEffect(() => {
    const refresh = () => {
      fetch('/api/profile')
        .then(r => r.json())
        .then(data => { if (data.profile) setProfile(data.profile) })
    }
    window.addEventListener('profile-updated', refresh)
    return () => window.removeEventListener('profile-updated', refresh)
  }, [])

  const handleShare = () => {
    navigator.clipboard.writeText(window.location.origin + '/u/' + session?.user?.name)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const tabs: { key: TabType; label: string }[] = [
    { key: 'video',      label: 'Videos' },
    { key: 'image',      label: 'Images' },
    { key: 'audio',      label: 'Audio' },
    { key: 'character',  label: 'Characters' },
    { key: 'influencer', label: 'AI Influencer' },
  ]

  const avatarUrl = profile?.avatar_url || session?.user?.image || null
  const displayName = profile?.display_name || profile?.full_name || profile?.username || session?.user?.name || 'Creator'
  const username = '@' + (profile?.username || session?.user?.email?.split('@')[0] || 'user')
  const totalLabel = totalCount === null ? '–' : totalCount >= 200 ? '200+' : totalCount.toLocaleString()
  const credits = profile?.credits ?? 0
  const plan = profile?.plan ?? 'free'
  const isAdmin = session?.user?.isInternal === true
  const badge = isAdmin ? 'BOSS' : plan !== 'free' ? String(plan).toUpperCase() : null
  const activeLabel = tabs.find(t => t.key === activeTab)?.label.toLowerCase() ?? activeTab

  const stats = [
    { value: totalLabel, label: 'Creations' },
    { value: Number(credits).toLocaleString(), label: 'QLC' },
    { value: (profile?.following_count || 0).toLocaleString(), label: 'Following' },
  ]

  return (
    <div style={{ position: 'relative', minHeight: '100vh', color: STEEL.text, overflow: 'hidden' }}>
      <QelarixBackdrop tone="steel" />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 820, margin: '0 auto', padding: '40px 16px 96px' }}>

        {/* ── PROFILE CARD ── */}
        <section style={{ ...glass, padding: '28px 28px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            {/* Avatar with brushed-steel ring */}
            <div style={{
              width: 104, height: 104, borderRadius: '50%', padding: 2, flexShrink: 0,
              background: 'conic-gradient(from 210deg, #6B7480, #E6EBF1, #7C8692, #C9D2DE, #6B7480)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            }}>
              <div style={{
                width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden',
                background: '#101317', color: STEEL.faint,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {avatarUrl
                  ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <Icon name="user" size={40} />}
              </div>
            </div>

            {/* Name + handle */}
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', margin: 0 }}>{displayName}</h1>
                {badge && (
                  <span style={{
                    border: `1px solid ${STEEL.lineStrong}`, background: 'rgba(201,210,222,0.08)',
                    color: STEEL.silver, borderRadius: 999, padding: '3px 10px',
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                  }}>
                    {badge}
                  </span>
                )}
              </div>
              <div style={{ color: STEEL.muted, fontSize: 14, marginTop: 4 }}>{username}</div>
              {profile?.bio && (
                <p style={{ fontSize: 14, color: '#C3CAD4', margin: '10px 0 0', lineHeight: 1.55 }}>{profile.bio}</p>
              )}
            </div>
          </div>

          {/* Stats */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 24,
            borderTop: `1px solid ${STEEL.line}`, borderBottom: `1px solid ${STEEL.line}`,
          }}>
            {stats.map((s, i) => (
              <div key={s.label} style={{
                padding: '14px 8px', textAlign: 'center',
                borderLeft: i === 0 ? 'none' : `1px solid ${STEEL.line}`,
              }}>
                <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
                <div style={{ fontSize: 11, color: STEEL.muted, marginTop: 2, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button
              onClick={handleShare}
              className="transition-colors hover:bg-white/10"
              style={{
                flex: 1, padding: '11px 0', borderRadius: 10, border: 'none',
                background: 'rgba(201,210,222,0.08)', color: STEEL.text,
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              <Icon name="share" size={16} />
              {copied ? 'Link copied' : 'Share profile'}
            </button>
            <button
              onClick={() => window.location.href = '/playground'}
              className={qlcPrimaryButtonClass}
              style={{
                flex: 1, padding: '11px 0', borderRadius: 10, border: 'none',
                background: QLC_COLORS.accent, color: '#FFFFFF',
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Create
            </button>
          </div>

          {/* Early adopter */}
          {profile?.early_adopter && (
            <div style={{
              marginTop: 16, padding: '10px 14px', borderRadius: 10,
              border: `1px solid ${STEEL.line}`, background: STEEL.surfaceSoft,
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            }}>
              <span style={{ color: STEEL.silver, fontWeight: 700, letterSpacing: '0.04em' }}>
                Early Adopter #{profile.early_adopter_number}
              </span>
              <span style={{ color: STEEL.muted }}>Thank you for being here first.</span>
            </div>
          )}
        </section>

        {/* ── TABS ── */}
        <nav
          style={{
            ...glass, borderRadius: 14, padding: 6, marginTop: 20,
            position: 'sticky', top: 12, zIndex: 10,
            display: 'flex', gap: 4, overflowX: 'auto',
          }}
        >
          {tabs.map(tab => {
            const active = activeTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className="transition-colors"
                style={{
                  flex: '1 0 auto', padding: '10px 12px', borderRadius: 10, border: 'none',
                  background: active ? 'rgba(214,224,238,0.12)' : 'transparent',
                  boxShadow: active ? `inset 0 0 0 1px ${STEEL.lineStrong}` : 'none',
                  color: active ? STEEL.text : STEEL.muted,
                  fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <Icon name={tab.key} size={16} />
                {tab.label}
              </button>
            )
          })}
        </nav>

        {/* ── CONTENT ── */}
        <section style={{ marginTop: 16 }}>
          {loading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
              {[...Array(8)].map((_, i) => (
                <div key={i} style={{
                  aspectRatio: '9/16', borderRadius: 12,
                  background: 'linear-gradient(90deg, #12151a 25%, #1b1f26 50%, #12151a 75%)',
                  backgroundSize: '200% 100%',
                  animation: `skeletonShimmer 1.8s ease-in-out ${i * 0.1}s infinite`,
                }} />
              ))}
            </div>
          ) : generations.length === 0 ? (
            <div style={{
              ...glass, padding: '64px 24px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center',
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: 16, color: STEEL.silver,
                border: `1px solid ${STEEL.line}`, background: STEEL.surfaceSoft,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name={activeTab} size={26} />
              </div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>No {activeLabel} yet</div>
              <p style={{ color: STEEL.muted, fontSize: 14, margin: 0, maxWidth: 360, lineHeight: 1.5 }}>
                Your creations land here. From this page you choose what goes live to the community.
              </p>
              <button
                onClick={() => window.location.href = '/playground'}
                className={qlcPrimaryButtonClass}
                style={{
                  marginTop: 6, padding: '11px 22px', borderRadius: 10, border: 'none',
                  background: QLC_COLORS.accent, color: '#FFFFFF',
                  fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Start creating
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
              {generations.map((gen, i) => (
                <div
                  key={gen.id}
                  className="transition-transform duration-200 hover:-translate-y-0.5"
                  style={{
                    aspectRatio: '9/16', borderRadius: 12, overflow: 'hidden', position: 'relative',
                    background: '#111418', border: `1px solid ${STEEL.line}`, cursor: 'pointer',
                    animation: `fadeUp 0.3s ease ${i * 0.04}s both`,
                  }}
                >
                  {gen.type === 'video' ? (
                    <video
                      src={gen.output_url}
                      muted loop playsInline
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onMouseEnter={e => (e.currentTarget as HTMLVideoElement).play()}
                      onMouseLeave={e => (e.currentTarget as HTMLVideoElement).pause()}
                    />
                  ) : (
                    <img src={gen.output_url} alt={gen.prompt} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  )}
                  {gen.is_public && (
                    <div style={{
                      position: 'absolute', top: 8, right: 8, borderRadius: 999, padding: '3px 8px',
                      background: 'rgba(12,14,17,0.72)', border: `1px solid ${STEEL.lineStrong}`,
                      backdropFilter: 'blur(6px)', color: STEEL.text,
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#7FD8A4' }} />
                      LIVE
                    </div>
                  )}
                  {gen.type === 'video' && (
                    <div style={{
                      position: 'absolute', left: 0, right: 0, bottom: 0, padding: '18px 8px 8px',
                      background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
                      color: '#FFFFFF', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5,
                    }}>
                      <Icon name="play" size={11} />
                      {gen.model?.split(' ')[0]}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <style>{`
        @keyframes skeletonShimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
