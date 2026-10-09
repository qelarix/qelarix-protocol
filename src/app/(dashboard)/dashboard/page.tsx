'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect } from 'react'
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { useRouter } from 'next/navigation'

export default function DashboardPage() {
  const { data: session } = useAuthSession()
  const router = useRouter()
  const [inspiredItems, setInspiredItems] = useState<any[]>([])
  const [activeTab, setActiveTab] = useState<'video' | 'image'>('video')

  // Load the user's generations for Get Inspired
  useEffect(() => {
    if (!session?.user) return
    fetch('/api/generations?limit=6')
      .then(r => r.json())
      .then(data => {
        if (data.generations?.length) setInspiredItems(data.generations)
      })
  }, [session])

  const videoTemplates = [
    {
      icon: '🎬',
      title: 'Cinematic City',
      description: 'Aerial city flyover at night, neon lights',
      prompt: 'Cinematic aerial flyover of a futuristic city at night. Neon lights reflect on wet streets below. Slow dramatic camera movement, 8K quality, cinematic atmosphere.',
      model: 'Kling 3.0 Pro',
      modelId: 'kling3pro',
      tag: 'Cinematic',
    },
    {
      icon: '🤖',
      title: 'AI Character',
      description: 'Character walking, talking, looking at camera',
      prompt: 'A realistic AI character walks confidently toward the camera on a futuristic street. Cinematic lighting, detailed face, smooth motion, ultra realistic.',
      model: 'Seedance 2.0',
      modelId: 'seedance20',
      tag: 'Character',
    },
    {
      icon: '📱',
      title: 'Social Ad',
      description: '9:16 product showcase for Instagram/TikTok',
      prompt: 'Sleek product showcase video, 9:16 vertical format. Product rotates slowly on a clean background with dramatic lighting. Professional commercial quality.',
      model: 'Kling V3 Standard',
      modelId: 'kling3_standard',
      tag: 'Social',
    },
    {
      icon: '🎵',
      title: 'Music Visualizer',
      description: 'Audio reactive visuals, abstract motion',
      prompt: 'Abstract music visualizer with flowing neon particles reacting to bass. Dark background, vibrant colors, smooth wave animations, cinematic quality.',
      model: 'Wan 2.6',
      modelId: 'wan26',
      tag: 'Abstract',
    },
    {
      icon: '🏆',
      title: 'Logo Reveal',
      description: 'Dramatic logo animation reveal',
      prompt: 'Dramatic logo reveal animation. Logo emerges from particles of light with cinematic camera movement. Professional broadcast quality, epic music atmosphere.',
      model: 'Kling 3.0 Pro',
      modelId: 'kling3pro',
      tag: 'Branding',
    },
    {
      icon: '🌊',
      title: 'Nature Scene',
      description: 'Cinematic peaceful nature landscape',
      prompt: 'Peaceful cinematic nature scene. Golden hour light over a misty mountain landscape. Birds fly in slow motion. Ultra realistic, 8K, breathtaking visuals.',
      model: 'Luma Ray 3',
      modelId: 'luma3',
      tag: 'Nature',
    },
  ]

  const imageTemplates = [
    {
      icon: '🛍️',
      title: 'Product Photo',
      description: 'Studio lighting, white/black background',
      prompt: 'Professional product photography. Clean white studio background, perfect soft lighting, sharp details, commercial quality. Shot on high-end camera.',
      model: 'FLUX 2 Pro',
      modelId: 'flux2_pro',
      tag: 'Product',
    },
    {
      icon: '👤',
      title: 'AI Portrait',
      description: 'Professional portrait, various styles',
      prompt: 'Stunning professional portrait of a person. Dramatic studio lighting, shallow depth of field, highly detailed skin texture, cinematic color grading.',
      model: 'Grok Imagine',
      modelId: 'grok_image',
      tag: 'Portrait',
    },
    {
      icon: '🎨',
      title: 'Concept Art',
      description: 'Fantasy, sci-fi, cyberpunk worlds',
      prompt: 'Epic concept art of a futuristic cyberpunk cityscape at night. Neon signs, flying vehicles, rain-soaked streets. Highly detailed, cinematic composition.',
      model: 'FLUX 2 Max',
      modelId: 'flux2_max',
      tag: 'Art',
    },
    {
      icon: '📣',
      title: 'Social Post',
      description: 'Text + visual for social media',
      prompt: 'Eye-catching social media post design. Bold typography, vibrant colors, modern layout. Clean and professional, optimized for Instagram feed.',
      model: 'Ideogram V3',
      modelId: 'ideogram3',
      tag: 'Social',
    },
    {
      icon: '🖼️',
      title: 'Wallpaper',
      description: 'Desktop and mobile backgrounds',
      prompt: 'Stunning 4K wallpaper with breathtaking landscape. Epic lighting, ultra detailed, perfect composition. Suitable for desktop and mobile screens.',
      model: 'Nano Banana Pro',
      modelId: 'nano_banana_pro',
      tag: 'Wallpaper',
    },
    {
      icon: '✨',
      title: 'Fantasy Scene',
      description: 'Magical worlds and creatures',
      prompt: 'Magical fantasy scene with glowing mystical forest. Ancient trees with bioluminescent plants, fairies dancing in the light, epic atmosphere.',
      model: 'FLUX Kontext Pro',
      modelId: 'flux_kontext',
      tag: 'Fantasy',
    },
  ]

  const currentTemplates = activeTab === 'video' ? videoTemplates : imageTemplates

  const handleUseTemplate = (template: any) => {
    // Store the template in localStorage, then redirect to the Playground
    localStorage.setItem('playground_template', JSON.stringify({
      prompt: template.prompt,
      modelId: template.modelId,
      type: activeTab,
    }))
    router.push('/playground')
  }

  const firstName = session?.user?.name?.split(' ')[0] || 'Creator'
  const isAdmin = session?.user?.isInternal === true
  const isUltra = (session as any)?.plan === 'ultra'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isBusiness = (session as any)?.plan === 'business'

  return (
    <div style={{
      minHeight: '100vh',
      background: '#050505',
      color: '#F4F7FB',
      padding: '32px 32px 80px',
      maxWidth: 1200,
    }}>

      {/* GREETING */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>
            Welcome back, {firstName} ⚡
          </h1>
          {isAdmin && (
            <span style={{
              background: 'linear-gradient(135deg, #7B61FF, #3BE7FF)',
              border: '1px solid rgba(123,97,255,0.4)',
              borderRadius: 6,
              padding: '2px 10px',
              fontSize: 11,
              fontWeight: 800,
              color: 'white',
              letterSpacing: 0.5,
            }}>BOSS</span>
          )}
          {isUltra && !isAdmin && !isBusiness && (
            <span style={{
              background: 'linear-gradient(135deg, #3BE7FF, #7B61FF)',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 10,
              fontWeight: 700,
              color: 'white',
            }}>⚡ ULTRA</span>
          )}
          {isBusiness && !isAdmin && (
            <span style={{
              background: 'linear-gradient(135deg, #F59E0B, #D97706)',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 10,
              fontWeight: 700,
              color: 'white',
            }}>⭐ BUSINESS</span>
          )}
        </div>
        <p style={{ color: '#4A5568', fontSize: 14 }}>
          What will you create today?
        </p>
      </div>

      {/* QUICK ACTIONS */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 14,
        marginBottom: 44,
      }}>
        {[
          { icon: '🎬', label: 'Generate Video', href: '/playground', color: '#7B61FF' },
          { icon: '🖼️', label: 'Generate Image', href: '/playground', color: '#3BE7FF' },
          { icon: '🎵', label: 'Generate Audio', href: '/playground', color: '#F59E0B' },
        ].map(action => (
          <button
            key={action.label}
            onClick={() => router.push(action.href)}
            style={{
              background: '#111318',
              border: `1px solid ${action.color}33`,
              borderRadius: 12,
              padding: '18px 16px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = action.color
              ;(e.currentTarget as HTMLElement).style.boxShadow = `0 0 20px ${action.color}22`
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = `${action.color}33`
              ;(e.currentTarget as HTMLElement).style.boxShadow = 'none'
            }}
          >
            <span style={{ fontSize: 24 }}>{action.icon}</span>
            <span style={{ color: '#F4F7FB', fontSize: 14, fontWeight: 600 }}>
              {action.label}
            </span>
          </button>
        ))}
      </div>

      {/* GET INSPIRED */}
      {inspiredItems.length > 0 && (
        <div style={{ marginBottom: 44 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>✨ Get Inspired</h2>
            <button
              onClick={() => router.push('/profile')}
              style={{
                background: 'transparent', border: 'none',
                color: '#7B61FF', fontSize: 13, cursor: 'pointer',
              }}
            >
              View all →
            </button>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            gap: 10,
          }}>
            {inspiredItems.slice(0, 6).map(item => (
              <div
                key={item.id}
                onClick={() => router.push('/playground')}
                style={{
                  aspectRatio: '9/16',
                  background: '#111318',
                  borderRadius: 10,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'transform 0.2s ease',
                }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.transform = 'scale(1.03)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.transform = 'scale(1)'}
              >
                {item.type === 'video' ? (
                  <video
                    src={item.output_url}
                    muted loop playsInline
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onMouseEnter={e => (e.currentTarget as HTMLVideoElement).play()}
                    onMouseLeave={e => (e.currentTarget as HTMLVideoElement).pause()}
                  />
                ) : (
                  <img
                    src={item.output_url}
                    alt={item.prompt}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                )}
                {/* Hover overlay */}
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 60%)',
                  display: 'flex', alignItems: 'flex-end',
                  padding: 8, opacity: 0,
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '0'}
                >
                  <span style={{ color: 'white', fontSize: 9, fontWeight: 600 }}>
                    {item.model}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TEMPLATES */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>🚀 Templates</h2>
          {/* Tab switcher */}
          <div style={{
            display: 'flex',
            background: '#111318',
            border: '1px solid #2A2F3A',
            borderRadius: 10,
            padding: 4,
            gap: 4,
          }}>
            {(['video', 'image'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '7px 18px',
                  borderRadius: 8,
                  border: 'none',
                  background: activeTab === tab ? '#7B61FF' : 'transparent',
                  color: activeTab === tab ? 'white' : '#AAB2BF',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  textTransform: 'capitalize',
                  transition: 'all 0.2s ease',
                }}
              >
                {tab === 'video' ? '🎬' : '🖼️'} {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 16,
        }}>
          {currentTemplates.map(template => (
            <div
              key={template.title}
              style={{
                background: '#111318',
                border: '1px solid #2A2F3A',
                borderRadius: 14,
                padding: 20,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                position: 'relative',
                overflow: 'hidden',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(123,97,255,0.4)'
                ;(e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'
                ;(e.currentTarget as HTMLElement).style.boxShadow = '0 8px 24px rgba(123,97,255,0.15)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.borderColor = '#2A2F3A'
                ;(e.currentTarget as HTMLElement).style.transform = 'translateY(0)'
                ;(e.currentTarget as HTMLElement).style.boxShadow = 'none'
              }}
            >
              {/* Tag */}
              <div style={{
                position: 'absolute', top: 14, right: 14,
                background: 'rgba(123,97,255,0.15)',
                border: '1px solid rgba(123,97,255,0.2)',
                borderRadius: 6, padding: '2px 8px',
                fontSize: 10, color: '#7B61FF', fontWeight: 700,
              }}>
                {template.tag}
              </div>

              <div style={{ fontSize: 32, marginBottom: 12 }}>{template.icon}</div>
              <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: '#F4F7FB' }}>
                {template.title}
              </h3>
              <p style={{ fontSize: 12, color: '#4A5568', marginBottom: 16, lineHeight: 1.5 }}>
                {template.description}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{
                  fontSize: 10, color: '#AAB2BF',
                  background: '#0D0D12', padding: '3px 8px',
                  borderRadius: 4,
                }}>
                  {template.model}
                </span>
                <button
                  onClick={() => handleUseTemplate(template)}
                  style={{
                    background: '#7B61FF', color: 'white',
                    border: 'none', borderRadius: 8,
                    padding: '8px 16px', fontSize: 12,
                    fontWeight: 700, cursor: 'pointer',
                    boxShadow: '0 0 12px rgba(123,97,255,0.3)',
                  }}
                >
                  Use →
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
