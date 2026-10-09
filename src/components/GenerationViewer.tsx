'use client'
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

interface GenerationViewerProps {
  isOpen: boolean
  status: 'generating' | 'completed' | 'failed'
  url?: string
  type: 'image' | 'video' | 'audio'
  modelName: string
  prompt: string
  credits: number
  progress?: number
  onClose: () => void
}

export default function GenerationViewer({
  isOpen, status, url, type, modelName,
  prompt, credits, progress = 0, onClose,
}: GenerationViewerProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isOpen) setVisible(true)
  }, [isOpen])

  // Auto-hide 2 s after completed, 3 s after failed
  useEffect(() => {
    if (status === 'completed' || status === 'failed') {
      const t = setTimeout(() => {
        setVisible(false)
        onClose()
      }, status === 'completed' ? 2000 : 3000)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  if (!visible) return null

  const isGenerating = status === 'generating'
  const isFailed = status === 'failed'
  const isDone = status === 'completed'

  // Boja accenta po statusu
  const accentColor = isFailed ? '#EF4444' : isDone ? '#3BE7FF' : '#A855F7'

  // suppress unused warning
  void url
  void type
  void credits

  return (
    <div style={{
      position: 'fixed',
      bottom: 100,
      left: 24,
      width: 280,
      background: 'rgba(13,13,18,0.97)',
      border: '1px solid #2A2F3A',
      borderRadius: 14,
      padding: '14px 16px',
      zIndex: 9990,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      backdropFilter: 'blur(16px)',
    }}>

      {/* TOP ROW: model badge + X */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Animated ring only while generating */}
          {isGenerating && (
            <div style={{
              width: 18, height: 18, flexShrink: 0,
              border: '2px solid #2A2F3A',
              borderTopColor: accentColor,
              borderRadius: '50%',
              animation: 'spinAnim 0.9s linear infinite',
            }} />
          )}
          {isDone && <span style={{ fontSize: 16 }}>✓</span>}
          {isFailed && <span style={{ fontSize: 16 }}>✕</span>}

          {/* Model badge */}
          <span style={{
            background: 'rgba(168,85,247,0.15)',
            color: accentColor,
            fontSize: 11, fontWeight: 700,
            padding: '2px 8px', borderRadius: 6,
          }}>
            {modelName}
          </span>
        </div>

        <button
          onClick={() => { setVisible(false); onClose() }}
          style={{
            background: 'transparent', border: 'none',
            color: '#4A5568', cursor: 'pointer',
            padding: 2, display: 'flex',
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* PROGRESS — only while generating */}
      {isGenerating && (
        <>
          {/* Progress bar */}
          <div style={{
            height: 3, background: '#1A1F2A',
            borderRadius: 99, marginBottom: 8, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: progress > 0 ? `${progress}%` : '0%',
              background: `linear-gradient(90deg, #7B61FF, ${accentColor})`,
              borderRadius: 99,
              transition: 'width 0.5s ease',
              animation: progress === 0 ? 'indeterminate 1.5s ease-in-out infinite' : 'none',
            }} />
          </div>

          {/* Postotak */}
          {progress > 0 && (
            <div style={{
              color: accentColor,
              fontSize: 22, fontWeight: 800,
              marginBottom: 4,
            }}>
              {progress}%
            </div>
          )}
        </>
      )}

      {/* STATUS TEXT */}
      <div style={{ color: '#6B7280', fontSize: 11, marginBottom: 6 }}>
        {isGenerating && progress === 0 && 'Starting generation...'}
        {isGenerating && progress > 0 && 'Generating...'}
        {isDone && <span style={{ color: '#3BE7FF' }}>Saved to gallery ✓</span>}
        {isFailed && <span style={{ color: '#EF4444' }}>Failed — please try again</span>}
      </div>

      {/* PROMPT PREVIEW */}
      <div style={{
        color: '#4A5568', fontSize: 11, lineHeight: 1.5,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      }}>
        {prompt.substring(0, 120)}{prompt.length > 120 ? '...' : ''}
      </div>

      {/* CSS animacije */}
      <style>{`
        @keyframes spinAnim { to { transform: rotate(360deg); } }
        @keyframes indeterminate {
          0% { transform: translateX(-100%); width: 40%; }
          50% { transform: translateX(100%); width: 60%; }
          100% { transform: translateX(300%); width: 40%; }
        }
      `}</style>
    </div>
  )
}
