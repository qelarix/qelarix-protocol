'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'

type TabType = 'video' | 'image' | 'audio'

export default function PublicProfilePage() {
  const { username } = useParams()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [profile, setProfile] = useState<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [generations, setGenerations] = useState<any[]>([])
  const [activeTab, setActiveTab] = useState<TabType>('video')
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!username) return
    fetch('/api/public-profile/' + username)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setNotFound(true); return }
        setProfile(data.profile)
        setGenerations(data.generations || [])
      })
      .finally(() => setLoading(false))
  }, [username])

  const filtered = generations.filter(g => g.type === activeTab)

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050505' }}>
      <div style={{ width: 32, height: 32, border: '2px solid #2A2F3A', borderTopColor: '#7B61FF', borderRadius: '50%', animation: 'spin 0.9s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (notFound) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050505', color: '#F4F7FB', flexDirection: 'column', gap: 16 }}>
      <span style={{ fontSize: 48 }}>👤</span>
      <p style={{ fontSize: 18, fontWeight: 700 }}>Creator not found</p>
      <a href="/community" style={{ color: '#7B61FF', fontSize: 14 }}>← Back to Community</a>
    </div>
  )

  const tabs: { key: TabType; label: string; icon: string }[] = [
    { key: 'video', label: 'Videos', icon: '🎬' },
    { key: 'image', label: 'Images', icon: '🖼️' },
    { key: 'audio', label: 'Audio', icon: '🎵' },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#050505', color: '#F4F7FB', maxWidth: 680, margin: '0 auto', padding: '32px 16px 80px' }}>

      {/* Back */}
      <a href="/community" style={{ color: '#4A5568', fontSize: 13, textDecoration: 'none', display: 'block', marginBottom: 24 }}>
        ← Community
      </a>

      {/* Avatar + Stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginBottom: 16 }}>
        <div style={{
          width: 96, height: 96, borderRadius: '50%',
          background: 'linear-gradient(135deg,#7B61FF,#3BE7FF)',
          padding: 3, flexShrink: 0,
          boxShadow: '0 0 24px rgba(123,97,255,0.4)',
        }}>
          <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: '#111318', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {profile?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ fontSize: 36 }}>👤</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 24, flex: 1 }}>
          {[
            { value: filtered.length, label: 'Posts' },
            { value: (profile?.followers_count || 0).toLocaleString(), label: 'Followers' },
            { value: (profile?.total_likes || 0).toLocaleString(), label: 'Likes' },
          ].map(s => (
            <div key={s.label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800 }}>{s.value}</div>
              <div style={{ fontSize: 12, color: '#AAB2BF', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Name */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 18, fontWeight: 800 }}>{profile?.display_name || profile?.username}</span>
        </div>
        <div style={{ color: '#AAB2BF', fontSize: 14 }}>@{profile?.username}</div>
      </div>

      {/* Bio */}
      {profile?.bio && (
        <div style={{ fontSize: 14, color: '#C7CDD6', marginBottom: 16, lineHeight: 1.5 }}>
          {profile.bio}
        </div>
      )}

      {/* Follow button */}
      <div style={{ marginBottom: 24 }}>
        <button style={{
          width: '100%', padding: '12px',
          background: '#7B61FF', color: 'white',
          border: 'none', borderRadius: 10,
          fontSize: 14, fontWeight: 700, cursor: 'pointer',
          boxShadow: '0 0 20px rgba(123,97,255,0.35)',
        }}>
          Follow
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #1A1F2A', marginBottom: 2 }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              flex: 1, padding: '12px 4px',
              background: 'transparent', border: 'none',
              color: activeTab === tab.key ? '#F4F7FB' : '#4A5568',
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              borderBottom: activeTab === tab.key ? '2px solid #7B61FF' : '2px solid transparent',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            }}
          >
            <span style={{ fontSize: 18 }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#2A2F3A' }}>
          <span style={{ fontSize: 48 }}>{tabs.find(t => t.key === activeTab)?.icon}</span>
          <p style={{ marginTop: 12, fontSize: 14 }}>No public {activeTab}s yet</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 2 }}>
          {filtered.map(gen => (
            <div key={gen.id} style={{ aspectRatio: '9/16', background: '#111318', overflow: 'hidden', position: 'relative' }}>
              {gen.type === 'video' ? (
                <video src={gen.output_url} muted loop playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onMouseEnter={e => (e.currentTarget as HTMLVideoElement).play()}
                  onMouseLeave={e => (e.currentTarget as HTMLVideoElement).pause()}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={gen.output_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
