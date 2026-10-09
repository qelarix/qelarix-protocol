'use client'
import { useState, useEffect } from 'react'
import { X, Download, Trash2, Globe, Copy } from 'lucide-react'
import type { GalleryItem } from '@/types/gallery'
import QIcon from "@/components/ui/QIcon"

interface GenerationDetailModalProps {
  item: GalleryItem | null
  isOpen: boolean
  onClose: () => void
  onDelete: (id: string) => void
  onPublish: (id: string) => void
}

export default function GenerationDetailModal({
  item, isOpen, onClose, onDelete, onPublish,
}: GenerationDetailModalProps) {
  const [publishing, setPublishing] = useState(false)
  const [showPublishConfirm, setShowPublishConfirm] = useState(false)
  const [thumbnails, setThumbnails] = useState<string[]>([])

  useEffect(() => {
    setThumbnails([])
    if (!item?.url || item?.type !== 'video') return
    const video = document.createElement('video')
    video.src = item.url
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.onloadedmetadata = () => {
      const duration = video.duration
      const count = 12
      const times = Array.from({ length: count }, (_, i) => (i / (count - 1)) * duration)
      const thumbs: string[] = []
      let processed = 0
      times.forEach((t, i) => {
        const cv = document.createElement('canvas')
        cv.width = 120; cv.height = 68
        video.currentTime = t
        video.onseeked = () => {
          const ctx = cv.getContext('2d')
          if (ctx) {
            ctx.drawImage(video, 0, 0, 120, 68)
            thumbs[i] = cv.toDataURL('image/jpeg', 0.6)
            processed++
            if (processed === count) setThumbnails([...thumbs])
          }
        }
      })
    }
    video.load()
  }, [item?.url, item?.type])

  if (!isOpen || !item) return null

  const handleDownload = async () => {
    try {
      const res = await fetch(item.url)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      const ext = item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'mp3' : 'jpg'
      a.download = `qelarix-${item.id}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch { /* silent */ }
  }

  const handlePublish = async () => {
    setPublishing(true)
    try {
      const res = await fetch('/api/generations/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      })
      if (res.ok) onPublish(item.id)
    } catch { /* silent */ } finally {
      setPublishing(false)
    }
  }

  const handleDelete = () => {
    onDelete(item.id)
    onClose()
  }

  // ── VIDEO LAYOUT ──────────────────────────────────────────────
  if (item.type === 'video') {
    const iconTopBtn: React.CSSProperties = {
      width: 36, height: 36, background: '#1A1F2A',
      border: '1px solid #2A2F3A', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', color: '#AAB2BF', flexShrink: 0,
    }

    const ar = item.aspectRatio || '16:9'
    const resolution = ar === '9:16' ? '720 × 1280' : ar === '1:1' ? '1024 × 1024' : '1280 × 720'

    return (
      <>
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={onClose}
      >
        <div
          style={{ display: 'flex', flexDirection: 'row', width: '92vw', maxWidth: 1400, height: '90vh', background: '#0D0D12', borderRadius: 16, border: '1px solid #1A1F2A', overflow: 'hidden' }}
          onClick={e => e.stopPropagation()}
        >

          {/* LEFT — video + thumbnails */}
          <div style={{ flex: 1, background: '#000', position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <video
              src={item.url}
              controls
              loop
              playsInline
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                background: '#000',
              }}
            />
            {/* Thumbnail strip */}
            <div style={{
              display: 'flex', gap: 2, padding: '6px 8px',
              background: '#0A0A0F', overflowX: 'hidden',
              height: 68, flexShrink: 0,
            }}>
              {thumbnails.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={src} alt=""
                  style={{ height: 56, width: 100, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                />
              ))}
            </div>
          </div>

          {/* RIGHT — panel */}
          <div style={{
            width: 340, flexShrink: 0, padding: 24,
            borderLeft: '1px solid #1A1F2A',
            display: 'flex', flexDirection: 'column', gap: 0,
            overflowY: 'auto', background: '#0D0D12',
          }}>

            {/* Top row — actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <button onClick={handleDownload} style={{
                flex: 1, padding: '10px 0',
                background: '#1A1F2A', color: '#F4F7FB',
                border: '1px solid #2A2F3A', borderRadius: 10,
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}>
                <Download size={14} /> Download
              </button>
              <button onClick={() => navigator.clipboard.writeText(item.url)} style={iconTopBtn} title="Copy link">
                <Copy size={15} />
              </button>
              <button onClick={() => !item.isPublic && setShowPublishConfirm(true)} style={iconTopBtn} title="Publish to Community">
                <Globe size={15} color={item.isPublic ? '#3BE7FF' : '#AAB2BF'} />
              </button>
              <button onClick={() => { onDelete(item.id); onClose() }} style={iconTopBtn} title="Delete">
                <Trash2 size={15} color='#EF4444' />
              </button>
              <button onClick={onClose} style={iconTopBtn} title="Close">
                <X size={15} />
              </button>
            </div>

            {/* Prompt */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ color: '#4A5568', fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>PROMPT</span>
                <button onClick={() => navigator.clipboard.writeText(item.prompt)}
                  style={{ background: 'transparent', border: 'none', color: '#4A5568', cursor: 'pointer' }}>
                  <Copy size={12} />
                </button>
              </div>
              <div style={{
                background: '#111318', border: '1px solid #1A1F2A',
                borderRadius: 10, padding: '12px 14px',
                color: '#C7CDD6', fontSize: 13, lineHeight: 1.7,
                maxHeight: 160, overflowY: 'auto',
              }}>
                {item.prompt}
              </div>
            </div>

            {/* Settings */}
            <div>
              <span style={{ color: '#4A5568', fontSize: 10, fontWeight: 700, letterSpacing: 1, display: 'block', marginBottom: 10 }}>SETTINGS</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, border: '1px solid #1A1F2A', borderRadius: 10, overflow: 'hidden' }}>
                {([
                  ['MODEL', item.model],
                  ['ASPECT RATIO', ar],
                  ['FILE TYPE', 'MP4'],
                  ['RESOLUTION', resolution],
                  ['DATE CREATED', new Date(item.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })],
                ] as [string, string][]).map(([label, value], i, arr) => (
                  <div key={label} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '11px 14px',
                    borderBottom: i < arr.length - 1 ? '1px solid #1A1F2A' : 'none',
                    background: '#111318',
                  }}>
                    <span style={{ color: '#4A5568', fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>{label}</span>
                    <span style={{ color: '#C7CDD6', fontSize: 12 }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom buttons */}
            <div style={{ display: 'flex', gap: 10, marginTop: 'auto', paddingTop: 20 }}>
              <button onClick={handleDownload} style={{
                flex: 1, padding: '13px',
                background: '#111318', color: '#F4F7FB',
                border: '1px solid #2A2F3A',
                borderRadius: 12, fontSize: 14, fontWeight: 700,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}>
                <Download size={16} /> Download
              </button>
              <button
                onClick={() => !item.isPublic && setShowPublishConfirm(true)}
                disabled={item.isPublic}
                style={{
                  flex: 1, padding: '13px',
                  background: item.isPublic ? 'rgba(59,231,255,0.1)' : '#7B61FF',
                  color: item.isPublic ? '#3BE7FF' : 'white',
                  border: item.isPublic ? '1px solid #3BE7FF' : 'none',
                  borderRadius: 12, fontSize: 14, fontWeight: 700,
                  cursor: item.isPublic ? 'default' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <Globe size={16} />
                {item.isPublic ? 'Published' : 'Publish to Community'}
              </button>
            </div>

          </div>
        </div>
      </div>

      {showPublishConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowPublishConfirm(false)}>
          <div style={{ background: '#111318', border: '1px solid #2A2F3A', borderRadius: 16, padding: 28, maxWidth: 360, width: '90%', textAlign: 'center' }}
            onClick={e => e.stopPropagation()}>
            <Globe size={32} color='#7B61FF' style={{ marginBottom: 12 }} />
            <h3 style={{ color: '#F4F7FB', fontSize: 16, fontWeight: 700, margin: '0 0 10px' }}>Publish to Community</h3>
            <p style={{ fontSize: 15, fontWeight: 700, color: '#F4F7FB', margin: '0 0 6px' }}>Let&apos;s make you famous on Qelarix!</p>
            <p style={{ fontSize: 13, color: '#AAB2BF', margin: '0 0 8px', lineHeight: 1.6 }}>Share your creation with the community and let the world see your work.</p>
            <p style={{ fontSize: 11, color: '#4A5568', margin: '0 0 20px', lineHeight: 1.5 }}>This action cannot be undone. If you delete this creation, it will also be removed from Community.</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowPublishConfirm(false)}
                style={{ flex: 1, padding: '11px', background: '#1A1F2A', color: '#F4F7FB', border: '1px solid #2A2F3A', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={async () => { setShowPublishConfirm(false); await handlePublish() }}
                disabled={publishing}
                style={{ flex: 1, padding: '11px', background: '#7B61FF', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: publishing ? 0.7 : 1 }}>
                {publishing ? 'Publishing...' : 'Publish to Community'}
              </button>
            </div>
          </div>
        </div>
      )}
      </>
    )
  }

  // ── IMAGE / AUDIO LAYOUT (unchanged) ──────────────────────────
  const dateStr = new Date(item.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  return (
    <>
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}
    >
      <div
        style={{ display: 'flex', width: '85vw', maxWidth: 1100, height: '82vh', background: '#111318', borderRadius: 20, border: '1px solid #2A2F3A', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left — media */}
        <div style={{ flex: '0 0 65%', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {item.type === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.url} alt={item.prompt} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          )}
          {item.type === 'audio' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
              <QIcon name="music" size={56} strokeWidth={1.2} style={{ opacity: 0.6 }} />
              <audio controls src={item.url} style={{ width: 300 }} />
            </div>
          )}
        </div>

        {/* Right — details */}
        <div style={{ flex: '0 0 35%', padding: 28, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #2A2F3A', overflowY: 'auto' }}>
          <button onClick={onClose} style={{ alignSelf: 'flex-end', background: 'transparent', border: 'none', color: '#AAB2BF', cursor: 'pointer', padding: 4, marginBottom: 16 }}>
            <X size={20} />
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
            <InfoRow label="MODEL" value={item.model} highlight />
            {item.aspectRatio && (
              <InfoRow label="RATIO" value={`${item.duration ? item.duration + 's | ' : ''}${item.aspectRatio}`} />
            )}
            <InfoRow label="CREATED" value={dateStr} />
            <InfoRow label="QLC USED" value={`${item.credits} QLC`} />
          </div>

          <div style={{ marginBottom: 'auto' }}>
            <p style={{ color: '#4A5568', fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>PROMPT</p>
            <div style={{ background: '#0D0D12', border: '1px solid #2A2F3A', borderRadius: 8, padding: 12, color: '#F4F7FB', fontSize: 13, lineHeight: 1.6, maxHeight: 160, overflowY: 'auto' }}>
              {item.prompt}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
            <button onClick={handleDownload} style={{ width: '100%', padding: 12, background: '#7B61FF', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Download size={16} /> Download
            </button>
            <button onClick={() => !item.isPublic && setShowPublishConfirm(true)} disabled={item.isPublic || publishing} style={{ width: '100%', padding: 12, background: 'transparent', color: item.isPublic ? '#3BE7FF' : '#7B61FF', border: `1px solid ${item.isPublic ? '#3BE7FF' : '#7B61FF'}`, borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: item.isPublic ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: publishing ? 0.6 : 1 }}>
              <Globe size={16} />
              {item.isPublic ? 'Published to Community' : publishing ? 'Publishing...' : 'Publish to Community'}
            </button>
            <button onClick={handleDelete} style={{ width: '100%', padding: 12, background: 'transparent', color: '#EF4444', border: '1px solid #EF4444', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </div>
      </div>
    </div>

    {showPublishConfirm && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => setShowPublishConfirm(false)}>
        <div style={{ background: '#111318', border: '1px solid #2A2F3A', borderRadius: 16, padding: 28, maxWidth: 360, width: '90%', textAlign: 'center' }}
          onClick={e => e.stopPropagation()}>
          <Globe size={32} color='#7B61FF' style={{ marginBottom: 12 }} />
          <h3 style={{ color: '#F4F7FB', fontSize: 16, fontWeight: 700, margin: '0 0 10px' }}>Publish to Community</h3>
          <p style={{ fontSize: 15, fontWeight: 700, color: '#F4F7FB', margin: '0 0 6px' }}>Let&apos;s make you famous on Qelarix!</p>
          <p style={{ fontSize: 13, color: '#AAB2BF', margin: '0 0 8px', lineHeight: 1.6 }}>Share your creation with the community and let the world see your work.</p>
          <p style={{ fontSize: 11, color: '#4A5568', margin: '0 0 20px', lineHeight: 1.5 }}>This action cannot be undone. If you delete this creation, it will also be removed from Community.</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setShowPublishConfirm(false)}
              style={{ flex: 1, padding: '11px', background: '#1A1F2A', color: '#F4F7FB', border: '1px solid #2A2F3A', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={async () => { setShowPublishConfirm(false); await handlePublish() }}
              disabled={publishing}
              style={{ flex: 1, padding: '11px', background: '#7B61FF', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: publishing ? 0.7 : 1 }}>
              {publishing ? 'Publishing...' : 'Publish to Community'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p style={{ color: '#4A5568', fontSize: 10, fontWeight: 700, letterSpacing: 1, margin: '0 0 4px' }}>{label}</p>
      <span style={{ background: highlight ? 'rgba(123,97,255,0.15)' : 'transparent', color: highlight ? '#7B61FF' : '#F4F7FB', fontSize: 13, fontWeight: highlight ? 600 : 400, padding: highlight ? '3px 8px' : 0, borderRadius: highlight ? 6 : 0 }}>
        {value}
      </span>
    </div>
  )
}
