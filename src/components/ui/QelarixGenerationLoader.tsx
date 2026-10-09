'use client'

/**
 * QelarixGenerationLoader — reusable, premium Qelarix-branded loading animation.
 * Use anywhere something is generating / rendering / exporting.
 *
 * CSS-only animation (no GIF/video/canvas, no heavy deps). Respects prefers-reduced-motion.
 * Uses the existing public asset /qelarix/qelarix_logo.png as the centerpiece, with a clean
 * inline "Q" mark fallback if the asset fails to load.
 */

import { useState } from 'react'
import styles from './qelarix-generation-loader.module.css'

export interface QelarixGenerationLoaderProps {
  /** Primary status text. Defaults to a mode-appropriate phrase. */
  label?: string
  /** Optional secondary line under the label. */
  sublabel?: string
  size?: 'sm' | 'md' | 'lg'
  /** Tints the glow/ring; audio also shows an equalizer. */
  mode?: 'image' | 'video' | 'audio' | 'export' | 'default'
  /** Horizontal compact layout (small disc + label inline). */
  compact?: boolean
}

const DEFAULT_LABEL: Record<NonNullable<QelarixGenerationLoaderProps['mode']>, string> = {
  image: 'Generating image…',
  video: 'Generating video…',
  audio: 'Generating audio…',
  export: 'Exporting…',
  default: 'Working…',
}

export default function QelarixGenerationLoader({
  label,
  sublabel,
  size = 'md',
  mode = 'default',
  compact = false,
}: QelarixGenerationLoaderProps) {
  const [imgOk, setImgOk] = useState(true)
  const text = label ?? DEFAULT_LABEL[mode]
  const cls = [styles.loader, styles[size], styles[mode], compact ? styles.compact : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} role="status" aria-live="polite">
      <div className={styles.disc} aria-hidden="true">
        <span className={styles.glow} />
        <span className={styles.ring} />
        <span className={styles.ring2} />
        <span className={styles.logoWrap}>
          {imgOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.logoImg} src="/qelarix/qelarix_logo.png" alt="" onError={() => setImgOk(false)} />
          ) : (
            <span className={styles.markFallback}>Q</span>
          )}
        </span>
      </div>

      {mode === 'audio' && (
        <div className={styles.bars} aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={styles.bar} style={{ height: 18, animationDelay: `${i * 0.12}s` }} />
          ))}
        </div>
      )}

      {text && (
        <div className={styles.text}>
          <span className={styles.label}>{text}</span>
          {sublabel && !compact && <span className={styles.sublabel}>{sublabel}</span>}
        </div>
      )}
      {!text && <span className={styles.srOnly}>Loading</span>}
    </div>
  )
}
