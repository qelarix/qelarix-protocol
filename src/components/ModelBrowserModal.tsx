'use client'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Search, Lock } from 'lucide-react'
import { QelarixModel, getModelsByType, getFeaturedModels, getNewModels, providerColor } from '@/lib/models'
import { getModelCredits } from '@/lib/catalog'

type ModelTab = 'image' | 'video' | 'audio' | 'featured' | 'new'

const BADGE_COLORS: Record<string, string> = {
  'NEW': '#3BE7FF', 'PREMIUM': '#9C27B0', 'EXCLUSIVE': '#FF6B35',
  'SOON': '#888',
}

interface ModelBrowserModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (model: QelarixModel) => void
  currentModelId?: string
  lockedModelIds?: string[]
}

export default function ModelBrowserModal({ isOpen, onClose, onSelect, currentModelId, lockedModelIds = [] }: ModelBrowserModalProps) {
  const [tab, setTab] = useState<ModelTab>('image')
  const [search, setSearch] = useState('')

  if (!isOpen || typeof document === 'undefined') return null

  const getTabModels = () => {
    let models: QelarixModel[]
    if (tab === 'featured') models = getFeaturedModels()
    else if (tab === 'new') models = getNewModels()
    else models = getModelsByType(tab)
    if (search.trim()) {
      const s = search.toLowerCase()
      models = models.filter(m =>
        m.name.toLowerCase().includes(s) ||
        m.description.toLowerCase().includes(s) ||
        m.provider.toLowerCase().includes(s)
      )
    }
    return models
  }

  const models = getTabModels()

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.88)',
      zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        width: '88vw', maxWidth: 980, height: '85vh',
        background: '#111318',
        borderRadius: 20,
        border: '1px solid #2A2F3A',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* HEADER */}
        <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ color: '#F4F7FB', fontSize: 20, fontWeight: 700, margin: 0 }}>Models</h2>
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#AAB2BF', cursor: 'pointer' }}>
              <X size={22} />
            </button>
          </div>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {(['image', 'video', 'audio', 'featured', 'new'] as ModelTab[]).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '7px 18px', borderRadius: 999, border: 'none',
                background: tab === t ? '#7B61FF' : 'transparent',
                color: tab === t ? 'white' : '#AAB2BF',
                fontSize: 13, fontWeight: tab === t ? 700 : 400,
                cursor: 'pointer', textTransform: 'capitalize',
              }}>{t}</button>
            ))}
          </div>
          {/* Search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: '#0D0D12', border: '1px solid #2A2F3A',
            borderRadius: 10, padding: '10px 14px', marginBottom: 16,
          }}>
            <Search size={16} color='#4A5568' />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder='Search models...'
              style={{
                flex: 1, background: 'transparent', border: 'none',
                color: '#F4F7FB', fontSize: 14, outline: 'none',
              }}
            />
          </div>
        </div>

        {/* MODEL GRID */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 24px' }}>
          {models.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
              <p style={{ color: '#AAB2BF' }}>No models found.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
              {models.map(model => {
                const locked = lockedModelIds.includes(model.id)
                return (
                  <div
                    key={model.id}
                    onClick={() => { if (!locked) { onSelect(model); onClose() } }}
                    style={{
                      background: currentModelId === model.id ? 'rgba(123,97,255,0.15)' : '#0D0D12',
                      border: currentModelId === model.id ? '2px solid #7B61FF' : '1px solid #2A2F3A',
                      borderRadius: 14, padding: 16,
                      cursor: locked ? 'not-allowed' : 'pointer',
                      transition: 'border-color 0.15s',
                      opacity: locked ? 0.55 : 1,
                      position: 'relative',
                    }}
                    onMouseEnter={e => {
                      if (!locked && currentModelId !== model.id)
                        (e.currentTarget as HTMLElement).style.borderColor = '#4A5568'
                    }}
                    onMouseLeave={e => {
                      if (currentModelId !== model.id)
                        (e.currentTarget as HTMLElement).style.borderColor = '#2A2F3A'
                    }}
                  >
                    {locked && (
                      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,0,0,0.6)', borderRadius: 6, padding: '3px 8px' }}>
                        <Lock size={11} color='#AAB2BF' />
                        <span style={{ color: '#AAB2BF', fontSize: 10, fontWeight: 600 }}>Upgrade</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: 8,
                        background: model.logoUrl ? '#1A1F2A' : (providerColor[model.provider] || '#7B61FF'),
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden', flexShrink: 0,
                      }}>
                        {model.logoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={model.logoUrl}
                            alt={model.provider}
                            style={{ width: 20, height: 20, objectFit: 'contain' }}
                            onError={e => {
                              (e.target as HTMLImageElement).style.display = 'none'
                              const parent = (e.target as HTMLImageElement).parentElement
                              if (parent) parent.innerHTML =
                                '<span style="color:white;font-size:11px;font-weight:700">'
                                + model.provider.charAt(0) + '</span>'
                            }}
                          />
                        ) : (
                          <span style={{ color: 'white', fontSize: 11, fontWeight: 700 }}>
                            {model.provider.charAt(0)}
                          </span>
                        )}
                      </div>
                      <span style={{ color: '#F4F7FB', fontSize: 14, fontWeight: 600, flex: 1 }}>
                        {model.name}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {model.badges.map(b => (
                          <span key={b} style={{
                            background: BADGE_COLORS[b] || '#7B61FF',
                            color: b === 'NEW' || b === 'ULTRA' ? '#000' : 'white',
                            fontSize: 9, fontWeight: 700, padding: '2px 6px',
                            borderRadius: 4, letterSpacing: 0.5,
                          }}>{b}</span>
                        ))}
                      </div>
                      <span style={{ background: 'rgba(123,97,255,0.2)', color: '#7B61FF', fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6, marginLeft: 4, whiteSpace: 'nowrap' }}>
                        {getModelCredits(model.id)} QLC
                      </span>
                    </div>
                    <p style={{ color: '#AAB2BF', fontSize: 12, margin: '0 0 10px', lineHeight: 1.5 }}>
                      {model.description}
                    </p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {model.tags.map(tag => (
                        <span key={tag} style={{
                          background: '#1A1F2A', color: '#AAB2BF',
                          fontSize: 10, padding: '3px 8px', borderRadius: 6,
                        }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
