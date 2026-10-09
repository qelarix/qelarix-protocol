'use client'
import { useRef, useState } from 'react'
import { Plus, Download, Trash2 } from 'lucide-react'
import type { GalleryItem } from '@/types/gallery'
import QIcon from "@/components/ui/QIcon"

interface GenerationGalleryProps {
  items: GalleryItem[]
  onDelete: (id: string) => void
  onItemClick: (item: GalleryItem) => void
}

export default function GenerationGallery({ items, onDelete, onItemClick }: GenerationGalleryProps) {
  if (items.length === 0) return null

  return (
    <div style={{ width: '100%', padding: '16px 16px 0', marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {items.map(item => (
          <GalleryCard key={item.id} item={item} onDelete={onDelete} onItemClick={onItemClick} />
        ))}
      </div>
    </div>
  )
}

const iconBtnStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.7)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 6, padding: 5,
  color: 'white', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

function GalleryCard({ item, onDelete, onItemClick }: {
  item: GalleryItem
  onDelete: (id: string) => void
  onItemClick: (item: GalleryItem) => void
}) {
  const [hovered, setHovered] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const handleMouseEnter = () => {
    setHovered(true)
    if (item.type === 'video' && videoRef.current) {
      videoRef.current.play().catch(() => {})
    }
  }

  const handleMouseLeave = () => {
    setHovered(false)
    if (item.type === 'video' && videoRef.current) {
      videoRef.current.pause()
      videoRef.current.currentTime = 0
    }
  }

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    const a = document.createElement('a')
    a.href = item.url
    a.download = `qelarix-${item.id}.${item.type === 'video' ? 'mp4' : 'jpg'}`
    a.click()
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(item.id)
  }

  return (
    <div
      style={{
        position: 'relative', aspectRatio: '16/9',
        background: '#111318', borderRadius: 10,
        border: '1px solid #2A2F3A', overflow: 'hidden', cursor: 'pointer',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={() => onItemClick(item)}
    >
      {item.type === 'video' && (
        <video ref={videoRef} src={item.url} loop playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
      {item.type === 'image' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.url} alt={item.prompt}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
      {item.type === 'audio' && (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#111318', gap: 8 }}>
          <QIcon name="music" size={26} strokeWidth={1.3} style={{ opacity: 0.6, color: '#AAB2BF' }} />
          <span style={{ color: '#AAB2BF', fontSize: 11 }}>{item.model}</span>
        </div>
      )}

      {hovered && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 8,
        }}>
          <div style={{ background: 'rgba(0,0,0,0.6)', borderRadius: 5, padding: '3px 8px', alignSelf: 'flex-start', color: '#AAB2BF', fontSize: 10, fontWeight: 500 }}>
            {item.model}
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={(e) => e.stopPropagation()} title="Add to Canvas" style={iconBtnStyle}>
                <Plus size={13} />
              </button>
              <button onClick={handleDownload} title="Download" style={iconBtnStyle}>
                <Download size={13} />
              </button>
            </div>
            <button onClick={handleDelete} title="Delete" style={{ ...iconBtnStyle, background: 'rgba(239,68,68,0.8)' }}>
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )}

      <div style={{
        position: 'absolute', top: 6, right: 6,
        background: 'rgba(0,0,0,0.75)', borderRadius: 4, padding: '2px 6px',
        fontSize: 9, color: '#7B61FF', fontWeight: 700, pointerEvents: 'none',
      }}>
        {item.credits} QLC
      </div>
    </div>
  )
}
