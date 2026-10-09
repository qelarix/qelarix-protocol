'use client'
import { useState, useRef, useEffect } from 'react'
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { ChevronDown, Lock, Volume2, VolumeX } from 'lucide-react'
import { QELARIX_MODELS, QelarixModel, getModelsByType, providerColor } from '@/lib/models'
import ModelBrowserModal from '@/components/ModelBrowserModal'
import { calculateVideoCost } from '@/lib/credits'
import { getModelCredits } from '@/lib/catalog'
import { PLAN_GATING_ENABLED } from "@/lib/plans"
import QIcon from "@/components/ui/QIcon"

interface PlaygroundGenerateBarProps {
  onGenerate: (params: {
    prompt: string
    model: QelarixModel
    type: 'image' | 'video' | 'audio'
    aspectRatio: string
    duration: number
    imageUrl?: string | null
    withAudio?: boolean
  }) => void
  isGenerating?: boolean
  externalRefImage?: string
  onRefImageUsed?: () => void
  lockedType?: 'image' | 'video' | 'audio'
}

const RECENT_KEY = 'qelarix_recent_models'
const TYPE_ICONS: Record<string, React.ReactNode> = { image: <QIcon name="image" size={12} />, video: <QIcon name="video" size={12} />, audio: <QIcon name="music" size={12} /> }

const MODEL_DURATIONS: Record<string, number[]> = {
  wan26: [3, 5, 8], ltx2: [3, 5], luma_ray3: [5, 8, 10],
  pika25: [3, 5], kling3: [5, 8, 10], kling3_pro: [5, 10],
  kling3_4k: [5, 10, 15], kling3_standard: [5, 10, 15],
  kling3_omni: [5, 10, 15], kling26_pro: [5, 10],
  kling26_standard: [5, 10], happy_horse: [5, 8],
  seedance2: [5, 8, 10], grok_video: [5], veo4: [5, 8, 10],
}

const CREDIT_ID_MAP: Record<string, string> = {
  luma_ray3: 'luma3', kling3_pro: 'kling3pro',
  happy_horse: 'happyhorse10', grok_video: 'grokvideo',
}

function isModelLocked(model: QelarixModel, plan: string, internal: boolean): boolean {
  if (!PLAN_GATING_ENABLED) return false
  if (internal) return false
  if (['ultra', 'business', 'pro'].includes(plan)) return false
  if (model.type === 'video') {
    const starterIds = ['wan26', 'ltx2', 'luma_ray3', 'pika25']
    return plan === 'starter' ? !starterIds.includes(model.id) : true
  }
  if (model.type === 'audio') return true
  if (model.type === 'image' && plan === 'free') {
    return !['sd35', 'nano_banana2', 'imagen4'].includes(model.id)
  }
  return false
}

export default function PlaygroundGenerateBar({ onGenerate, isGenerating, externalRefImage, onRefImageUsed, lockedType }: PlaygroundGenerateBarProps) {
  const { data: session } = useAuthSession()
  const isInternal = session?.user?.isInternal === true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userPlan = ((session as any)?.plan as string) ?? 'free'

  const [prompt, setPrompt] = useState('')
  const [selectedModel, setSelectedModel] = useState<QelarixModel>(
    lockedType ? QELARIX_MODELS.find(m => m.type === lockedType && !m.comingSoon) ?? QELARIX_MODELS[0] : QELARIX_MODELS[0]
  )
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [duration, setDuration] = useState(MODEL_DURATIONS[selectedModel?.id]?.[0] ?? 5)
  const [withAudio, setWithAudio] = useState(true)
  const [imageUrl, setImageUrl] = useState('')
  const [referenceImageUrl, setReferenceImageUrl] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const [typeDropOpen, setTypeDropOpen] = useState(false)
  const [modelDropOpen, setModelDropOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [recentIds, setRecentIds] = useState<string[]>([])

  const [barHeight, setBarHeight] = useState(160)
  const isDragging = useRef(false)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)

  const typeDropRef = useRef<HTMLDivElement>(null)
  const modelDropRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_KEY)
      if (saved) setRecentIds(JSON.parse(saved))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    const durations = MODEL_DURATIONS[selectedModel.id] ?? [5, 8, 10]
    if (!durations.includes(duration)) setDuration(durations[0])
  }, [selectedModel.id])

  useEffect(() => {
    if (!typeDropOpen && !modelDropOpen) return
    const handler = (e: MouseEvent) => {
      if (typeDropOpen && typeDropRef.current && !typeDropRef.current.contains(e.target as Node)) {
        setTypeDropOpen(false)
      }
      if (modelDropOpen && modelDropRef.current && !modelDropRef.current.contains(e.target as Node)) {
        setModelDropOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [typeDropOpen, modelDropOpen])

  useEffect(() => {
    if (!externalRefImage) return
    setReferenceImageUrl(externalRefImage)
    onRefImageUsed?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalRefImage])

  const saveRecent = (id: string) => {
    const updated = [id, ...recentIds.filter(x => x !== id)].slice(0, 5)
    setRecentIds(updated)
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated))
  }

  // ── Upload logic — DO NOT MODIFY ──
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingImage(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/generate/video/upload', { method: 'POST', body: formData })
      const data = await res.json()
      if (data.url) setImageUrl(data.url)
    } catch { /* silent */ } finally {
      setUploadingImage(false)
    }
    e.target.value = ''
  }

  const recentModels = recentIds
    .map(id => QELARIX_MODELS.find(m => m.id === id))
    .filter((m): m is QelarixModel => !!m && !m.comingSoon)

  const handleSelectModel = (model: QelarixModel) => {
    if (isModelLocked(model, userPlan, isInternal)) return
    setSelectedModel(model)
    saveRecent(model.id)
    setModelDropOpen(false)
    setBrowserOpen(false)
  }

  const submittingRef = useRef(false)

  const handleGenerate = () => {
    if (!prompt.trim() || isGenerating || submittingRef.current) return
    submittingRef.current = true
    setTimeout(() => { submittingRef.current = false }, 500)
    saveRecent(selectedModel.id)
    onGenerate({
      prompt: prompt.trim(),
      model: selectedModel,
      type: selectedModel.type,
      aspectRatio,
      duration,
      imageUrl: imageUrl.trim() || null,
      withAudio,
    })
  }

  const typeModels = getModelsByType(selectedModel.type)
  const lockedModelIds = QELARIX_MODELS
    .filter(m => isModelLocked(m, userPlan, isInternal))
    .map(m => m.id)

  const typeLabel = selectedModel.type.charAt(0).toUpperCase() + selectedModel.type.slice(1)
  const selectedLocked = isModelLocked(selectedModel, userPlan, isInternal)

  const dropStyle: React.CSSProperties = {
    position: 'absolute', bottom: 'calc(100% + 8px)', left: 0,
    background: '#111318', border: '1px solid #2A2F3A',
    borderRadius: 14, padding: 8, zIndex: 9990,
    boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
  }

  const modelRowStyle = (locked: boolean, selected: boolean): React.CSSProperties => ({
    width: '100%', border: 'none', borderRadius: 8, padding: '8px 10px',
    display: 'flex', alignItems: 'center', gap: 10,
    background: selected ? 'rgba(123,97,255,0.15)' : 'transparent',
    color: locked ? '#4A5568' : '#F4F7FB',
    fontSize: 13, cursor: locked ? 'not-allowed' : 'pointer', textAlign: 'left',
  })

  return (
    <>
      <ModelBrowserModal
        isOpen={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={handleSelectModel}
        currentModelId={selectedModel.id}
        lockedModelIds={lockedModelIds}
      />

      {/* Hidden file input for image upload — DO NOT MODIFY */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) setReferenceImageUrl(URL.createObjectURL(file))
          handleFileUpload(e)
        }}
      />

      <div style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(13,13,18,0.97)',
        border: '1.5px solid rgba(59,231,255,0.35)',
        borderRadius: 20,
        padding: '12px 16px 12px',
        boxSizing: 'border-box',
        margin: '6px 16px 12px',
        height: barHeight,
        minHeight: 120,
        maxHeight: 'calc(50vh)',
        boxShadow: '0 0 40px rgba(59,231,255,0.1), 0 0 1px rgba(59,231,255,0.5), inset 0 0 60px rgba(123,97,255,0.04)',
        backdropFilter: 'blur(20px)',
      }}>

        {/* Resize handle — gornji desni ugao */}
        <div
          onMouseDown={(e) => {
            e.preventDefault()
            isDragging.current = true
            dragStartY.current = e.clientY
            dragStartHeight.current = barHeight
            const onMove = (ev: MouseEvent) => {
              if (!isDragging.current) return
              const delta = dragStartY.current - ev.clientY
              const newHeight = Math.min(
                Math.max(dragStartHeight.current + delta, 120),
                window.innerHeight * 0.5
              )
              setBarHeight(newHeight)
            }
            const onUp = () => {
              isDragging.current = false
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
            }
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
          style={{
            position: 'absolute', top: 10, right: 12,
            cursor: 'ns-resize', padding: '4px',
            display: 'flex', flexDirection: 'column', gap: 3,
            opacity: 0.4,
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '0.4')}
        >
          {[0, 1, 2].map(i => (
            <div key={i} style={{ width: 20, height: 2, background: '#AAB2BF', borderRadius: 2 }} />
          ))}
        </div>

        {/* ── Content area (TOP) — grows to fill available space ── */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>

          {/* IMAGE MODE: ref image box left + textarea right */}
          {selectedModel.type === 'image' && (
            <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
              {/* REF IMAGE box */}
              <div
                title="Add reference image"
                style={{
                  width: 72, height: 72, flexShrink: 0,
                  border: `1.5px dashed ${referenceImageUrl ? '#7B61FF' : '#2A2F3A'}`,
                  borderRadius: 10,
                  background: '#0D0D12',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: uploadingImage ? 'not-allowed' : 'pointer',
                  position: 'relative', overflow: 'hidden',
                }}
                onMouseEnter={e => { if (!referenceImageUrl) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,231,255,0.5)' }}
                onMouseLeave={e => { if (!referenceImageUrl) (e.currentTarget as HTMLElement).style.borderColor = '#2A2F3A' }}
              >
                {referenceImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={referenceImageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 9 }} />
                ) : (
                  <div style={{ textAlign: 'center', position: 'relative' }}>
                    <div style={{ fontSize: 20, color: '#2A2F3A' }}>⊞</div>
                    <span className="ref-tooltip" style={{
                      position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%',
                      transform: 'translateX(-50%)',
                      background: '#1A1F2A', color: '#AAB2BF',
                      fontSize: 10, padding: '4px 8px', borderRadius: 6,
                      whiteSpace: 'nowrap', pointerEvents: 'none',
                    }}>
                      {uploadingImage ? 'Uploading...' : 'Add reference image'}
                    </span>
                  </div>
                )}
                {/* File input hidden behind box */}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploadingImage}
                  style={{ position: 'absolute', inset: 0, opacity: 0, cursor: uploadingImage ? 'not-allowed' : 'pointer', zIndex: 2 }}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) setReferenceImageUrl(URL.createObjectURL(file))
                    handleFileUpload(e)
                  }}
                />
                {/* Clear button */}
                {referenceImageUrl && (
                  <button
                    onClick={e => { e.stopPropagation(); setReferenceImageUrl(''); setImageUrl('') }}
                    style={{
                      position: 'absolute', top: 4, right: 4, zIndex: 3,
                      width: 18, height: 18, borderRadius: '50%',
                      background: 'rgba(0,0,0,0.7)', border: '1px solid #4A5568',
                      color: '#F4F7FB', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700, lineHeight: 1,
                    }}
                  >×</button>
                )}
              </div>

              {/* Prompt textarea */}
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleGenerate() }}
                placeholder="Describe the image you want to create..."
                style={{
                  flex: 1,
                  background: 'transparent', border: 'none',
                  color: '#F4F7FB', fontSize: 14,
                  resize: 'none', outline: 'none',
                  lineHeight: 1.7, boxSizing: 'border-box',
                  paddingTop: '6px', paddingBottom: '6px',
                }}
              />
            </div>
          )}

          {/* VIDEO MODE: START → END → REF slots + prompt below */}
          {selectedModel.type === 'video' && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {/* Frame slots row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 }}>
                <VideoSlot label="START" onUpload={url => setImageUrl(url)} />
                <span style={{ color: '#2A2F3A', fontSize: 16 }}>→</span>
                <VideoSlot label="END" />
                <VideoSlot label="REF" />
              </div>
              {/* Prompt textarea */}
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleGenerate() }}
                placeholder="Describe the video you want to create..."
                style={{
                  flex: 1,
                  width: '100%', background: 'transparent', border: 'none',
                  color: '#F4F7FB', fontSize: 14, resize: 'none', outline: 'none',
                  lineHeight: 1.7, boxSizing: 'border-box',
                  paddingTop: '6px', paddingBottom: '6px',
                }}
              />
            </div>
          )}

          {/* AUDIO MODE: just prompt */}
          {selectedModel.type === 'audio' && (
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleGenerate() }}
              placeholder="Describe the sound or music you want to create..."
              style={{
                flex: 1,
                width: '100%', background: 'transparent', border: 'none',
                color: '#F4F7FB', fontSize: 14, resize: 'none', outline: 'none',
                lineHeight: 1.7, boxSizing: 'border-box',
                paddingTop: '6px', paddingBottom: '6px',
              }}
            />
          )}

        </div>{/* end content area */}

        {/* Divider */}
        <div style={{ height: 1, background: '#1A1F2A', margin: '8px 0', flexShrink: 0 }} />

        {/* ── Controls row (BOTTOM) — always pinned to the bottom ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>

          {/* Type selector — hidden when type is locked */}
          {!lockedType && <div ref={typeDropRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={() => { setTypeDropOpen(v => !v); setModelDropOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: '#1A1F2A', border: '1px solid #2A2F3A',
                borderRadius: 10, padding: '7px 12px',
                color: '#F4F7FB', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {TYPE_ICONS[selectedModel.type]} {typeLabel} <ChevronDown size={11} />
            </button>

            {typeDropOpen && (
              <div style={{ ...dropStyle, minWidth: 140 }}>
                {(['image', 'video', 'audio'] as const).map(t => (
                  <button
                    key={t}
                    onMouseDown={e => {
                      e.preventDefault()
                      const first = QELARIX_MODELS.find(m => m.type === t && !m.comingSoon && !isModelLocked(m, userPlan, isInternal))
                        ?? QELARIX_MODELS.find(m => m.type === t && !m.comingSoon)
                      if (first) setSelectedModel(first)
                      setTypeDropOpen(false)
                    }}
                    style={{
                      width: '100%', border: 'none', borderRadius: 8, padding: '8px 12px',
                      textAlign: 'left', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: selectedModel.type === t ? 'rgba(123,97,255,0.15)' : 'transparent',
                      color: selectedModel.type === t ? '#F4F7FB' : '#AAB2BF',
                      fontSize: 13, fontWeight: selectedModel.type === t ? 600 : 400,
                    }}
                    onMouseEnter={e => { if (selectedModel.type !== t) e.currentTarget.style.background = '#1A1F2A' }}
                    onMouseLeave={e => { if (selectedModel.type !== t) e.currentTarget.style.background = 'transparent' }}
                  >
                    {TYPE_ICONS[t]} {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>}

          {/* Model selector */}
          <div ref={modelDropRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <button
              onClick={() => { setModelDropOpen(v => !v); setTypeDropOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: '#1A1F2A', border: '1px solid #2A2F3A',
                borderRadius: 10, padding: '7px 14px',
                color: '#F4F7FB', fontSize: 13, cursor: 'pointer',
                width: '100%', transition: 'border-color 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(59,231,255,0.4)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#2A2F3A')}
            >
              <div style={{
                width: 20, height: 20, borderRadius: 5,
                background: selectedModel.logoUrl ? '#1A1F2A' : (providerColor[selectedModel.provider] || '#7B61FF'),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden', flexShrink: 0,
              }}>
                {selectedModel.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selectedModel.logoUrl} alt={selectedModel.provider}
                    style={{ width: 14, height: 14, objectFit: 'contain' }}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <span style={{ color: 'white', fontSize: 8, fontWeight: 700 }}>{selectedModel.provider.charAt(0)}</span>
                )}
              </div>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {selectedModel.name}
              </span>
              <ChevronDown size={11} style={{ flexShrink: 0 }} />
            </button>

            {modelDropOpen && (
              <div style={{ ...dropStyle, minWidth: 290 }}>
                {recentModels.length > 0 && (
                  <>
                    <p style={{ color: '#4A5568', fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '4px 10px 6px', margin: 0 }}>RECENT</p>
                    {recentModels.map(m => {
                      const locked = isModelLocked(m, userPlan, isInternal)
                      return (
                        <button
                          key={m.id}
                          onMouseDown={e => { e.preventDefault(); handleSelectModel(m) }}
                          style={modelRowStyle(locked, selectedModel.id === m.id)}
                          onMouseEnter={e => { if (!locked && selectedModel.id !== m.id) e.currentTarget.style.background = '#1A1F2A' }}
                          onMouseLeave={e => { if (selectedModel.id !== m.id) e.currentTarget.style.background = 'transparent' }}
                        >
                          <div style={{ width: 20, height: 20, borderRadius: 5, background: m.logoUrl ? '#1A1F2A' : (providerColor[m.provider] || '#7B61FF'), display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, opacity: locked ? 0.4 : 1 }}>
                            {m.logoUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={m.logoUrl} alt={m.provider} style={{ width: 14, height: 14, objectFit: 'contain' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                            ) : (
                              <span style={{ color: 'white', fontSize: 8, fontWeight: 700 }}>{m.provider.charAt(0)}</span>
                            )}
                          </div>
                          <span style={{ flex: 1 }}>{m.name}</span>
                          {locked ? <Lock size={11} color='#4A5568' /> : <span style={{ color: '#7B61FF', fontSize: 11, fontWeight: 700 }}>{getModelCredits(m.id)} QLC</span>}
                        </button>
                      )
                    })}
                    <div style={{ height: 1, background: '#2A2F3A', margin: '6px 8px' }} />
                  </>
                )}
                <p style={{ color: '#4A5568', fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '4px 10px 6px', margin: 0, textTransform: 'uppercase' }}>
                  {selectedModel.type}
                </p>
                {typeModels.slice(0, 6).map(m => {
                  const locked = isModelLocked(m, userPlan, isInternal)
                  return (
                    <button
                      key={m.id}
                      onMouseDown={e => { e.preventDefault(); handleSelectModel(m) }}
                      style={modelRowStyle(locked, selectedModel.id === m.id)}
                      onMouseEnter={e => { if (!locked && selectedModel.id !== m.id) e.currentTarget.style.background = '#1A1F2A' }}
                      onMouseLeave={e => { if (selectedModel.id !== m.id) e.currentTarget.style.background = 'transparent' }}
                    >
                      <div style={{ width: 18, height: 18, borderRadius: '50%', background: providerColor[m.provider] || '#7B61FF', fontSize: 8, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0, opacity: locked ? 0.4 : 1 }}>
                        {m.provider.charAt(0)}
                      </div>
                      <span style={{ flex: 1 }}>{m.name}</span>
                      {locked ? <Lock size={11} color='#4A5568' /> : <span style={{ color: '#7B61FF', fontSize: 11, fontWeight: 700 }}>{getModelCredits(m.id)} QLC</span>}
                    </button>
                  )
                })}
                <div style={{ height: 1, background: '#2A2F3A', margin: '6px 8px' }} />
                <button
                  onMouseDown={e => { e.preventDefault(); setModelDropOpen(false); setBrowserOpen(true) }}
                  style={{
                    width: '100%', background: 'transparent', border: 'none',
                    borderRadius: 8, padding: '9px 10px',
                    color: '#7B61FF', fontSize: 13, cursor: 'pointer', textAlign: 'left',
                    fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1A1F2A')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  Browse all models
                </button>
              </div>
            )}
          </div>

          {/* Aspect ratio pills */}
          <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
            {(['16:9', '9:16', '1:1'] as const).map(r => (
              <button key={r} onClick={() => setAspectRatio(r)} style={{
                padding: '5px 8px', borderRadius: 7, border: `1px solid ${aspectRatio === r ? '#7B61FF' : '#2A2F3A'}`,
                background: aspectRatio === r ? 'rgba(123,97,255,0.15)' : '#1A1F2A',
                color: aspectRatio === r ? '#7B61FF' : '#AAB2BF',
                fontSize: 11, fontWeight: aspectRatio === r ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap',
              }}>{r}</button>
            ))}
          </div>

          {/* Duration pills — video only */}
          {selectedModel.type === 'video' && (
            <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              {(MODEL_DURATIONS[selectedModel.id] || [5, 8, 10]).map(d => (
                <button key={d} onClick={() => setDuration(d)} style={{
                  padding: '5px 8px', borderRadius: 7, border: `1px solid ${duration === d ? '#3BE7FF' : '#2A2F3A'}`,
                  background: duration === d ? 'rgba(59,231,255,0.1)' : '#1A1F2A',
                  color: duration === d ? '#3BE7FF' : '#AAB2BF',
                  fontSize: 11, fontWeight: duration === d ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap',
                }}>{d}s</button>
              ))}
            </div>
          )}

          {/* Audio toggle — video only */}
          {selectedModel.type === 'video' && (
            <button
              onClick={() => setWithAudio(v => !v)}
              title={withAudio ? 'Disable audio' : 'Enable audio'}
              style={{
                padding: '5px 9px', borderRadius: 7, flexShrink: 0,
                border: `1px solid ${withAudio ? '#3BE7FF' : '#2A2F3A'}`,
                background: withAudio ? 'rgba(59,231,255,0.1)' : '#1A1F2A',
                color: withAudio ? '#3BE7FF' : '#4A5568',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 11, fontWeight: 600,
              }}
            >
              {withAudio ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Credits */}
          <span style={{ color: '#7B61FF', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
            {selectedModel.type === 'video'
              ? calculateVideoCost(CREDIT_ID_MAP[selectedModel.id] ?? selectedModel.id, duration, withAudio)
              : selectedModel.credits ?? 0
            } <span style={{ color: '#4A5568', fontWeight: 400 }}>QLC</span>
          </span>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!prompt.trim() || !!isGenerating || selectedLocked}
            style={!prompt.trim() || isGenerating || selectedLocked ? {
              background: '#1A1F2A', color: '#4A5568', border: 'none',
              borderRadius: 12, padding: '9px 14px',
              cursor: 'not-allowed', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            } : {
              background: 'linear-gradient(135deg, #7B61FF 0%, #3BE7FF 100%)',
              boxShadow: '0 0 24px rgba(123,97,255,0.45)',
              color: 'white', border: 'none', borderRadius: 12,
              padding: '9px 14px', cursor: 'pointer', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>Generate</span>
          </button>

        </div>{/* end controls row */}

      </div>
    </>
  )
}

// ── VideoSlot — sa upload na /api/generate/video/upload ──
function VideoSlot({ label, onUpload }: { label: string; onUpload?: (url: string) => void }) {
  const [preview, setPreview] = useState('')
  const [uploading, setUploading] = useState(false)

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPreview(URL.createObjectURL(file))
    if (onUpload) {
      setUploading(true)
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch('/api/generate/video/upload', { method: 'POST', body: formData })
        const data = await res.json()
        if (data.url) onUpload(data.url)
      } catch { /* silent */ } finally {
        setUploading(false)
      }
    }
    e.target.value = ''
  }

  return (
    <div
      title={label === 'START' ? 'Add start frame' : label === 'END' ? 'Add end frame' : 'Add reference image'}
      style={{
        width: 64, height: 64, flexShrink: 0,
        border: `1.5px dashed ${preview ? '#7B61FF' : '#2A2F3A'}`,
        borderRadius: 8, background: '#0D0D12',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        cursor: uploading ? 'not-allowed' : 'pointer',
        position: 'relative', overflow: 'hidden',
      }}
      onMouseEnter={e => { if (!preview) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,231,255,0.5)' }}
      onMouseLeave={e => { if (!preview) (e.currentTarget as HTMLElement).style.borderColor = '#2A2F3A' }}
    >
      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <button
            onClick={e => { e.stopPropagation(); setPreview(''); if (onUpload) onUpload('') }}
            style={{
              position: 'absolute', top: 3, right: 3, zIndex: 3,
              width: 16, height: 16, borderRadius: '50%',
              background: 'rgba(0,0,0,0.7)', border: '1px solid #4A5568',
              color: '#F4F7FB', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, lineHeight: 1,
            }}
          >×</button>
        </>
      ) : uploading ? (
        <div style={{
          width: 20, height: 20,
          border: '2px solid #2A2F3A', borderTopColor: '#7B61FF',
          borderRadius: '50%', animation: 'spin 1s linear infinite',
        }} />
      ) : (
        <>
          <span style={{ fontSize: 18, color: '#2A2F3A' }}>⊞</span>
          <span style={{ color: '#4A5568', fontSize: 9, fontWeight: 700, marginTop: 2 }}>{label}</span>
        </>
      )}
      <input
        type="file"
        accept="image/*"
        disabled={uploading}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: uploading ? 'not-allowed' : 'pointer' }}
        onChange={handleChange}
      />
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ImageSlot({ label, stateKey: _stateKey }: { label: string; stateKey: string }) {
  const [preview, setPreview] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div
      onClick={() => inputRef.current?.click()}
      title={label === 'START' ? 'Add start frame' : label === 'END' ? 'Add end frame' : 'Add reference image'}
      style={{
        width: 64, height: 64, flexShrink: 0,
        border: `1.5px dashed ${preview ? '#7B61FF' : '#2A2F3A'}`,
        borderRadius: 8, background: '#0D0D12',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', position: 'relative', overflow: 'hidden',
      }}
      onMouseEnter={e => { if (!preview) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,231,255,0.5)' }}
      onMouseLeave={e => { if (!preview) (e.currentTarget as HTMLElement).style.borderColor = '#2A2F3A' }}
    >
      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <button
            onClick={e => { e.stopPropagation(); setPreview('') }}
            style={{
              position: 'absolute', top: 3, right: 3, zIndex: 3,
              width: 16, height: 16, borderRadius: '50%',
              background: 'rgba(0,0,0,0.7)', border: '1px solid #4A5568',
              color: '#F4F7FB', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, lineHeight: 1,
            }}
          >×</button>
        </>
      ) : (
        <>
          <span style={{ fontSize: 18, color: '#2A2F3A' }}>⊞</span>
          <span style={{ color: '#4A5568', fontSize: 9, fontWeight: 700, marginTop: 2 }}>{label}</span>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) setPreview(URL.createObjectURL(file))
        }}
      />
    </div>
  )
}
