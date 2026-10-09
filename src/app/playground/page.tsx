'use client'

/**
 * Qelarix Playground v1.2 — professional creation workspace.
 * React workspace with a scoped CSS module.
 * Wired to the EXISTING generate/history APIs (image/video/audio) — same request/response
 * contract the previous Playground used, so generation behavior is unchanged.
 *
 * Renders inside the existing app shell: the global <Header/> (56px) stays; this workspace
 * fills the remaining viewport (height: calc(100vh - 56px)) — same convention as Cinema Studio.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { getModelsByType, providerColor, type QelarixModel } from '@/lib/models'
import { getImageModelById, getImageTierCredits, getImageResolutionCredits, getImageSpeedCredits, getImageQualityCredits, IMAGE_MODELS } from '@/lib/image-models'
import { calculateVideoCost } from '@/lib/credits'
import { getAudioModelById, resolveAudioCredits } from '@/lib/audio-models'
import { getVideoCapability, clampVideoDuration, getVideoControls, getVideoFamilyFrames, resolveVideoVariantSlug, resolveVideoModeSlug, type VideoWorkflowMode } from '@/lib/video-capabilities'
import QelarixGenerationLoader from '@/components/ui/QelarixGenerationLoader'
import QelarixGridBackdrop from '@/components/ui/QelarixGridBackdrop'
import s from './playground.module.css'

type Mode = 'image' | 'video' | 'audio'
type HistFilter = 'all' | 'image' | 'video' | 'audio'

// Freeform workspace layer (notes + dragged history assets) floating over the center canvas.
// Local UI state, persisted to localStorage (browser-only; no backend).
type WsItem =
  | { id: string; kind: 'note'; x: number; y: number; z: number; text: string }
  | { id: string; kind: 'asset'; x: number; y: number; z: number; assetType: 'image' | 'video' | 'audio'; url: string; prompt: string }

const WS_STORAGE_KEY = 'qelarix.playground.workspace.v1'
// DEV-ONLY: gates the Video "Preview Payload" debug control. Next.js inlines NEXT_PUBLIC_* at build time, so this is
// `false` in production unless NEXT_PUBLIC_QELARIX_DEBUG_PAYLOADS="true" is explicitly set → no production exposure.
const DEBUG_PAYLOADS = process.env.NEXT_PUBLIC_QELARIX_DEBUG_PAYLOADS === 'true'

// Validate a persisted item before trusting it (storage can be corrupt or stale across versions).
function isValidWsItem(o: unknown): o is WsItem {
  if (!o || typeof o !== 'object') return false
  const r = o as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.x !== 'number' || typeof r.y !== 'number' || typeof r.z !== 'number') return false
  if (r.kind === 'note') return typeof r.text === 'string'
  if (r.kind === 'asset') return (r.assetType === 'image' || r.assetType === 'video' || r.assetType === 'audio') && typeof r.url === 'string'
  return false
}

// Deterministic subtle tilt per note (pinned-paper feel; same note keeps the same angle across renders/refresh).
function noteTilt(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((Math.abs(h) % 5) - 2) * 0.8
}

// QelarixModel.id → generate-route model id (carried over from the previous Playground).
// Catalog → runtime slug bridges now come from the unified runtime source (src/lib/catalog.ts) —
// no longer duplicated per surface. Same maps used by /video, /image and future surfaces.
import { VIDEO_MODEL_IDS, IMAGE_MODEL_IDS, canAccessModel, type PlanId } from '@/lib/catalog'
import QIcon from "@/components/ui/QIcon"

const ASPECTS: Record<Exclude<Mode, 'audio'>, { v: string; w: number; h: number }[]> = {
  image: [
    { v: '1:1', w: 16, h: 16 }, { v: '4:3', w: 19, h: 14 }, { v: '16:9', w: 21, h: 12 }, { v: '9:16', w: 12, h: 21 },
  ],
  video: [
    { v: '1:1', w: 16, h: 16 }, { v: '16:9', w: 21, h: 12 }, { v: '9:16', w: 12, h: 21 }, { v: '21:9', w: 22, h: 9 },
  ],
}
// VIDEO_DURATIONS removed — duration options now come from the per-model capability descriptor
// (video-capabilities.ts), so the UI only offers durations the selected model truly supports.
const IMG_QUALITY = ['Standard', 'HD'] // backend quality is only "standard" | "hd" — NO native 4K. Sent only for models with supportsQuality.
// Audio controls are model-driven from the unified registry (src/lib/audio-models.ts):
// length/duration tiers render only for models that truthfully support them (Stability, ACE-Step);
// ElevenLabs TTS and Lyria are prompt-only. Pricing comes from resolveAudioCredits() -> CREDITS.audio.
const IMG_STYLES = ['Default', 'Cinematic', 'Photorealistic', 'Concept Art', '3D Render', 'Illustration', 'Abstract']
// Style is NOT a provider field — it is appended to the prompt as a short modifier (Default = original prompt unchanged).
const STYLE_MODIFIERS: Record<string, string> = {
  Cinematic: 'cinematic lighting, filmic, dramatic composition',
  Photorealistic: 'photorealistic, highly detailed, natural lighting',
  'Concept Art': 'concept art, digital painting',
  '3D Render': '3D render, octane, physically based materials',
  Illustration: 'illustration, clean linework, stylized',
  Abstract: 'abstract, expressive shapes and color',
}
const CAMERAS = [
  { i: '↗', l: 'Push In' }, { i: '↙', l: 'Pull Out' }, { i: '↔', l: 'Pan' },
  { i: '↕', l: 'Tilt' }, { i: '⟳', l: 'Orbit' }, { i: '·', l: 'Static' },
]
const SHOT_TYPES = ['Wide', 'Establishing', 'Close-up', 'POV', 'Aerial', 'Macro', 'Dutch']
const MOTIONS = ['Slow motion reveal', 'Dolly zoom', 'Handheld organic', 'Time-lapse']

// Video Director / Cinematic Direction → short prompt modifiers, folded into the prompt CLIENT-SIDE
// (same approach as STYLE_MODIFIERS for image). This changes only the composed prompt text — never the
// route body shape, pricing, or capabilities. Values mapped to '' are NEUTRAL and add nothing (no spam).
const CAMERA_MODIFIERS: Record<string, string> = {
  'Push In': 'push-in camera movement',
  'Pull Out': 'pull-out camera movement',
  Pan: 'panning camera',
  Tilt: 'tilting camera',
  Orbit: 'orbiting camera movement',
  Static: '', // neutral — no camera move
}
const SPEED_RAMP_MODIFIERS: Record<string, string> = {
  Linear: '', // neutral — constant speed
  'Slow-mo': 'slow-motion',
  'Ramp up': 'speed ramp up',
  'Ramp down': 'speed ramp down',
  Freeze: 'freeze-frame moment',
}
const SHOT_TYPE_MODIFIERS: Record<string, string> = {
  Wide: 'wide shot',
  Establishing: 'establishing shot',
  'Close-up': 'close-up shot',
  POV: 'POV shot',
  Aerial: 'aerial shot',
  Macro: 'macro shot',
  Dutch: 'Dutch angle',
}
const MOTION_MODIFIERS: Record<string, string> = {
  'Slow motion reveal': 'slow-motion reveal',
  'Dolly zoom': 'dolly zoom',
  'Handheld organic': 'handheld organic motion',
  'Time-lapse': 'time-lapse',
}

// Video reference ROLE-TAG guidance (Phase 1: UI metadata only). When a SELECTED video reference is tagged,
// this short hint is folded into the prompt TEXT via the existing vidPrompt path. It is NOT a provider payload —
// no current Playground video model accepts role-based references, so the provider receives only this text.
const VIDEO_REF_TAG_GUIDANCE: Record<'character' | 'style' | 'object' | 'background', string> = {
  character: 'Keep the referenced character visually consistent.',
  style: 'Use the referenced image as a visual style guide.',
  object: 'Preserve the referenced product/object design.',
  background: 'Use the referenced image as background/environment inspiration.',
}
// Short role labels (chip + @imageN reference note) and ordinal words for the mention note (Phase 1).
const VIDEO_REF_TAG_LABELS: Record<'character' | 'style' | 'object' | 'background', string> = {
  character: 'Character', style: 'Style', object: 'Object', background: 'Background',
}
const VIDEO_MENTION_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const videoMentionOrdinal = (n: number) => VIDEO_MENTION_ORDINALS[n - 1] ?? `#${n}`

// Model picker card helpers (UI-ONLY). Map a catalog badge label → its premium per-type pill class, and derive
// TRUTHFUL capability chips: duration/audio from the runtime registry, resolution from the curated catalog tag. A
// value is shown ONLY when reliably known — never invented. No effect on capabilities / pricing / routes / access.
function modelBadgeClass(b: string): string {
  switch ((b || '').toUpperCase()) {
    case 'NEW': return s.badgeNew
    case 'PREMIUM': return s.badgePro
    case 'EXCLUSIVE': return s.badgeExclusive
    case 'SOON': return s.badgeSoon
    default: return ''
  }
}
// Display-ONLY (UI) max output resolution per runtime video slug, used PURELY for the picker's Resolution chip. NOT a
// capability/route/pricing value (the route never reads it). Each value is the highest TRUTHFUL output already
// documented in the model's own description, its qualityOptions, or Cinema's verified registry — never invented.
const VIDEO_DISPLAY_RES: Record<string, string> = {
  kling3: '1080p', kling3pro: '1080p', kling3_4k: '4K', kling3_standard: '1080p', kling3_omni: '1080p',
  kling26_pro: '1080p', kling26_standard: '1080p',
  seedance20: '720p', seedance2: '720p',
  grokvideo: '720p', wan22: '720p',
  luma3: '1080p', pika25: '1080p', ltx2: 'HD',
  veo4: '720p', veo31_standard: '720p', veo31: '720p', veo3: '720p',
  sora2: '720p', sora2pro: '720p',
}
// Premium capability icons — minimal outline, single stroke, inherit the chip's text color (currentColor). One family,
// same size + stroke. Reusable for any model/dropdown card (image/audio/future dropdowns).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function IconClock() {
  return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.3 1.4" /></svg>
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function IconQuality() {
  return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="5.6" /><path d="M5.6 8.2l1.7 1.7 3.2-3.6" /></svg>
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function IconSpeaker() {
  return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.4 6.1h1.8L8.4 3.6v8.8L5.2 9.9H3.4V6.1z" /><path d="M10.9 6.3a2.5 2.5 0 0 1 0 3.4" /></svg>
}
function modelCardCaps(m: { id: string; type: 'image' | 'video' | 'audio'; tags?: string[] }): { dur?: string; res?: string; audio?: boolean } {
  const resTag = (m.tags ?? []).find((t) => /\b\d{3,4}p\b|\b\d(\.\d)?K\b|\bHD\b/i.test(t))
  if (m.type === 'video') {
    const slug = VIDEO_MODEL_IDS[m.id] || m.id
    const cap = getVideoCapability(slug)
    const d = cap?.durations ?? []
    const dur = d.length ? (d.length === 1 ? `${d[0]}s` : `${Math.min(...d)}s–${Math.max(...d)}s`) : undefined
    const qo = getVideoControls(slug)?.qualityOptions
    const res = VIDEO_DISPLAY_RES[slug] ?? (qo && qo.length ? qo[qo.length - 1] : undefined) ?? resTag
    return { dur, res, audio: !!cap?.hasAudio }
  }
  if (m.type === 'image') return { res: resTag }
  return {}
}

// Featured-row metadata (compact second line) — truthful, derived from EXISTING capability data only, never invented.
// Video → duration · resolution · Audio (from the runtime registry). Image → aspect · resolution · output count (from the image-models config).
function featuredMetaParts(m: QelarixModel): string[] {
  if (m.type === 'video') {
    const caps = modelCardCaps(m)
    return [caps.dur, caps.res, caps.audio ? 'Audio' : null].filter(Boolean) as string[]
  }
  if (m.type === 'image') {
    const cfg = getImageModelById(IMAGE_MODEL_IDS[m.id] || m.id)
    const aspect = cfg?.aspectRatios?.includes('1:1') ? '1:1' : cfg?.aspectRatios?.[0]
    const res = cfg?.defaultResolution ?? modelCardCaps(m).res
    const n = cfg?.maxImages
    const count = (typeof n === 'number' && n > 0) ? `${n} image${n > 1 ? 's' : ''}` : undefined
    return [aspect, res, count].filter(Boolean) as string[]
  }
  return []
}

// Audio Genre / Mood option lists (music models only — NOT TTS). 'Auto' = no enrichment. Selecting a non-Auto value
// prepends "Genre: X." / "Mood: Y." to the generated prompt client-side (no provider field invented).
const AUDIO_GENRES = ['Auto', 'House', 'Techno', 'EDM', 'Trance', 'Cinematic', 'Pop', 'Hip-Hop', 'Rock', 'Ambient']
const AUDIO_MOODS = ['Auto', 'Epic', 'Dark', 'Emotional', 'Energetic', 'Dreamy', 'Aggressive', 'Happy', 'Sad', 'Luxury']

const PLACEHOLDERS: Record<Mode, string> = {
  image: 'Describe your vision — a scene, a character, an atmosphere…',
  video: 'Describe your scene — camera movement, lighting, action, mood…',
  audio: 'Describe the sound — instruments, mood, environment, emotions…',
}
const ENHANCE: Record<Mode, string[]> = {
  image: [
    ', Hasselblad medium format, f/1.4, golden hour, cinematic anamorphic bokeh, film grain, ARRI',
    ', hyperrealistic, 8K, volumetric fog, rim lighting, Kodachrome color grade, ultra-detailed',
    ', concept art, dramatic side lighting, cinematic atmosphere, aerial perspective, award-winning',
  ],
  video: [
    ', smooth dolly push-in, 1.33x anamorphic, 24fps, teal and orange LUT, shallow DOF',
    ', ARRI Alexa, aerial establishing shot, slow motion 120fps, cinematic grade',
    ', handheld organic motion, golden hour, anamorphic lens flare, Hans Zimmer score',
  ],
  audio: [
    ', sweeping orchestral strings, IMAX quality, emotional crescendo, spatial',
    ', layered ambience, binaural depth, reverb tail, immersive, professional mastering',
    ', organic textures, evolving harmonic pad, dynamic range, Dolby Atmos, cinematic',
  ],
}

interface GenItem {
  id: string
  type: Mode
  status: 'generating' | 'completed' | 'failed'
  url?: string
  urls?: string[] // multi-output: all returned image URLs (image only); url stays = urls[0] for back-compat
  prompt: string
  model: string
}
interface HistItem {
  id: string
  type: Mode
  prompt: string
  model: string
  url?: string
  urls?: string[] // multi-output: all parsed output URLs (image only); url stays = urls[0] for back-compat
  createdAt: number
  source: 'playground' | 'cinema_studio'
  stillUrl?: string // Cinema Studio only: safe own-bucket thumbnail-derived still, reusable as an image reference
}

// Bulk Generation v1 (client-side fan-out): a batch is N sub-jobs, each a normal /api/generate/image request
// (≤ model.maxImages). Sub-jobs charge per-success via the existing credits_deducted CAS — no upfront/reserve/refund.
interface BulkJob { idx: number; n: number; status: 'pending' | 'running' | 'done' | 'failed'; body: Record<string, unknown> }
interface BulkState { batchId: string; total: number; modelName: string; prompt: string; jobs: BulkJob[]; urls: string[]; active: boolean }

// Prompt bar is a fixed compact height (.promptArea in the CSS module); panels float above it.

// `logo` = local PNG under /public (served at site root). Rendered white via CSS filter; missing/undefined → initials fallback.
const IMG_LOGOS = '/qelarix-image-model-logos'
const VID_LOGOS = '/qelarix-video-model-logos'
const PICKER_FAMILIES: Record<'image' | 'video' | 'audio', Array<{ id: string; label: string; desc: string; ids: string[]; logo?: string }>> = {
  image: [
    { id: 'flux',      label: 'FLUX',      desc: 'Studio-grade detail, color, and composition control.',          ids: ['flux2_pro', 'flux2_max'], logo: `${IMG_LOGOS}/flux.png` },
    { id: 'seedream',  label: 'Seedream',  desc: 'Cinematic scenes with deep style and character understanding.',  ids: ['seedream5', 'seedream45'], logo: `${IMG_LOGOS}/seedream-bytedance.png` },
    { id: 'google',    label: 'Google',    desc: 'Photorealistic images with accurate text rendering.',             ids: ['nano_banana2', 'nano_banana_pro', 'imagen4'], logo: `${IMG_LOGOS}/google.png` },
    { id: 'openai',    label: 'OpenAI',    desc: 'Flagship model with quality tiers and precise instruction.',     ids: ['gpt_image2'], logo: `${IMG_LOGOS}/openai.png` },
    { id: 'ideogram',  label: 'Ideogram',  desc: 'Best-in-class text rendering inside images.',                    ids: ['ideogram3'], logo: `${IMG_LOGOS}/ideogram.png` },
    { id: 'recraft',   label: 'Recraft',   desc: 'Vector-quality design with style and format control.',           ids: ['recraft_v4'], logo: `${IMG_LOGOS}/recraft.png` },
    { id: 'grok',      label: 'Grok',      desc: 'Bold, expressive, photorealistic image generation.',             ids: ['grok_imagine'], logo: `${IMG_LOGOS}/grok.png` },
    { id: 'stability', label: 'Stability', desc: 'Reliable image generation for everyday creative work.',          ids: ['sd35'], logo: `${IMG_LOGOS}/stability.png` },
  ],
  video: [
    { id: 'kling',    label: 'Kling',    desc: 'Advanced motion, reference control, and cinematic action.',       ids: ['kling3', 'kling3_pro', 'kling3_4k', 'kling3_standard', 'kling3_omni', 'kling26_pro', 'kling_o1_reference'], logo: `${VID_LOGOS}/kling.png` },
    { id: 'seedance', label: 'Seedance', desc: 'Cinematic multi-shot scenes with native audio.',                  ids: ['seedance2', 'seedance2_fast'], logo: `${VID_LOGOS}/seedance-bytedance.png` },
    { id: 'veo',      label: 'Google Veo', desc: 'Precision cinematic video with sound control.',                 ids: ['veo3', 'veo31_standard', 'veo31', 'veo4'], logo: `${VID_LOGOS}/veo-google.png` },
    { id: 'sora',     label: 'OpenAI Sora', desc: 'Multi-shot video with strong prompt understanding.',           ids: ['sora2', 'sora2pro'], logo: `${VID_LOGOS}/sora-mono.png` },
    { id: 'luma',     label: 'Luma',     desc: 'Smooth image-to-video and cinematic motion.',                     ids: ['luma_ray3'], logo: `${VID_LOGOS}/luma.png` },
    { id: 'grok',     label: 'Grok',     desc: 'Fast creative video with built-in audio generation.',             ids: ['grok_video'], logo: `${VID_LOGOS}/grok.png` },
    { id: 'wan',      label: 'Wan',      desc: 'Camera-controlled video with sound, more freedom.',               ids: ['wan22'], logo: `${VID_LOGOS}/wan_logo_icon_only.png` },
    { id: 'pika',     label: 'Pika',     desc: 'Creative short-form video and stylized motion.',                   ids: ['pika25'], logo: `${VID_LOGOS}/pika.png` },
    { id: 'ltx',      label: 'LTX',      desc: 'Fast prompt-to-video for lightweight scenes.',                    ids: ['ltx2'], logo: `${VID_LOGOS}/ltx.png` },
  ],
  audio: [
    { id: 'elevenlabs', label: 'ElevenLabs', desc: 'Expressive TTS, multilingual voice, and full song generation.', ids: ['eleven_v3', 'eleven_multilingual_v2', 'elevenlabs_music'] },
    { id: 'google',     label: 'Google',     desc: 'Cinematic instrumental music generation.',                        ids: ['lyria2'], logo: `${IMG_LOGOS}/google.png` },
    { id: 'stability',  label: 'Stability',  desc: 'AI music and sound generation up to 2 minutes.',                 ids: ['stability_audio'], logo: `${IMG_LOGOS}/stability.png` },
    { id: 'acestep',    label: 'ACE-Step',   desc: 'Song generation with optional lyrics support.',                  ids: ['ace_step'] },
  ],
}

const PICKER_FEATURED: Record<'image' | 'video' | 'audio', string[]> = {
  video: ['kling3', 'seedance2', 'veo3'],
  image: ['gpt_image2', 'flux2_pro', 'seedream45'],
  audio: ['elevenlabs_music', 'eleven_v3'],
}

function relTime(ts: number): string {
  const d = Math.max(0, Date.now() - ts)
  const m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Reliable single-asset download (cross-origin safe): fetch → blob → object URL → anchor click → revoke. A plain
// <a download> is ignored for cross-origin storage URLs; the blob is same-origin so the filename IS honored.
// Fallback: open the URL in a new tab so the user can still save manually if the fetch is blocked (CORS/network).
async function downloadAsset(url: string, filename: string): Promise<void> {
  if (!url) return
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(blobUrl)
  } catch {
    try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
  }
}

// Download MULTIPLE assets as SEPARATE files (NOT a ZIP). Reuses downloadAsset, staggered ~250ms so browsers don't
// block the batch. Indexed filenames: `${prefix}-1.png`, `${prefix}-2.png`, … Skips empty/invalid URLs. Call from a
// user click (multiple programmatic downloads require a user gesture).
async function downloadAssets(urls: string[], filenamePrefix: string, ext = 'png'): Promise<void> {
  const valid = urls.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
  for (let i = 0; i < valid.length; i++) {
    await downloadAsset(valid[i], `${filenamePrefix}-${i + 1}.${ext}`)
    if (i < valid.length - 1) await new Promise<void>((r) => setTimeout(r, 250))
  }
}

export default function PlaygroundPage() {
  const { data: session } = useAuthSession()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const su = session?.user as any
  const credits: number = typeof su?.credits === 'number' ? su.credits : 0
  const plan: string = (su?.plan as string) ?? 'free' // session.user.plan (auth.ts) — drives the picker lock indicator

  // /video and /image render this same workspace locked to one mode, each with its own theme and live
  // background (video: deep blue grid; image: green line grid). /playground stays unlocked.
  const pathname = usePathname()
  const lockedMode: Mode | null = pathname === '/video' ? 'video' : pathname === '/image' ? 'image' : pathname === '/audio' ? 'audio' : null
  const videoOnly = lockedMode === 'video'
  const imageOnly = lockedMode === 'image'
  const audioOnly = lockedMode === 'audio'
  const [mode, setMode] = useState<Mode>(lockedMode ?? 'image')
  const [prompt, setPrompt] = useState('')
  // Floating control panel — only one open at a time: model | references | director | advanced
  const [panel, setPanel] = useState<null | 'model' | 'aspect' | 'quality' | 'style' | 'references' | 'director' | 'advanced' | 'vidquality' | 'vidmode' | 'vidframes' | 'vidduration' | 'audduration' | 'imgspeed' | 'imgquality' | 'imgresolution' | 'providerstyle' | 'acelyrics' | 'audgenre' | 'audmood'>(null)
  const [refTab, setRefTab] = useState<'uploads' | 'library' | 'generations'>('uploads')
  const [focused, setFocused] = useState(false)

  // Per-mode selectable models (getModelsByType already excludes comingSoon entries).
  const imageModels = useMemo(() => getModelsByType('image'), [])
  const videoModels = useMemo(() => getModelsByType('video'), [])
  const audioModels = useMemo(() => getModelsByType('audio'), [])

  const [imgModel, setImgModel] = useState(imageModels[0]?.id ?? '')
  const [vidModel, setVidModel] = useState(videoModels[0]?.id ?? '')
  const [audModel, setAudModel] = useState(audioModels[0]?.id ?? '')

  // Deep-link entry (mount-only): /playground?mode=image|video|audio and /playground?model=<catalog-id>.
  // Reads window.location.search directly (NOT useSearchParams) so the page stays statically prerenderable
  // with no Suspense restructuring. A model param implies its mode (looked up in the per-mode catalog lists,
  // which already exclude comingSoon) — unknown/hidden ids are ignored safely and defaults stay.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const modeParam = params.get('mode')
    const modelParam = params.get('model')
    if (videoOnly) {
      if (modelParam && videoModels.some((m) => m.id === modelParam)) setVidModel(modelParam)
      return
    }
    if (imageOnly) {
      if (modelParam && imageModels.some((m) => m.id === modelParam)) setImgModel(modelParam)
      return
    }
    if (audioOnly) {
      if (modelParam && audioModels.some((m) => m.id === modelParam)) setAudModel(modelParam)
      return
    }
    if (modeParam === 'image' || modeParam === 'video' || modeParam === 'audio') {
      setMode(modeParam)
    }
    if (modelParam) {
      if (imageModels.some((m) => m.id === modelParam)) {
        setMode('image'); setImgModel(modelParam)
      } else if (videoModels.some((m) => m.id === modelParam)) {
        setMode('video'); setVidModel(modelParam)
      } else if (audioModels.some((m) => m.id === modelParam)) {
        setMode('audio'); setAudModel(modelParam)
      }
    }
  }, [imageModels, videoModels, audioModels, videoOnly, imageOnly, audioOnly]) // stable useMemo([]) lists → runs once on mount

  const [imgAspect, setImgAspect] = useState('1:1')
  const [numImages, setNumImages] = useState(1) // bulk TOTAL (1/4/8/16); split into sub-jobs by the model's per-request maxImages
  const [bulk, setBulk] = useState<BulkState | null>(null)
  const [vidAspect, setVidAspect] = useState('16:9')
  const [vidDuration, setVidDuration] = useState(5)
  // ── Video capability-control FOUNDATION (v1.2). State is ready for live recalculation + future wiring;
  // controls render only when the selected model's capability descriptor supports them (see vidControls). ──
  const [vidMode, setVidMode] = useState<VideoWorkflowMode>('text-to-video')
  const [vidQuality, setVidQuality] = useState('')            // selected in-box resolution (from qualityOptions)
  const [audDuration, setAudDuration] = useState<number>(30) // audio length → CREDITS.audio tier (Stability Audio is one model; length is the in-box control)
  const audCfg = useMemo(() => getAudioModelById(audModel), [audModel])
  const audHasTiers = !!(audCfg?.tiers && audCfg.tiers.length > 0)
  // ACE-Step song controls (taskType 'song'): optional lyrics + instrumental toggle. The audio route already accepts
  // body.lyrics → ACE-Step lyrics; instrumental uses ACE-Step's "[inst]" lyrics signal + an "instrumental" style tag
  // (both route-compatible — no invented payload fields). Gated on the model id so other audio models are unaffected.
  const isAceStep = audCfg?.id === 'ace_step'
  const [aceLyrics, setAceLyrics] = useState('')
  const [aceInstrumental, setAceInstrumental] = useState(false)
  // Audio Genre/Mood — standard chip selectors (music models only; hidden for TTS). 'Auto' = no enrichment. Persist
  // across music-model switches. Wired into the generated prompt client-side (no provider field invented; no pricing impact).
  const [audGenre, setAudGenre] = useState('Auto')
  const [audMood, setAudMood] = useState('Auto')
  // Reset the length/duration tier to the selected model's first valid tier whenever the audio model changes.
  useEffect(() => {
    setAudDuration(audCfg?.tiers?.[0]?.seconds ?? audCfg?.fixedSeconds ?? 30)
    setAceLyrics('')            // clear ACE-Step song controls when the audio model changes (e.g. switching away from ACE-Step)
    setAceInstrumental(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audModel])
  const [vidAudioOn, setVidAudioOn] = useState(true)          // audio toggle state (used when audioToggle capable)
  const [vidStartFrame, setVidStartFrame] = useState<string | null>(null) // start-frame slot — holds a real PUBLIC url
  const [vidEndFrame, setVidEndFrame] = useState<string | null>(null)     // end-frame slot — holds a real PUBLIC url
  const [uploadingRef, setUploadingRef] = useState(false)                 // reference upload in flight
  const [debugResult, setDebugResult] = useState<Record<string, unknown> | null>(null) // DEV-ONLY: last Video "Preview Payload" response
  const [uploadLibrary, setUploadLibrary] = useState<Record<'image' | 'video', string[]>>({ image: [], video: [] }) // session Upload Library per mode: uploaded reference URLs (reusable)
  const [uploadingFrame, setUploadingFrame] = useState<'start' | 'end' | null>(null) // frame upload in flight
  const [frameUnsupported, setFrameUnsupported] = useState<'start' | 'end' | null>(null) // flashes "not supported" inside a frame slot

  // UI-only controls (visual; not yet sent to the backend).
  const [imgQuality, setImgQuality] = useState('HD')
  const [imgResolution, setImgResolution] = useState('2K') // resolution tier (e.g. Nano Banana Pro 2K/4K) — model-driven
  const [imgGptQuality, setImgGptQuality] = useState('medium') // GPT Image 2 quality tier (low/medium/high → Fast/Standard/Ultra) — model-driven
  const [imgSpeed, setImgSpeed] = useState('BALANCED') // rendering-speed tier (e.g. Ideogram V3 Turbo/Balanced/Quality) — model-driven
  const [imgStyle, setImgStyle] = useState('Default')
  const [imgProviderStyle, setImgProviderStyle] = useState('') // provider-level style enum (Ideogram/Recraft only); '' = none/unsupported
  const [camera, setCamera] = useState('Push In')
  const [shotTypes, setShotTypes] = useState<string[]>(['Establishing'])
  const [motionGuide, setMotionGuide] = useState('Slow motion reveal')
  const [speedRamp, setSpeedRamp] = useState('Linear')
  const [cineDirection, setCineDirection] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')

  // ── Workspace layer: notes + dragged history assets (freeform, overlap, z-index) ──
  const wsRef = useRef<HTMLDivElement>(null)
  const zRef = useRef(10)
  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null)
  const wsAudioRef = useRef<HTMLAudioElement | null>(null)
  const [wsItems, setWsItems] = useState<WsItem[]>([])
  const [wsPlaying, setWsPlaying] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null) // note being dragged → swap drop-shadow filter for a cheap shadow (kills the repaint trail)
  const [wsBroken, setWsBroken] = useState<Set<string>>(new Set()) // workspace assets whose history URL is gone → show a graceful placeholder
  const bringWsFront = (id: string) => setWsItems((items) => items.map((it) => (it.id === id ? { ...it, z: ++zRef.current } : it)))
  const addNote = () => setWsItems((items) => {
    const n = items.filter((i) => i.kind === 'note').length
    return [...items, { id: 'note_' + Date.now(), kind: 'note', x: 56, y: 356 + (n % 5) * 16, z: ++zRef.current, text: '' }]
  })
  const updateNote = (id: string, text: string) => setWsItems((items) => items.map((it) => (it.id === id && it.kind === 'note' ? { ...it, text } : it)))
  const removeWsItem = (id: string) => setWsItems((items) => items.filter((it) => it.id !== id))
  const wsClamp = (x: number, y: number) => {
    const r = wsRef.current?.getBoundingClientRect()
    if (!r) return { x: Math.max(0, x), y: Math.max(0, y) }
    return { x: Math.max(0, Math.min(x, r.width - 48)), y: Math.max(0, Math.min(y, r.height - 28)) }
  }
  const wsPointerDown = (e: React.PointerEvent, id: string) => {
    bringWsFront(id) // click = bring to front (skill rule)
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return // typing in a note / buttons must not start a drag
    const it = wsItems.find((i) => i.id === id)
    const r = wsRef.current?.getBoundingClientRect()
    if (!it || !r) return
    e.preventDefault()
    dragRef.current = { id, offX: e.clientX - r.left - it.x, offY: e.clientY - r.top - it.y }
    setDraggingId(id)
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const wsDragMove = (e: React.PointerEvent, id: string) => {
    const d = dragRef.current
    if (!d || d.id !== id) return
    const r = wsRef.current?.getBoundingClientRect()
    if (!r) return
    const { x, y } = wsClamp(e.clientX - r.left - d.offX, e.clientY - r.top - d.offY)
    setWsItems((items) => items.map((it) => (it.id === id ? { ...it, x, y } : it)))
  }
  const wsDragEnd = (e: React.PointerEvent, id: string) => {
    if (dragRef.current?.id === id) dragRef.current = null
    setDraggingId((cur) => (cur === id ? null : cur))
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const toggleWsAudio = (id: string, url: string) => {
    const cur = wsAudioRef.current
    if (wsPlaying === id && cur) { cur.pause(); setWsPlaying(null); return }
    if (cur) cur.pause()
    const a = new Audio(url)
    wsAudioRef.current = a
    a.onended = () => setWsPlaying(null)
    void a.play().catch(() => {})
    setWsPlaying(id)
  }
  const onWsDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('application/qelarix-asset')) return
    e.preventDefault()
    if (!dropping) setDropping(true)
  }
  const onWsDrop = (e: React.DragEvent) => {
    setDropping(false)
    const raw = e.dataTransfer.getData('application/qelarix-asset')
    if (!raw) return
    e.preventDefault()
    let a: { type?: string; url?: string; prompt?: string }
    try { a = JSON.parse(raw) } catch { return }
    if (!a.url || (a.type !== 'image' && a.type !== 'video' && a.type !== 'audio')) return
    const r = wsRef.current?.getBoundingClientRect()
    if (!r) return
    const { x, y } = wsClamp(e.clientX - r.left - 84, e.clientY - r.top - 60)
    setWsItems((items) => [...items, { id: 'asset_' + Date.now(), kind: 'asset', x, y, z: ++zRef.current, assetType: a.type as 'image' | 'video' | 'audio', url: a.url!, prompt: a.prompt ?? '' }])
  }
  useEffect(() => {
    const clear = () => setDropping(false)
    window.addEventListener('dragend', clear)
    return () => window.removeEventListener('dragend', clear)
  }, [])
  // ── Persistence (local/browser only) ──
  const [wsHydrated, setWsHydrated] = useState(false)
  // Hydrate the workspace from localStorage once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WS_STORAGE_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(isValidWsItem)
          if (valid.length) {
            setWsItems(valid)
            zRef.current = Math.max(10, ...valid.map((i) => i.z)) + 1
          }
        }
      }
    } catch { /* ignore corrupt storage */ }
    setWsHydrated(true)
  }, [])
  // Persist on change (debounced) AFTER hydration, so the initial empty state never overwrites stored data.
  useEffect(() => {
    if (!wsHydrated) return
    const t = setTimeout(() => {
      try { localStorage.setItem(WS_STORAGE_KEY, JSON.stringify(wsItems)) } catch { /* quota/ignore */ }
    }, 250)
    return () => clearTimeout(t)
  }, [wsItems, wsHydrated])
  const [refs, setRefs] = useState<Record<'image' | 'video', string[]>>({ image: [], video: [] })
  // Persist selected references locally (SSR-safe: default empty on first render, hydrate in an effect → no mismatch).
  const [refsHydrated, setRefsHydrated] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('qelarix.playground.refs.v1')
      if (raw) {
        const parsed = JSON.parse(raw) as { image?: unknown; video?: unknown }
        const img = Array.isArray(parsed?.image) ? parsed.image.filter((u): u is string => typeof u === 'string') : []
        const vid = Array.isArray(parsed?.video) ? parsed.video.filter((u): u is string => typeof u === 'string') : []
        if (img.length || vid.length) setRefs({ image: img, video: vid })
      }
    } catch { /* localStorage unavailable / corrupt — keep defaults */ }
    setRefsHydrated(true)
  }, [])
  useEffect(() => {
    if (!refsHydrated) return
    try { localStorage.setItem('qelarix.playground.refs.v1', JSON.stringify(refs)) } catch { /* ignore */ }
  }, [refs, refsHydrated])
  // ── Video reference ROLE TAGS — DEPRECATED (v1.2): the reference Role dropdown was removed, so roles can no longer be
  // set. The map stays empty, so no role suffix is ever folded into the prompt or the @image mention note. Kept only so
  // dropVideoRefTag and the prompt/mention reads stay valid (always empty). refs.video + @image mentions are unaffected.
  const [videoRefTags, setVideoRefTags] = useState<Record<string, 'character' | 'style' | 'object' | 'background'>>({})
  useEffect(() => {
    // One-time cleanup: purge any stale role-tag metadata a previous version persisted, so old role suffixes can never
    // resurface. We no longer load or persist this map (no UI to set it).
    try { localStorage.removeItem('qelarix.playground.video.refTags.v1') } catch { /* localStorage unavailable */ }
  }, [])
  // Video @imageN mention AUTOCOMPLETE (Phase 1, video only) — Cinema-style picker: open on "@", insert @imageN at
  // the caret. Plain-text only — it just edits the prompt string (no rich text / contenteditable / payload change).
  const promptTaRef = useRef<HTMLTextAreaElement | null>(null)
  const promptMirrorRef = useRef<HTMLDivElement | null>(null)
  const promptAreaRef = useRef<HTMLDivElement>(null)
  const floatWrapRef = useRef<HTMLDivElement>(null)
  const rightPanelRef = useRef<HTMLDivElement>(null)
  const histHeaderRef = useRef<HTMLDivElement>(null) // History header now lives in the topbar — keep it "inside" for outside-click close
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionStart, setMentionStart] = useState(-1)
  const [mentionHighlight, setMentionHighlight] = useState(0)
  // Persist the in-progress prompt DRAFT + Advanced fields locally (SSR-safe: default empty on first render, hydrate
  // in an effect → no mismatch; the save effect is gated on draftHydrated so empty initial state never overwrites
  // stored values). Results / history / uploaded library / generated images are intentionally NOT persisted here.
  const [draftHydrated, setDraftHydrated] = useState(false)
  useEffect(() => {
    try {
      const p = localStorage.getItem('qelarix.playground.prompt.v1')
      if (typeof p === 'string' && p) setPrompt(p)
      const raw = localStorage.getItem('qelarix.playground.advancedPrompt.v1')
      if (raw) {
        const parsed = JSON.parse(raw) as { cineDirection?: unknown; negativePrompt?: unknown }
        if (typeof parsed?.cineDirection === 'string') setCineDirection(parsed.cineDirection)
        if (typeof parsed?.negativePrompt === 'string') setNegativePrompt(parsed.negativePrompt)
      }
    } catch { /* localStorage unavailable / corrupt — keep defaults */ }
    setDraftHydrated(true)
  }, [])
  useEffect(() => {
    if (!draftHydrated) return
    try {
      localStorage.setItem('qelarix.playground.prompt.v1', prompt)
      localStorage.setItem('qelarix.playground.advancedPrompt.v1', JSON.stringify({ cineDirection, negativePrompt }))
    } catch { /* ignore */ }
  }, [prompt, cineDirection, negativePrompt, draftHydrated])
  const [dragOver, setDragOver] = useState(false)

  const [gen, setGen] = useState<GenItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Preview dismiss: hides a result from the canvas preview WITHOUT mutating gen data or History (close X). Non-destructive.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<HistItem[]>([])
  const [histFilter, setHistFilter] = useState<HistFilter>(lockedMode ?? 'all')
  const [histOpen, setHistOpen] = useState(false)
  const [previewItem, setPreviewItem] = useState<HistItem | null>(null)
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([])

  const fileRef = useRef<HTMLInputElement | null>(null)
  const startFrameRef = useRef<HTMLInputElement | null>(null)
  const endFrameRef = useRef<HTMLInputElement | null>(null)

  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.floor(performance.now())
    setToasts((t) => [...t, { id, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2700)
  }, [])

  // ── History ────────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/generations?limit=60')
      if (!res.ok) return
      const data = await res.json()
      if (!Array.isArray(data.generations)) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: HistItem[] = data.generations.map((g: any) => ({
        id: String(g.id),
        type: (g.type as Mode) ?? 'image',
        prompt: g.prompt ?? '',
        model: g.model ?? '',
        url: (() => { try { const p = JSON.parse(g.url || g.output_url || ''); return Array.isArray(p) ? p[0] : (g.url || g.output_url) } catch { return g.url || g.output_url } })(),
        // Parse ALL output URLs (output_url is a JSON array); fall back to the single url. Image multi-output surfacing.
        urls: (() => {
          try { const p = JSON.parse(g.output_url || ''); if (Array.isArray(p)) { const a = p.filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u)); if (a.length) return a } } catch { /* not a JSON array */ }
          const single = g.url || g.output_url
          return typeof single === 'string' && /^https?:\/\//.test(single) ? [single] : []
        })(),
        createdAt: g.created_at ? new Date(g.created_at).getTime() : Date.now(),
        source: g.source === 'cinema_studio' ? 'cinema_studio' : 'playground',
        stillUrl: typeof g.still_url === 'string' ? g.still_url : undefined,
      }))
      setHistory(items)
    } catch { /* ignore — history is best-effort */ }
  }, [])

  useEffect(() => { void loadHistory() }, [loadHistory])

  // ── Bulk Generation v1 (client-side fan-out) ─────────────────────────────────
  // Build the EXACT image request body for a given per-request count — shared by the single path AND bulk sub-jobs,
  // so a sub-job is byte-identical to a normal generation (same model/prompt/refs/tier/aspect).
  const buildImageBody = useCallback((slug: string, cfg: ReturnType<typeof getImageModelById>, perJobNum: number): Record<string, unknown> => {
    const base = prompt.trim()
    const imgMods = [imgStyle !== 'Default' ? STYLE_MODIFIERS[imgStyle] : '', cineDirection.trim()].map((m) => (m || '').trim()).filter(Boolean)
    const styled = imgMods.length ? `${base}, ${imgMods.join(', ')}` : base
    const body: Record<string, unknown> = { model: slug, prompt: styled, aspectRatio: imgAspect, numImages: perJobNum }
    if (cfg?.supportsQuality) body.quality = imgQuality === 'HD' ? 'hd' : 'standard'
    if (cfg?.negativePromptSupport === 'native' && negativePrompt.trim()) body.negativePrompt = negativePrompt.trim()
    if (cfg?.supportsReference) {
      const refUrls = refs.image.filter((u) => /^https?:\/\//.test(u)).slice(0, cfg.reference?.maxRefs ?? cfg.maxReferences ?? 1)
      if (refUrls.length) body.referenceImageUrls = refUrls
    }
    if (cfg?.resolutionTiers) body.resolution = imgResolution
    if (cfg?.speedTiers) body.renderingSpeed = imgSpeed
    if (cfg?.qualityTiers) body.quality = imgGptQuality
    if (cfg?.styleOptions && imgProviderStyle) body.providerStyle = imgProviderStyle // provider style enum (Ideogram/Recraft) — route validates per-model
    return body
  }, [prompt, imgStyle, cineDirection, imgAspect, imgQuality, negativePrompt, refs, imgResolution, imgSpeed, imgGptQuality, imgProviderStyle])

  // One sub-job = existing POST + existing status polling, resolved to its output URLs (or [] on any failure/timeout).
  const runOneImageJob = useCallback(async (body: Record<string, unknown>): Promise<string[]> => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    try {
      const res = await fetch('/api/generate/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) return []
      const direct = data.url || data.imageUrl || data.image_url
      if (typeof direct === 'string' && /^https?:\/\//.test(direct)) return [direct]
      const jobId = data.jobId || data.job_id
      if (!jobId) return []
      for (let attempts = 0; attempts < 120; attempts++) {
        await sleep(3000)
        try {
          const sr = await fetch(`/api/generate/image/status/${jobId}`)
          const sd = await sr.json()
          const urls = Array.isArray(sd.output_urls) ? (sd.output_urls as unknown[]).filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : []
          if (urls.length) return urls
          const single = sd.output_url || sd.url || sd.imageUrl || sd.image_url
          if (typeof single === 'string' && /^https?:\/\//.test(single)) return [single]
          if (sd.status === 'failed' || sd.status === 'error' || sd.error) return []
        } catch { /* transient — keep polling */ }
      }
      return []
    } catch { return [] }
  }, [])

  // Concurrency-capped pool (max 3 in flight). Updates bulk state by job idx; accumulates output URLs as jobs finish.
  const runImageJobs = useCallback(async (jobsToRun: BulkJob[]) => {
    const CONCURRENCY = 3
    let cursor = 0
    const worker = async () => {
      while (cursor < jobsToRun.length) {
        const job = jobsToRun[cursor++]
        setBulk((b) => b ? { ...b, jobs: b.jobs.map((j) => j.idx === job.idx ? { ...j, status: 'running' } : j) } : b)
        let urls: string[] = []
        try { urls = await runOneImageJob(job.body) } catch { urls = [] }
        setBulk((b) => b ? { ...b, urls: urls.length ? [...b.urls, ...urls] : b.urls, jobs: b.jobs.map((j) => j.idx === job.idx ? { ...j, status: urls.length ? 'done' : 'failed' } : j) } : b)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobsToRun.length) }, () => worker()))
  }, [runOneImageJob])

  // Re-dispatch ONLY the failed sub-jobs (same body → same batch). Successful jobs are never re-run / re-charged.
  const retryBulk = useCallback(async () => {
    if (!bulk || bulk.active) return
    const failed = bulk.jobs.filter((j) => j.status === 'failed')
    if (!failed.length) return
    setBusy(true)
    setBulk((b) => b ? { ...b, active: true, jobs: b.jobs.map((j) => j.status === 'failed' ? { ...j, status: 'pending' } : j) } : b)
    await runImageJobs(failed)
    setBulk((b) => b ? { ...b, active: false } : b)
    setBusy(false)
    toast('Retry complete'); void loadHistory()
  }, [bulk, runImageJobs, loadHistory, toast])

  // ── Generate (reuses the existing endpoints + polling contract) ──────────────
  const handleGenerate = useCallback(async (debugPayload = false) => {
    const p = prompt.trim()
    if (!p) { toast('Enter a prompt first'); return }
    if (busy) return

    const model: QelarixModel | undefined =
      mode === 'image' ? imageModels.find((m) => m.id === imgModel)
      : mode === 'video' ? videoModels.find((m) => m.id === vidModel)
      : audioModels.find((m) => m.id === audModel)
    if (!model) { toast('Select a model first'); return }

    // Audio TTS char-limit guard: never dispatch (and never charge) text longer than the model's hard cap. The live
    // counter + disabled Generate button already prevent this; this is the final pre-dispatch stop (defence in depth).
    if (mode === 'audio') {
      const mc = getAudioModelById(audModel)?.maxChars
      if (mc != null && p.length > mc) { toast(`Text is over the ${mc} character limit.`); return }
    }

    // The EFFECTIVE video workflow is derived HERE from the CURRENT inputs (selected frames/refs + model capability),
    // NOT from the async `vidMode` UI state — which can lag behind a frame clear / model switch (and, when left stale
    // on 'first-last-frame' after an FLF generation, would mis-route a NO-frames Veo 3.1 run to the frame-required FLF
    // variant). Deriving it here makes dispatch deterministic: no frames → text-to-video ALWAYS; FLF only when BOTH
    // frames are set; image-to-video only when a start/ref is present; Fast (no FLF mode) can never resolve to FLF.
    let vidEffMode: VideoWorkflowMode = vidMode
    if (mode === 'video') {
      const vslug = VIDEO_MODEL_IDS[model.id] || model.id
      const pc = getVideoControls(vslug)
      const isHttps = (u?: string | null) => !!(u && /^https?:\/\//.test(u))
      const sSet = isHttps(vidStartFrame), eSet = isHttps(vidEndFrame)
      vidEffMode =
        (pc?.modes?.includes('image-to-video') && (sSet || isHttps(refs.video[0]))) ? 'image-to-video'
        : (pc?.modes?.includes('first-last-frame') && sSet && eSet) ? 'first-last-frame'
        : 'text-to-video'
      const eff = resolveVideoModeSlug(resolveVideoVariantSlug(vslug, (pc && pc.qualityOptions.length > 1) ? vidQuality : undefined), vidEffMode)
      const ec = getVideoControls(eff)
      // Block ONLY when the effective workflow truly needs a frame that isn't there:
      //  • image-to-video (Seedance/Luma): start present by activation; end is NEVER required → no block.
      //  • start/end-frame model with no i2v/flf variant (Kling V2.6): frames OPTIONAL but all-or-nothing.
      if (vidEffMode === 'text-to-video' && ec?.startFrame && ec?.endFrame && sSet !== eSet) {
        toast(sSet ? 'Add an End Frame, or remove the Start Frame to generate text-to-video' : 'Add a Start Frame for the start/end-frame workflow'); setPanel('references'); return
      }
      //  • first-last-frame (Veo 3.1): needs BOTH frames; a single one would be ignored → require both (or neither).
      if (vidEffMode !== 'first-last-frame' && pc?.modes?.includes('first-last-frame') && sSet !== eSet) {
        toast('First / Last Frame needs BOTH a Start and an End Frame'); setPanel('references'); return
      }
      //  • reference-to-video (Kling O1): at least ONE reference image is required → block early with a clear message.
      if (ec?.imageReference && (ec.maxImageReferences ?? 0) > 0 && !refs.video.some((u) => isHttps(u))) {
        toast('Kling O1 needs at least one reference image — add one in References'); setPanel('references'); return
      }
    }

    // ── Bulk fan-out: when the requested TOTAL exceeds the model's per-request maxImages, split into sub-jobs
    // and run them client-side (concurrency 3). Each sub-job is a normal generation row charged per-success. ──
    if (mode === 'image') {
      const slug = IMAGE_MODEL_IDS[model.id] || model.id
      const cfg = getImageModelById(slug)
      const maxImg = cfg?.maxImages ?? 1
      if (numImages > maxImg) {
        const perImg = cfg ? (cfg.speedTiers ? getImageSpeedCredits(cfg, imgSpeed) : cfg.resolutionTiers ? getImageResolutionCredits(cfg, imgResolution) : cfg.qualityTiers ? getImageQualityCredits(cfg, imgGptQuality) : getImageTierCredits(cfg, imgQuality === 'HD' ? 'hd' : 'standard')) : 0
        const totalCost = perImg * numImages
        // Advisory precheck against the frontend credit balance (route still does the authoritative per-sub-job check).
        if (typeof credits === 'number' && credits > 0 && credits < totalCost) { toast(`This batch needs ~${totalCost} QLC — you have ${credits}.`); return }
        const batchId = 'batch_' + Date.now()
        const sizes: number[] = []
        let rem = numImages
        while (rem > 0) { const n = Math.min(rem, maxImg); sizes.push(n); rem -= n }
        const jobs: BulkJob[] = sizes.map((n, idx) => ({ idx, n, status: 'pending', body: { ...buildImageBody(slug, cfg, n), batchId } }))
        setBulk({ batchId, total: numImages, modelName: model.name, prompt: p, jobs, urls: [], active: true })
        setActiveId(null)
        setBusy(true)
        await runImageJobs(jobs)
        setBulk((b) => b ? { ...b, active: false } : b)
        setBusy(false)
        toast('Batch complete'); void loadHistory()
        return
      }
    }
    setBulk(null) // a normal (non-bulk) generation clears any previous batch panel

    const placeholderId = 'gen_' + Date.now()
    if (!debugPayload) {
      setGen((g) => [{ id: placeholderId, type: mode, status: 'generating', prompt: p, model: model.name }, ...g])
      setBusy(true)
    }

    const finish = (patch: Partial<GenItem>) =>
      setGen((g) => g.map((it) => (it.id === placeholderId ? { ...it, ...patch } : it)))

    try {
      const endpoint = mode === 'image' ? '/api/generate/image' : mode === 'audio' ? '/api/generate/audio' : '/api/generate/video'
      const statusBase = mode === 'image' ? '/api/generate/image/status' : mode === 'video' ? '/api/generate/video/status' : (getAudioModelById(audModel)?.async ? '/api/generate/audio/status' : null)

      let body: Record<string, unknown>
      if (mode === 'video') {
        // Prompt-only: model-truthful duration (clamped to a supported value) + audio driven by real capability (not always true).
        const vslug = VIDEO_MODEL_IDS[model.id] || model.id
        // In-box controls drive the payload: quality → variant slug, then MODE → mode-variant slug (e.g. First/Last
        // Frame → veo31_flf with its own endpoint/durations/price). Audio → vidAudioOn for toggle models, else fixed.
        const pctrls = getVideoControls(vslug)
        const effVslug = resolveVideoModeSlug(
          resolveVideoVariantSlug(vslug, (pctrls && pctrls.qualityOptions.length > 1) ? vidQuality : undefined),
          vidEffMode,
        )
        const vctrls = getVideoControls(effVslug)
        const effAudio = vctrls?.audioToggle ? vidAudioOn : (getVideoCapability(effVslug)?.hasAudio ?? false)
        // Truthfully fold the visible Director choices + Cinematic Direction into the prompt as short
        // modifiers (client-side only — mirrors image Style). Neutral values add nothing; empty text skipped.
        const directorMods = [
          CAMERA_MODIFIERS[camera] ?? '',
          ...shotTypes.map((stp) => SHOT_TYPE_MODIFIERS[stp] ?? ''),
          MOTION_MODIFIERS[motionGuide] ?? '',
          SPEED_RAMP_MODIFIERS[speedRamp] ?? '',
          cineDirection.trim(),
        ].map((m) => m.trim()).filter(Boolean)
        // Phase 1 (UI metadata → prompt only): fold SELECTED video refs' role-tag guidance into the prompt as
        // short hints (deduped by role). NOT a payload — the provider receives no role metadata, only this text.
        const refGuidance = Array.from(new Set(
          refs.video.map((u) => videoRefTags[u]).filter((r): r is 'character' | 'style' | 'object' | 'background' => !!r)
        )).map((r) => VIDEO_REF_TAG_GUIDANCE[r])
        const allVidMods = [...directorMods, ...refGuidance]
        const vidBase = allVidMods.length ? `${p}, ${allVidMods.join(', ')}` : p
        // Phase 1 — @imageN mentions → short reference note (prompt TEXT only; never a payload). Parse the user's
        // prompt for @imageN tokens that map to a SELECTED video ref by 1-based order; out-of-range mentions are
        // ignored. Include the role tag when set. The provider gets no structured mention/role data — only this text.
        const mentionedNs = Array.from(new Set(
          Array.from(p.matchAll(/@image(\d+)/gi), (m) => parseInt(m[1], 10))
        )).filter((n) => n >= 1 && n <= refs.video.length).sort((a, b) => a - b)
        const vidRefNote = mentionedNs.length
          ? '\n\nReference note:\n' + mentionedNs.map((n) => {
              const role = videoRefTags[refs.video[n - 1]]
              return `- @image${n} refers to the ${videoMentionOrdinal(n)} selected reference image${role ? `, tagged as ${VIDEO_REF_TAG_LABELS[role]}` : ''}.`
            }).join('\n')
          : ''
        const vidPrompt = `${vidBase}${vidRefNote}`
        body = { model: effVslug, prompt: vidPrompt, duration: clampVideoDuration(effVslug, vidDuration), aspect_ratio: vidAspect, with_audio: effAudio }
        // Visual-input pipeline (real PUBLIC urls from history/upload — never blob:). Capability-gated &
        // present-only: a reference/frame is attached ONLY when the selected model truthfully declares it
        // (imageReference / startFrame / endFrame), so every current text-to-video model is unaffected.
        // referenceImageUrl / startFrameUrl / endFrameUrl is the prepared shape; the route maps each to the
        // matching provider field (image_url / first_frame_url / last_frame_url) per endpoint.
        const httpsOnly = (u?: string | null) => (u && /^https?:\/\//.test(u) ? u : undefined)
        if (vctrls?.imageReference) {
          // Reference-to-video (Kling O1): send ALL selected refs as a structured array (route → image_urls[]).
          // Single-ref models (none today) keep the legacy single referenceImageUrl. Cap at the model's maxImageReferences.
          const maxR = Math.max(1, vctrls.maxImageReferences || 1)
          const refUrls = refs.video.map(httpsOnly).filter((u): u is string => !!u).slice(0, maxR)
          if (maxR > 1) { if (refUrls.length) body.referenceImageUrls = refUrls }
          else if (refUrls[0]) body.referenceImageUrl = refUrls[0]
        }
        // Start frame: a manual Start Frame wins; for AUTO image-to-video the first selected Reference becomes the start
        // image. The refs.video fallback applies ONLY in image-to-video — never for Kling V2.6 / Veo FLF (explicit frames).
        if (vctrls?.startFrame) { const u = httpsOnly(vidStartFrame) || (vidEffMode === 'image-to-video' ? httpsOnly(refs.video[0]) : undefined); if (u) body.startFrameUrl = u }
        if (vctrls?.endFrame) { const u = httpsOnly(vidEndFrame); if (u) body.endFrameUrl = u }
      } else if (mode === 'image') {
        const slug = IMAGE_MODEL_IDS[model.id] || model.id
        const cfg = getImageModelById(slug)
        const clampedNum = Math.min(numImages, cfg?.maxImages ?? 1) // single-request path (bulk fan-out handled above)
        body = buildImageBody(slug, cfg, clampedNum)
      } else {
        // Audio dispatch is model-driven (unified audio-models registry). Send the selected model id;
        // duration only for models with a truthful length/duration control (Stability length, ACE-Step).
        const audConf = getAudioModelById(audModel)
        // Genre/Mood enrichment → prepend to the prompt for PROMPT-BASED music models only. NEVER for TTS (taskType
        // 'tts'), which would otherwise speak "Genre: …". No provider field invented — it is plain prompt text.
        let audioPrompt = p
        if (audConf?.taskType !== 'tts') {
          const gm: string[] = []
          if (audGenre !== 'Auto') gm.push(`Genre: ${audGenre}.`)
          if (audMood !== 'Auto') gm.push(`Mood: ${audMood}.`)
          if (gm.length) audioPrompt = `${gm.join(' ')} ${p}`
        }
        body = { model: audModel, prompt: audioPrompt }
        if (audConf?.tiers && audConf.tiers.length > 0) body.duration = audDuration
        // ACE-Step song controls → route-compatible fields ONLY (the audio route maps body.prompt→tags, body.lyrics→lyrics):
        //  • instrumental ON  → lyrics "[inst]" (ACE-Step's instrumental signal) + an "instrumental" style tag
        //  • instrumental OFF → forward the optional user lyrics verbatim (empty = style/tags-only, unchanged behaviour)
        if (audConf?.id === 'ace_step') {
          if (aceInstrumental) {
            body.lyrics = '[inst]'
            body.prompt = `${audioPrompt}, instrumental`
          } else if (aceLyrics.trim()) {
            body.lyrics = aceLyrics.trim()
          }
        }
        // ElevenLabs Music (async): send the vocal/instrumental flag → the route maps it to force_instrumental.
        if (audConf?.id === 'elevenlabs_music') {
          body.instrumental = aceInstrumental
        }
      }

      // DEV-ONLY Preview Payload: POST the SAME body with debugPayloadOnly → the route returns the resolved endpoint +
      // provider input WITHOUT calling fal, inserting a row, or deducting credits. Show it in the debug modal; the
      // gallery/poll are never touched (we returned before the placeholder was created).
      if (debugPayload) {
        try {
          const dRes = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, debugPayloadOnly: true }) })
          const dData = await dRes.json()
          setDebugResult(dData as Record<string, unknown>)
          if (!dRes.ok) toast(`Preview failed${dData?.error ? `: ${String(dData.error).slice(0, 50)}` : ''}`)
        } catch { toast('Preview failed') }
        return
      }
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      // charge_above_limit is shown by the global centered popup (QlcFundsPrompt), so no toast for it here.
      if (!res.ok) { finish({ status: 'failed' }); setBusy(false); if (data?.code !== 'charge_above_limit') toast(data?.error ? `Failed: ${String(data.error).slice(0, 60)}` : 'Generation failed'); return }

      const directUrl = data.url || data.audioUrl || data.audio_url || data.videoUrl || data.video_url || data.imageUrl || data.image_url
      if (directUrl) { finish({ url: directUrl, urls: [directUrl], status: 'completed' }); setActiveId(placeholderId); setBusy(false); toast('Generation complete'); void loadHistory(); return }

      const jobId = data.jobId || data.job_id
      if (!jobId || !statusBase) { finish({ status: 'failed' }); setBusy(false); toast('Generation failed'); return }

      // Long video jobs (e.g. 10 s with audio) can render well past 6 minutes, so video waits up to an hour and
      // polls less often after the first 10 minutes. Giving up never reports a failure for a job that is still
      // rendering: the user was charged and the result still arrives in the history.
      const pollStarted = Date.now()
      const maxWaitMs = mode === 'video' ? 60 * 60_000 : 6 * 60_000
      const nextDelay = () => (Date.now() - pollStarted > 10 * 60_000 ? 10_000 : 3000)
      const poll = async () => {
        if (Date.now() - pollStarted >= maxWaitMs) {
          if (mode === 'video') {
            setGen((g) => g.filter((it) => it.id !== placeholderId))
            setBusy(false)
            toast('Still rendering. It will appear in your history when ready.')
          } else {
            finish({ status: 'failed' }); setBusy(false)
          }
          return
        }
        try {
          const sr = await fetch(`${statusBase}/${jobId}`)
          // A server error while checking (e.g. a slow result download) says nothing about the job itself: retry.
          if (sr.status >= 500) { setTimeout(poll, nextDelay()); return }
          const sd = await sr.json()
          const outUrls = Array.isArray(sd.output_urls) ? (sd.output_urls as unknown[]).filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : []
          const url = outUrls[0] || sd.output_url || sd.url || sd.videoUrl || sd.video_url || sd.imageUrl || sd.image_url || sd.outputUrl || null
          if (url) { finish({ url, urls: outUrls.length ? outUrls : [url], status: 'completed' }); setActiveId(placeholderId); setBusy(false); toast('Generation complete'); void loadHistory(); return }
          if (sd.status === 'failed' || sd.status === 'error' || sd.error) { finish({ status: 'failed' }); setBusy(false); toast(typeof sd.message === 'string' && sd.message ? sd.message : 'Generation failed'); return }
          setTimeout(poll, nextDelay())
        } catch { setTimeout(poll, nextDelay()) }
      }
      setTimeout(poll, 3000)
    } catch {
      finish({ status: 'failed' }); setBusy(false); toast('Generation failed')
    }
  }, [prompt, busy, mode, imgModel, vidModel, audModel, imageModels, videoModels, audioModels, vidDuration, vidAspect, vidQuality, vidAudioOn, imgAspect, numImages, imgStyle, imgQuality, negativePrompt, camera, shotTypes, motionGuide, speedRamp, cineDirection, refs, videoRefTags, vidMode, vidStartFrame, vidEndFrame, toast, loadHistory, buildImageBody, runImageJobs, credits, imgSpeed, imgResolution, imgGptQuality, audDuration, aceLyrics, aceInstrumental, audGenre, audMood])

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void handleGenerate() }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); setPanel((cur) => (cur === 'advanced' ? null : 'advanced')) }
      else if (e.key === 'Escape') { setPreviewItem(null); setPanel(null); setHistOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleGenerate])

  // Close open panels/dropdowns when clicking outside their containers.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel) {
        const inPrompt = promptAreaRef.current?.contains(t)
        const inFloat = floatWrapRef.current?.contains(t)
        if (!inPrompt && !inFloat) setPanel(null)
      }
      if (histOpen && !rightPanelRef.current?.contains(t) && !histHeaderRef.current?.contains(t)) {
        setHistOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [panel, histOpen])

  // Keep image count + aspect truthful to the selected model's capabilities (clamp/reset on model switch).
  useEffect(() => {
    const cfg = getImageModelById(IMAGE_MODEL_IDS[imgModel] || imgModel)
    // numImages is the bulk TOTAL (1/4/8/16) — NOT clamped to per-request maxImages (fan-out splits it per model).
    const ars = (cfg?.aspectRatios ?? []) as string[]
    setImgAspect((cur) => (ars.length === 0 || ars.includes(cur)) ? cur : (ars.includes('1:1') ? '1:1' : ars[0]))
    setImgResolution(cfg?.defaultResolution ?? cfg?.resolutionTiers?.[0]?.id ?? '2K')
    setImgGptQuality(cfg?.defaultQuality ?? cfg?.qualityTiers?.[0]?.id ?? 'medium')
    setImgSpeed(cfg?.defaultSpeed ?? cfg?.speedTiers?.[0]?.id ?? 'BALANCED')
    setImgProviderStyle(cfg?.styleOptions?.[0]?.id ?? '') // provider style: default to first option (Ideogram AUTO / Recraft realistic_image), else none
  }, [imgModel])

  // Keep video duration + aspect truthful to the selected model (clamp on model switch).
  useEffect(() => {
    const slug = VIDEO_MODEL_IDS[vidModel] || vidModel
    const caps = getVideoCapability(slug)
    setVidDuration((d) => clampVideoDuration(slug, d))
    if (caps && caps.aspects.length) setVidAspect((a) => (caps.aspects.some((x) => x === a) ? a : caps.aspects[0]))
    // Reset the in-box capability controls to the model's defaults/support on model switch.
    const vc = getVideoControls(slug)
    setVidMode((vc?.modes?.[0] as VideoWorkflowMode) ?? 'text-to-video')
    setVidQuality(vc && vc.qualityOptions.length ? vc.qualityOptions[vc.qualityOptions.length - 1] : '') // default to highest
    setVidAudioOn(vc?.audioToggle ? true : !!vc?.audioIncluded)
    setVidStartFrame(null)
    setVidEndFrame(null)
    setFrameUnsupported(null)
  }, [vidModel])

  // Auto-select the effective video workflow (NO Mode chip) from the inputs:
  //  • image-to-video model + a usable image (manual Start Frame OR a selected Reference) → image-to-video.
  //  • first-last-frame model + BOTH start & end frames set → first-last-frame.
  //  • otherwise → text-to-video. Kling V2.6 (no variant) stays its own slug; its frames are optional + all-or-nothing.
  useEffect(() => {
    if (mode !== 'video') return
    const primarySlug = VIDEO_MODEL_IDS[vidModel] || vidModel
    const modes = getVideoControls(primarySlug)?.modes ?? []
    const ok = (u?: string | null) => !!(u && /^https?:\/\//.test(u))
    let next: VideoWorkflowMode = 'text-to-video'
    if (modes.includes('image-to-video') && (ok(vidStartFrame) || ok(refs.video[0]))) next = 'image-to-video'
    else if (modes.includes('first-last-frame') && ok(vidStartFrame) && ok(vidEndFrame)) next = 'first-last-frame'
    setVidMode((cur) => (cur === next ? cur : next))
  }, [mode, vidModel, vidStartFrame, vidEndFrame, refs])

  // The in-slot "not supported" note is a brief flash — clear it after a moment (and on any mode change).
  useEffect(() => {
    if (!frameUnsupported) return
    const t = setTimeout(() => setFrameUnsupported(null), 2600)
    return () => clearTimeout(t)
  }, [frameUnsupported])
  useEffect(() => { setFrameUnsupported(null) }, [vidMode])

  // Switching the in-box Mode (e.g. Veo 3.1 → First / Last Frame) changes the effective variant: re-clamp the
  // duration/aspect to that variant and reset audio to its truth. Frames are NOT cleared (kept for the FLF flow).
  useEffect(() => {
    if (mode !== 'video') return
    const primary = VIDEO_MODEL_IDS[vidModel] || vidModel
    const pc = getVideoControls(primary)
    const qSlug = resolveVideoVariantSlug(primary, (pc && pc.qualityOptions.length > 1) ? vidQuality : undefined)
    const eff = resolveVideoModeSlug(qSlug, vidMode)
    const caps = getVideoCapability(eff)
    setVidDuration((d) => clampVideoDuration(eff, d))
    if (caps && caps.aspects.length) setVidAspect((a) => (caps.aspects.some((x) => x === a) ? a : caps.aspects[0]))
    const ec = getVideoControls(eff)
    setVidAudioOn(ec?.audioToggle ? true : !!ec?.audioIncluded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vidMode])

  // Advanced is a stable fixed-height bottom drawer — no drag-resize (toggled only).

  const enhance = () => {
    const v = prompt.trim()
    if (!v) { toast('Write a prompt first'); return }
    setPrompt(v + ENHANCE[mode][Math.floor(Math.random() * ENHANCE[mode].length)])
  }

  // Resolve a real, provider-usable PUBLIC image URL via the existing upload route
  // (src/app/api/generate/video/upload → fal.storage.upload). Returns null on failure. NEVER a blob: URL.
  const uploadPublicImage = async (file: File): Promise<string | null> => {
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/generate/video/upload', { method: 'POST', body: fd })
      if (!res.ok) return null
      const data = await res.json()
      return typeof data?.url === 'string' && /^https?:\/\//.test(data.url) ? data.url : null
    } catch { return null }
  }

  // Reference upload → real public URLs (not blob). Selecting an existing generation already yields a public URL.
  const addRefs = async (files: FileList | null) => {
    if (!files || mode === 'audio') return
    // Image references accept only PNG/JPG/WebP (GPT Image 2 Edit rejects GIF); video keeps any image type.
    const allow = mode === 'image' ? ['image/png', 'image/jpeg', 'image/webp'] : null
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/') && (!allow || allow.includes(f.type)))
    if (!imgs.length) { if (mode === 'image') toast('Use PNG, JPG, or WebP for image references'); return }
    setUploadingRef(true)
    try {
      const results = await Promise.all(imgs.map((f) => uploadPublicImage(f)))
      const urls = results.filter((u): u is string => !!u)
      if (urls.length) {
        if (mode === 'image') {
          // Uploaded images go into the session Upload Library (reusable). Also auto-select up to the model's maxRefs.
          setUploadLibrary((lib) => ({ ...lib, image: [...lib.image, ...urls.filter((u) => !lib.image.includes(u))] }))
          const cfg = getImageModelById(IMAGE_MODEL_IDS[imgModel] || imgModel)
          const max = cfg?.reference?.maxRefs ?? cfg?.maxReferences ?? 1
          const existing = refs.image
          const toAdd: string[] = []
          for (const u of urls) {
            if (existing.includes(u) || toAdd.includes(u) || existing.length + toAdd.length >= max) continue
            toAdd.push(u)
          }
          if (toAdd.length) setRefs((r) => ({ ...r, image: [...r.image, ...toAdd].filter((v, i, a) => a.indexOf(v) === i).slice(0, max) }))
          setRefTab('library') // auto-navigate to the Upload Library so the user immediately sees the uploaded reference
          toast(`${urls.length} uploaded to library${toAdd.length ? ` · ${toAdd.length} selected` : ''}`)
        } else {
          // Video: uploaded images go into the session Upload Library (reusable) AND are selected as references.
          setUploadLibrary((lib) => ({ ...lib, video: [...lib.video, ...urls.filter((u) => !lib.video.includes(u))] }))
          setRefs((r) => ({ ...r, video: [...r.video, ...urls.filter((u) => !r.video.includes(u))] }))
          setRefTab('library') // auto-navigate to the Upload Library so the user immediately sees the uploaded reference
          toast(`${urls.length} uploaded to library`)
        }
      }
      const failed = results.length - urls.length
      if (failed) toast(`${failed} upload${failed > 1 ? 's' : ''} failed — try again`)
    } finally {
      setUploadingRef(false)
    }
  }
  // Drop a video reference's role tag (Phase 1) — keyed by URL; no-op for untagged urls. Image refs are never tagged.
  const dropVideoRefTag = (url: string) => setVideoRefTags((t) => { if (!(url in t)) return t; const next = { ...t }; delete next[url]; return next })
  const removeRef = (i: number) => {
    const removedUrl = mode === 'video' ? refs.video[i] : undefined
    setRefs((r) => ({ ...r, [mode]: r[mode as 'image' | 'video'].filter((_, idx) => idx !== i) }))
    if (removedUrl) dropVideoRefTag(removedUrl)
  }
  // Upload Library: remove an uploaded reference from the session library AND from the active selection (current mode).
  const removeFromLibrary = (url: string) => {
    const m = mode as 'image' | 'video'
    setUploadLibrary((lib) => ({ ...lib, [m]: lib[m].filter((u) => u !== url) }))
    setRefs((r) => ({ ...r, [m]: r[m].filter((u) => u !== url) }))
    if (m === 'video') dropVideoRefTag(url)
  }
  // Start/End frame — upload to the real public-URL path (fal.storage) so the value is provider-ready, not a
  // blob preview. Stored in vidStartFrame/vidEndFrame; only sent when the selected model declares frame capability.
  const pickFrame = async (which: 'start' | 'end', files: FileList | null) => {
    const f = files?.[0]
    if (!f || !f.type.startsWith('image/')) return
    setUploadingFrame(which)
    try {
      const url = await uploadPublicImage(f)
      if (!url) { toast('Frame upload failed — try again'); return }
      if (which === 'start') setVidStartFrame(url)
      else setVidEndFrame(url)
      toast(`${which === 'start' ? 'Start' : 'End'} frame added`)
    } finally {
      setUploadingFrame(null)
    }
  }

  const togglePanel = (p: 'model' | 'aspect' | 'quality' | 'style' | 'references' | 'director' | 'advanced' | 'vidquality' | 'vidmode' | 'vidframes' | 'vidduration' | 'audduration' | 'imgspeed' | 'imgquality' | 'imgresolution' | 'providerstyle' | 'acelyrics' | 'audgenre' | 'audmood') => setPanel((cur) => (cur === p ? null : p))
  const drawerPanel = panel === 'references' || panel === 'director' || (panel === 'advanced' && mode !== 'audio') || panel === 'vidframes'
  // Reference pilot: flux2max (image) exposes a single public-URL reference; other image models show none.
  const imgRefCfg = mode === 'image' ? getImageModelById(IMAGE_MODEL_IDS[imgModel] || imgModel) : undefined
  const imgMaxRefs = imgRefCfg?.reference?.maxRefs ?? imgRefCfg?.maxReferences ?? 1 // descriptor-driven max (single today)
  const curRefs = mode === 'video' ? refs.video : (imgRefCfg?.supportsReference ? refs.image.slice(0, imgMaxRefs) : [])
  // Video inline @imageN mention PREVIEW (render-time, video only) — tokenize the live prompt into text runs and
  // @imageN mentions so a read-only visual layer can mirror the prompt with [thumb] ImageN chips WHILE typing.
  // The textarea/prompt state stays plain text and the provider Reference-note logic in handleGenerate is unchanged.
  type VideoPromptPart = { type: 'text'; text: string } | { type: 'mention'; n: number; valid: boolean; url?: string }
  const videoPromptParts: VideoPromptPart[] | null = mode === 'video' && /@image\d+/i.test(prompt)
    ? (() => {
        const parts: VideoPromptPart[] = []
        let last = 0
        for (const mt of Array.from(prompt.matchAll(/@image(\d+)/gi))) {
          const idx = mt.index ?? 0
          if (idx > last) parts.push({ type: 'text', text: prompt.slice(last, idx) })
          const n = parseInt(mt[1], 10)
          const valid = n >= 1 && n <= refs.video.length
          parts.push({ type: 'mention', n, valid, url: valid ? refs.video[n - 1] : undefined })
          last = idx + mt[0].length
        }
        if (last < prompt.length) parts.push({ type: 'text', text: prompt.slice(last) })
        return parts
      })()
    : null
  // Insert "@imageN " at the active mention anchor (replacing the partial "@…" token), then refocus the textarea.
  const insertMention = (n: number) => {
    const ta = promptTaRef.current
    const caret = ta?.selectionStart ?? prompt.length
    const start = mentionStart >= 0 ? mentionStart : caret
    const insert = `@image${n} `
    const next = `${prompt.slice(0, start)}${insert}${prompt.slice(caret)}`
    setPrompt(next)
    setMentionOpen(false)
    setMentionStart(-1)
    const pos = start + insert.length
    requestAnimationFrame(() => { const el = promptTaRef.current; if (el) { el.focus(); el.setSelectionRange(pos, pos) } })
  }
  // Prompt edits + drive the @ mention picker (video only): open while the caret sits inside a "@token" with no space.
  const onPromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setPrompt(val)
    if (mode !== 'video' || refs.video.length === 0) { if (mentionOpen) setMentionOpen(false); return }
    const caret = e.target.selectionStart ?? val.length
    const before = val.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1])) && !/\s/.test(before.slice(at + 1))) {
      setMentionStart(at); setMentionHighlight(0); setMentionOpen(true)
    } else if (mentionOpen) {
      setMentionOpen(false)
    }
  }
  // Keyboard nav for the picker; no-op when closed so normal typing (incl. Enter newline) is unaffected.
  const onPromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionOpen || mode !== 'video') return
    const count = refs.video.length
    if (count === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionHighlight((h) => (h + 1) % count) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setMentionHighlight((h) => (h - 1 + count) % count) }
    else if (e.key === 'Enter') { e.preventDefault(); insertMention(mentionHighlight + 1) }
    else if (e.key === 'Escape') { e.preventDefault(); setMentionOpen(false); setMentionStart(-1) }
  }
  // Keep the in-box mention overlay scrolled in lockstep with the textarea.
  const onPromptScroll = () => { const m = promptMirrorRef.current, t = promptTaRef.current; if (m && t) m.scrollTop = t.scrollTop }
  const imageHistory = history.filter((h) => h.type === 'image' && !!h.url)
  // Reference picker choices: real generated images (own url) + Cinema Studio thumbnail-derived stills
  // (own-bucket still URL only — never the mp4). Cinema items are type=video, so there is no id overlap.
  const imageRefChoices = [
    ...imageHistory.map((h) => ({ id: h.id, prompt: h.prompt, refUrl: h.url as string, isStill: false })),
    ...history.filter((h) => h.source === 'cinema_studio' && !!h.stillUrl).map((h) => ({ id: h.id, prompt: h.prompt, refUrl: h.stillUrl as string, isStill: true })),
  ]
  const addRefUrl = (url: string) => {
    if (mode === 'audio') return
    if (mode === 'image') {
      // Only ref-capable models take a reference. Respect maxRefs + no duplicates (single today; array-ready for later).
      if (!imgRefCfg?.supportsReference || !/^https?:\/\//.test(url)) return
      setRefs((r) => {
        if (r.image.includes(url)) return r
        const next = imgMaxRefs <= 1 ? [url] : [...r.image, url].slice(-imgMaxRefs)
        return { ...r, image: next }
      })
      return
    }
    setRefs((r) => { const cur = r.video; return cur.includes(url) ? r : { ...r, video: [...cur, url] } })
  }
  // Current-mode model (shared with the left-panel dropdown — same state).
  const currentModels = mode === 'image' ? imageModels : mode === 'video' ? videoModels : audioModels
  const currentModelId = mode === 'image' ? imgModel : mode === 'video' ? vidModel : audModel
  const currentModelName = currentModels.find((m) => m.id === currentModelId)?.name ?? 'Select model'
  const setCurrentModel = (id: string) => { if (mode === 'image') setImgModel(id); else if (mode === 'video') setVidModel(id); else setAudModel(id) }
  // Selected image model's backend config — drives model-aware count / quality / negative-prompt UI + correct payload.
  const imgCfg = getImageModelById(IMAGE_MODEL_IDS[imgModel] || imgModel)
  const imgMaxImages = imgCfg?.maxImages ?? 1
  const imgResTiers = imgCfg?.resolutionTiers // verified resolution tiers (Nano Banana Pro 2K/4K); undefined = flat
  const imgSpeedTiers = imgCfg?.speedTiers // verified rendering-speed tiers (Ideogram V3 Turbo/Balanced/Quality); undefined = no speed control
  const imgQualityTiers = imgCfg?.qualityTiers // verified quality tiers (GPT Image 2 Fast/Standard/Ultra → low/medium/high); undefined = no quality-tier control
  const imgStyleOptions = imgCfg?.styleOptions // provider-level style enum (Ideogram V3 / Recraft V3); undefined = prompt-style only
  const imgSupportsQuality = !!imgCfg?.supportsQuality
  const imgSupportsNeg = imgCfg?.negativePromptSupport === 'native' // native provider negative_prompt (SD 3.5, Ideogram V3)
  // Negative Prompt is only sent (and only honored) for image models that support it. It is NOT part of
  // the video/audio request, so it must read as truthfully unsupported there (disabled + labeled).
  const negSupported = mode === 'image' && imgSupportsNeg
  const negNote = negSupported ? '' : mode === 'image' ? ' · not supported by this model' : mode === 'video' ? ' · not used for video' : ' · not used for audio'
  const imgSupportsReference = mode === 'image' && !!imgCfg?.supportsReference // reference-capable image models (flux2max, ideogram, seedream 4.0/4.5, nano banana 2/pro, gpt image 2)
  const imgRefKind = imgCfg?.referenceKind ?? 'image' // 'style' = style transfer (ideogram), 'image' = generic reference
  // Same-endpoint reference PILOT: the reference is injected into the model's standard text-to-image endpoint (no
  // dedicated /edit endpoint), so reference fidelity is NOT yet live-verified → the UI uses softer, honest copy.
  // Derivation: a descriptor that exists but has NO `endpoint` = same-endpoint pilot (flux2max, ideogram). Dedicated
  // /edit-endpoint models (Seedream 4.0/4.5, Nano Banana 2/Pro have reference.endpoint) and GPT Image 2 (OpenAI
  // /v1/images/edits — no fal descriptor) are NOT pilots → they keep strict "Reference" wording.
  const imgRefIsPilot = mode === 'image' && !!imgCfg?.supportsReference && !!imgCfg?.reference && !imgCfg.reference.endpoint
  // Reference UPLOAD is available for video AND for reference-capable image models (reuses the same upload pipeline).
  const refUploadAvailable = mode === 'video' || (mode === 'image' && imgSupportsReference)
  // Upload Library tab exists whenever upload is available (reference-capable image OR video); otherwise clamp away from it so the panel always has a valid view.
  const effTab: 'uploads' | 'library' | 'generations' = (refTab === 'library' && !refUploadAvailable) ? 'uploads' : refTab
  // Honest reference wording per mechanism: Ideogram = style influence; FLUX 1.1 Pro Ultra (same-endpoint pilot) =
  // "Reference influence" (effect may vary); dedicated /edit models + GPT Image 2 = strict "Reference".
  const imgRefLabel = imgRefKind === 'style' ? 'Style ref' : imgRefIsPilot ? 'Reference influence' : 'Reference'
  const imgRefChipHeader = imgRefKind === 'style' ? 'Style ref' : imgRefIsPilot ? 'Reference influence' : 'References'
  const imgRefTooltip = imgRefKind === 'style'
    ? 'Style reference / influence — transfers the look & style of the chosen image (not exact subject, identity, or layout). Effect may vary.'
    : imgRefIsPilot
      ? 'Reference influence — applied on this model’s standard endpoint; strength may vary (not a strict edit).'
      : 'Reference image — used as a strict visual reference on this model’s dedicated edit endpoint.'
  // Reference-capable model names (DYNAMIC — never a stale hard-coded subset) for the "unsupported" tooltip.
  const refCapableNames = IMAGE_MODELS.filter((m) => m.supportsReference).map((m) => m.label).join(', ')

  // Prompt-only VIDEO capability truth (read-only, from the shared descriptor → video-models.ts):
  // drives model-truthful duration options, aspect options, and audio. No scene/reference logic.
  // The picker selects a FAMILY; the in-box Mode + Quality controls resolve the EFFECTIVE runtime slug (a variant
  // with its own endpoint / durations / frames / audio / price). Mode + Quality OPTIONS come from the primary
  // (family) descriptor; everything else (durations, aspects, frames, audio, cost) follows the effective variant —
  // so e.g. Veo 3.1 + "First / Last Frame" switches to veo31_flf (4-6-8s, Start+End frames required, audio included).
  const vidPrimarySlug = VIDEO_MODEL_IDS[vidModel] || vidModel
  const vidPrimaryCtrls = mode === 'video' ? getVideoControls(vidPrimarySlug) : undefined
  // Frame cards are offered based on the model FAMILY (primary + its mode variants), so Seedance/Luma/Veo show usable
  // Start/End cards even while still text-to-video. Dispatch + validation still use the EFFECTIVE slug's own caps.
  const vidFamilyFrames = mode === 'video' ? getVideoFamilyFrames(vidPrimarySlug) : undefined
  const vidEffectiveSlug = mode === 'video'
    ? resolveVideoModeSlug(
        resolveVideoVariantSlug(vidPrimarySlug, (vidPrimaryCtrls && vidPrimaryCtrls.qualityOptions.length > 1) ? vidQuality : undefined),
        vidMode,
      )
    : vidPrimarySlug
  const vidCaps = mode === 'video' ? getVideoCapability(vidEffectiveSlug) : undefined
  const vidDurations = vidCaps?.durations ?? [5]
  // Merge: family Mode + Quality options (primary) + the effective variant's frame/audio capabilities.
  const vidEffCtrls = mode === 'video' ? getVideoControls(vidEffectiveSlug) : undefined
  const vidControls = (mode === 'video' && vidEffCtrls && vidPrimaryCtrls)
    ? { ...vidEffCtrls, startFrame: !!vidFamilyFrames?.startFrame, endFrame: !!vidFamilyFrames?.endFrame, modes: vidPrimaryCtrls.modes, qualityOptions: vidPrimaryCtrls.qualityOptions }
    : undefined
  const vidEffectiveAudio = vidControls?.audioToggle ? vidAudioOn : (vidCaps?.hasAudio ?? false)
  // Veo 3.1 First/Last Frame is all-or-nothing: a model whose workflow modes include 'first-last-frame' (Veo 3.1)
  // requires BOTH a Start and an End frame together → label them REQUIRED. Image-to-video models (Seedance/Luma)
  // keep the 'Optional' label (start-only i2v). Plain text-to-video is unaffected. Capability-driven; no Mode chip, no banner.
  const vidFlfRequired = mode === 'video' && !!vidControls?.modes?.includes('first-last-frame')
  // Reference truth: NO current video model sends referenceImageUrl. On models WITH an image-to-video variant, the
  // first selected Reference is AUTO-used as the Start Frame (real i2v input). Only on models WITHOUT an i2v variant
  // is a Reference Image purely a prompt guide → that's when we label it so.
  const vidHasI2vMode = !!vidControls?.modes?.includes('image-to-video')
  const vidRefPromptOnly = mode === 'video' && !vidControls?.imageReference && !vidHasI2vMode
  // Reference-to-video (Kling O1): refs are a REAL structured input (image_urls[]) → label as required + show the cap,
  // and HIDE the Start/End frame cards (this model has no frame inputs).
  const vidImgRef = mode === 'video' && !!vidControls?.imageReference
  const vidMaxRefs = vidControls?.maxImageReferences ?? 0
  // Assign an EXISTING public image url (generated / history / reference tile) straight to a video frame slot — no
  // upload needed (it's already an https url). Capability-gated: flashes the existing "not supported" note otherwise.
  // Returns true on success so callers can close their panel/modal. Does NOT touch validation / route / payload.
  const assignFrameUrl = (which: 'start' | 'end', url: string): boolean => {
    if (mode !== 'video' || !/^https?:\/\//.test(url)) return false
    if (which === 'start' && !vidControls?.startFrame) { setFrameUnsupported('start'); return false }
    if (which === 'end' && !vidControls?.endFrame) { setFrameUnsupported('end'); return false }
    if (which === 'start') setVidStartFrame(url); else setVidEndFrame(url)
    toast(`${which === 'start' ? 'Start' : 'End'} frame set`)
    return true
  }

  // Live generation cost — mirrors the real runtime charge for each route (single source of truth, no hardcoded UI numbers):
  //  image → CREDITS.image[slug] (== imgCfg.credits) × effective image count (clamped to maxImages)
  //  video → calculateVideoCost(mapped slug, duration, withAudio) — the exact fn the video route charges with
  //  audio → CREDITS.audio by selected length (audDuration 30/60/120 → stability30s/60s/2min — the same tiers the route charges)
  const genCost =
    mode === 'image'
      ? (imgCfg ? (imgSpeedTiers ? getImageSpeedCredits(imgCfg, imgSpeed) : imgResTiers ? getImageResolutionCredits(imgCfg, imgResolution) : imgQualityTiers ? getImageQualityCredits(imgCfg, imgGptQuality) : getImageTierCredits(imgCfg, imgQuality === 'HD' ? 'hd' : 'standard')) : 0) * numImages
      : mode === 'video'
      ? calculateVideoCost(vidEffectiveSlug === 'luma3_i2v' ? 'luma3' : vidEffectiveSlug === 'seedance20_i2v' ? 'seedance20' : vidEffectiveSlug === 'seedance2_i2v' ? 'seedance2' : vidEffectiveSlug, vidDuration, vidEffectiveAudio)
      : (audCfg ? resolveAudioCredits(audCfg, audHasTiers ? audDuration : undefined).credits : 0)
  // Audio TTS truth: ElevenLabs voices hard-cap input at maxChars (1000). Surface a live counter and BLOCK Generate
  // over the cap so the user is never charged for speech the provider would silently slice off. The audio route also
  // slices text to maxChars as the final guard — this is the UI-side stop so the user sees the limit before paying.
  const audMaxChars = mode === 'audio' ? (audCfg?.maxChars ?? null) : null
  const audCharCount = prompt.trim().length
  const audOverLimit = audMaxChars != null && audCharCount > audMaxChars
  // Aspect options are capability-driven: video filters by the effective model's caps; image uses the
  // selected model's truthful aspectRatios (no fake ratios the provider would silently square-crop).
  const aspectOptions = mode === 'video'
    ? ASPECTS.video.filter((a) => !vidCaps || vidCaps.aspects.some((x) => x === a.v)).map((a) => a.v)
    : ((imgCfg?.aspectRatios as string[] | undefined) ?? ASPECTS.image.map((a) => a.v))
  const currentAspect = mode === 'video' ? vidAspect : imgAspect
  const setAspect = (v: string) => { if (mode === 'video') setVidAspect(v); else setImgAspect(v) }
  // Same composer height for all modes (Image is the reference); refs add a chip row (image/video).
  const promptBarHeight = 248 + (mode !== 'audio' && curRefs.length > 0 ? 48 : 0)
  const histItems = history.filter((h) => histFilter === 'all' || h.type === histFilter)
  const generating = gen.find((g) => g.status === 'generating')
  const completedItems = gen.filter((g) => g.status === 'completed' && !!g.url && !dismissedIds.has(g.id))
  const activeItem = completedItems.find((g) => g.id === activeId) ?? completedItems[0] ?? null
  const hasContent = !!generating || completedItems.length > 0
  const showStrip = completedItems.length >= 2 || (!!generating && completedItems.length >= 1)
  const bulkActive = mode === 'image' && !!bulk // bulk panel takes over the result area (image-only)

  const modeIcon = (m: Mode) =>
    m === 'image'
      ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" /><circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" /><path d="M1.5 11L5 7.5L7.5 10L10 8L14.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      : m === 'video'
      ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="3.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 6.5L14.5 4.5V11.5L10.5 9.5V6.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
      : <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1.5V14.5M5 4V12M11 4V12M2 6.5V9.5M14 6.5V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>

  return (
    <div className={`${s.shell} ${videoOnly ? s.videoTheme : ''} ${imageOnly ? s.imageTheme : ''} ${audioOnly ? s.audioTheme : ''}`}>
      {imageOnly && <QelarixGridBackdrop tone="green" />}
      {(videoOnly || audioOnly) && (
        <div className={s.videoGrid} aria-hidden>
          <span className={`${s.videoGridPlane} ${s.videoGridTop}`} />
          <span className={`${s.videoGridPlane} ${s.videoGridBottom}`} />
          <span className={s.videoGridHorizon} />
          <span className={s.videoGridStars} />
        </div>
      )}
      {/* Ambient vertical edge-glow rails (decorative, pointer-events:none, behind all UI).
          Right rail hides while the History dropdown is open. */}
      <div className={`${s.edgeGlow} ${s.edgeGlowLeft}`} aria-hidden />
      <div className={`${s.edgeGlow} ${s.edgeGlowRight} ${histOpen ? s.edgeGlowHidden : ''}`} aria-hidden />

      {/* ══ TOPBAR ══ */}
      <header className={s.topbar}>
        <div className={s.logo}>
          <span className={s.logoSub}>{videoOnly ? 'Create Video' : imageOnly ? 'Create Image' : audioOnly ? 'Generate Audio' : 'Playground'}</span>
        </div>
        {/* History header lives on the Playground topbar row (right side). The duplicate credits pill + avatar were
            removed — they already exist in the global navbar. The History dropdown still renders in the right panel. */}
        <div className={s.rpHeader} ref={histHeaderRef}>
          <div className={s.rpTitle}>History</div>
          <div className={s.histFilter}>
            {((lockedMode ? [lockedMode] : ['all', 'image', 'video', 'audio']) as HistFilter[]).map((f) => (
              <button key={f} className={`${s.hf} ${(histOpen && histFilter === f) ? s.on : ''}`} onClick={() => { if (histOpen && histFilter === f) { setHistOpen(false) } else { setHistFilter(f); setHistOpen(true) } }}>
                {f === 'all' ? 'All' : f === 'image' ? 'Img' : f === 'video' ? 'Vid' : 'Aud'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className={s.main}>
        {/* Left settings panel removed — all controls live in the bottom command bar.
            Hidden file input kept here for the Reference upload panel. */}
        <input ref={fileRef} type="file" accept={mode === 'image' ? 'image/png,image/jpeg,image/webp' : 'image/*'} multiple style={{ display: 'none' }} onChange={(e) => { addRefs(e.target.files); e.target.value = '' }} />
        <input ref={startFrameRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { pickFrame('start', e.target.files); e.target.value = '' }} />
        <input ref={endFrameRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { pickFrame('end', e.target.files); e.target.value = '' }} />

        {/* ══ CENTER ══ */}
        <main className={`${s.center} ${dropping ? s.dropHint : ''}`} onDragOver={onWsDragOver} onDrop={onWsDrop}>
          <div className={s.ambient} aria-hidden>
            <div className={`${s.ambientOrb} ${s.ao1}`} /><div className={`${s.ambientOrb} ${s.ao2}`} /><div className={`${s.ambientOrb} ${s.ao3}`} />
          </div>

          <div className={`${s.genCanvas} ${s.scroll} ${(hasContent || bulkActive) ? s.hasItems : ''}`}>
            {!hasContent && !bulkActive && <ModeHero mode={mode} />}

            {(hasContent || bulkActive) && (
              <div className={s.resultArea}>
                {bulkActive && bulk ? (
                  <BulkPanel
                    bulk={bulk}
                    canRef={mode === 'image' && !!imgRefCfg?.supportsReference}
                    onReuse={(p) => { setPrompt(p) }}
                    onUseRef={(url) => { addRefUrl(url) }}
                    onRetry={() => { void retryBulk() }}
                    onClear={() => setBulk(null)}
                  />
                ) : generating ? (
                  <div className={s.genPanel}>
                    <QelarixGenerationLoader size="lg" mode={generating.type} sublabel="Qelarix is creating your result…" />
                    {generating.prompt && <div className={s.genPanelPrompt}>“{generating.prompt}”</div>}
                  </div>
                ) : activeItem ? (
                  <ActiveResult
                    key={activeItem.id}
                    item={activeItem}
                    canRef={mode === 'video' || (mode === 'image' && !!imgRefCfg?.supportsReference)}
                    onReuse={(p) => { setPrompt(p) }}
                    onUseRef={(url) => { addRefUrl(url) }}
                    onClose={() => setDismissedIds((s) => new Set(s).add(activeItem.id))}
                  />
                ) : null}

                {!bulkActive && showStrip && (
                  <div className={`${s.resultStrip} ${s.scroll}`}>
                    {completedItems.map((it) => (
                      <StripThumb key={it.id} item={it} active={it.id === activeItem?.id} onClick={() => setActiveId(it.id)} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ══ FLOATING CONTROL PANELS (References / Director / Advanced) ══ */}
          {drawerPanel && (
            <div className={s.floatWrap} ref={floatWrapRef}>
              <div className={`${s.floatPanel} ${panel === 'references' ? s.refsPanel : ''}`}>
                {panel === 'references' && (
                  <>
                    <div className={s.fpHead}>
                      <div className={s.fpTabs}>
                        {/* Reference sources: Upload (action) · Upload Library (session uploads, image + video) · Image Generations. */}
                        {refUploadAvailable && <button className={`${s.fpTab} ${effTab === 'uploads' ? s.on : ''}`} onClick={() => setRefTab('uploads')}>Upload</button>}
                        {refUploadAvailable && <button className={`${s.fpTab} ${effTab === 'library' ? s.on : ''}`} onClick={() => setRefTab('library')}>Upload Library</button>}
                        <button className={`${s.fpTab} ${effTab === 'generations' ? s.on : ''}`} onClick={() => setRefTab('generations')}>Image Generations</button>
                      </div>
                      <button className={s.fpClose} onClick={() => setPanel(null)} aria-label="Close">✕</button>
                    </div>
                    <div className={s.fpBody}>
                      {/* Same-endpoint reference PILOT honesty note (image only): FLUX 1.1 Pro Ultra / Ideogram V3 inject the
                          reference into their standard endpoint, so fidelity is not yet live-verified. Dedicated /edit models
                          (Seedream, Nano Banana) + GPT Image 2 don't show this. UI-only — no payload/route/pricing impact. */}
                      {mode === 'image' && imgRefIsPilot && (
                        <div style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, background: 'rgba(123,97,255,0.08)', border: '1px solid rgba(123,97,255,0.22)', color: 'rgba(230,230,245,0.82)', fontSize: 12, lineHeight: 1.45 }}>
                          {imgRefKind === 'style'
                            ? 'Ideogram V3 uses this image as a style reference / influence — it guides look & style, not exact subject or layout.'
                            : 'FLUX 1.1 Pro Ultra applies this as a reference influence — strength may vary; it is not a strict edit.'}
                        </div>
                      )}
                      <div className={s.refSplit}>
                        {/* LEFT 65% — Reference area (Uploads / Image Generations), compact tiles */}
                        <div className={`${s.refSide} ${s.scroll}`}>
                          <div className={s.refGrid}>
                            {/* Single clean upload action (NOT a slot grid) — uploads land in the Upload Library. */}
                            {refUploadAvailable && effTab === 'uploads' && (
                              <button
                                className={`${s.uploadCard} ${dragOver ? s.over : ''}`}
                                onClick={() => fileRef.current?.click()}
                                disabled={uploadingRef}
                                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={(e) => { e.preventDefault(); setDragOver(false); addRefs(e.dataTransfer.files) }}
                              >
                                <span className={s.uploadPlus}>{uploadingRef ? <span className={s.miniSpin} /> : '+'}</span>
                                {uploadingRef ? 'Uploading…' : (mode === 'image' ? 'Upload images' : 'Upload')}
                              </button>
                            )}
                            {/* Upload Library (image AND video) — session-stored uploads; click to select, ✕ to remove.
                                The Upload tab is a single clean card for both modes; selected refs show in the composer strip. */}
                            {effTab === 'library' && ((uploadLibrary[mode as 'image' | 'video'] ?? []).length === 0
                              ? <div className={s.fpEmpty}>No uploads yet — use the Upload tab to add images to your library.</div>
                              : (uploadLibrary[mode as 'image' | 'video'] ?? []).map((u) => (
                                <div key={u} className={`${s.refCell} ${curRefs.includes(u) ? s.selected : ''}`} title="Click to use as reference image">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={u} alt="uploaded reference" style={{ cursor: 'pointer' }} onClick={() => { addRefUrl(u) }} />
                                  <button className={s.refCellRm} onClick={() => removeFromLibrary(u)} aria-label="Remove from library" title="Remove from library">✕</button>
                                  {/* Video: assign this uploaded image directly to a frame slot (capability-gated). */}
                                  {mode === 'video' && (vidControls?.startFrame || vidControls?.endFrame) && (
                                    <div className={s.refFrameBtns}>
                                      {vidControls?.startFrame && <button type="button" className={s.refFrameBtn} title="Use as Start Frame" onClick={(e) => { e.stopPropagation(); assignFrameUrl('start', u) }}>Start</button>}
                                      {vidControls?.endFrame && <button type="button" className={s.refFrameBtn} title="Use as End Frame" onClick={(e) => { e.stopPropagation(); assignFrameUrl('end', u) }}>End</button>}
                                    </div>
                                  )}
                                </div>
                              )))}
                            {(effTab === 'generations' || !refUploadAvailable) && (imageRefChoices.length === 0
                              ? <div className={s.fpEmpty}>No generated images yet — create one to reuse it as a reference.</div>
                              : imageRefChoices.map((h) => (
                                <div key={h.id} className={`${s.refCell} ${curRefs.includes(h.refUrl) ? s.selected : ''}`} title={h.isStill ? `Cinema Studio still — ${h.prompt}` : h.prompt}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={h.refUrl} alt={h.prompt} style={{ cursor: 'pointer' }} onClick={() => { addRefUrl(h.refUrl) }} />
                                  {h.isStill && <span className={s.refStillTag}>Still</span>}
                                  {/* Video: assign this generated/still image directly to a frame slot (capability-gated). */}
                                  {mode === 'video' && (vidControls?.startFrame || vidControls?.endFrame) && (
                                    <div className={s.refFrameBtns}>
                                      {vidControls?.startFrame && <button type="button" className={s.refFrameBtn} title="Use as Start Frame" onClick={(e) => { e.stopPropagation(); assignFrameUrl('start', h.refUrl) }}>Start</button>}
                                      {vidControls?.endFrame && <button type="button" className={s.refFrameBtn} title="Use as End Frame" onClick={(e) => { e.stopPropagation(); assignFrameUrl('end', h.refUrl) }}>End</button>}
                                    </div>
                                  )}
                                </div>
                              )))}
                          </div>
                        </div>
                        {/* RIGHT — Start / End Frame slots are ALWAYS visible. Behavior is capability-gated: when the
                            effective model/mode supports the input (Veo 3.1 → First/Last Frame) the slot uploads a real
                            public url; otherwise it's muted and a click flashes a short in-slot "not supported" note. */}
                        {mode === 'video' && (
                          <div className={s.framesCol}>
                            <div className={s.framesHint}>{vidImgRef ? 'Select one or more reference images for subject / character consistency.' : 'Click a tile for Reference; use its Start / End buttons to assign frames.'}</div>
                            <div className={s.refImgCard}>
                              <span className={s.frameCardLabel}>{vidRefPromptOnly ? 'Reference Image (prompt only)' : vidImgRef ? `Reference Images${vidMaxRefs ? ` (up to ${vidMaxRefs}, required)` : ' (required)'}` : 'Reference Image'}</span>
                              {curRefs.length > 0 ? (
                                <div className={s.refImgThumbs}>
                                  {curRefs.slice(0, 6).map((u, i) => (
                                    <div key={i} className={s.refImgThumb}>
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img src={u} alt="" />
                                      {/* removeRef(i) removes refs.video[i], prunes its role tag, and @image numbering follows refs.video order. */}
                                      <button type="button" className={s.refImgRm} onClick={() => removeRef(i)} aria-label="Remove reference" title="Remove reference">✕</button>
                                    </div>
                                  ))}
                                  {curRefs.length > 6 && <span className={s.refImgMore}>+{curRefs.length - 6}</span>}
                                </div>
                              ) : (
                                <span className={s.refImgEmpty}>None yet — click an image</span>
                              )}
                            </div>
                            {!vidImgRef && (<div className={s.framesRow}>
                            <button type="button" className={`${s.frameCard} ${vidStartFrame ? s.frameCardFilled : ''} ${!vidControls?.startFrame ? s.frameCardMuted : ''}`} disabled={uploadingFrame === 'start'} title={vidControls?.startFrame ? (vidFlfRequired ? 'Start frame — REQUIRED for Veo 3.1 First / Last Frame (use together with an End Frame)' : "Start frame — the clip's first frame (optional — adds image-to-video)") : 'Start Frame — not used by this model'} onClick={() => { if (vidControls?.startFrame) startFrameRef.current?.click(); else setFrameUnsupported('start') }}>
                              {frameUnsupported === 'start' ? (
                                <span className={s.frameCardMsg}>This model does not support this</span>
                              ) : vidStartFrame ? (
                                <>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={vidStartFrame} alt="start frame" className={s.frameCardImg} />
                                  <span className={s.frameCardRm} onClick={(e) => { e.stopPropagation(); setVidStartFrame(null) }} aria-label="Remove start frame">✕</span>
                                  <span className={s.frameCardLabel}>Start Frame</span>
                                </>
                              ) : (
                                <>
                                  {vidControls?.startFrame && <span className={s.frameCardTop}>{uploadingFrame === 'start' ? 'Uploading' : (vidFlfRequired ? 'Required' : 'Optional')}</span>}
                                  <span className={s.frameCardPlus}>{uploadingFrame === 'start' ? <span className={s.miniSpin} /> : '+'}</span>
                                  <span className={s.frameCardLabel}>Start Frame</span>
                                </>
                              )}
                            </button>
                            <button type="button" className={`${s.frameCard} ${vidEndFrame ? s.frameCardFilled : ''} ${!vidControls?.endFrame ? s.frameCardMuted : ''}`} disabled={uploadingFrame === 'end'} title={vidControls?.endFrame ? (vidFlfRequired ? 'End frame — REQUIRED for Veo 3.1 First / Last Frame (use together with a Start Frame)' : "End frame — the clip's last frame (optional)") : 'End Frame — not used by this model'} onClick={() => { if (vidControls?.endFrame) endFrameRef.current?.click(); else setFrameUnsupported('end') }}>
                              {frameUnsupported === 'end' ? (
                                <span className={s.frameCardMsg}>This model does not support this</span>
                              ) : vidEndFrame ? (
                                <>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={vidEndFrame} alt="end frame" className={s.frameCardImg} />
                                  <span className={s.frameCardRm} onClick={(e) => { e.stopPropagation(); setVidEndFrame(null) }} aria-label="Remove end frame">✕</span>
                                  <span className={s.frameCardLabel}>End Frame</span>
                                </>
                              ) : (
                                <>
                                  {vidControls?.endFrame && <span className={s.frameCardTop}>{uploadingFrame === 'end' ? 'Uploading' : (vidFlfRequired ? 'Required' : 'Optional')}</span>}
                                  <span className={s.frameCardPlus}>{uploadingFrame === 'end' ? <span className={s.miniSpin} /> : '+'}</span>
                                  <span className={s.frameCardLabel}>End Frame</span>
                                </>
                              )}
                            </button>
                            </div>)}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}

                {panel === 'director' && (
                  <>
                    <div className={s.fpHead}>
                      <div className={s.fpTitle}>Director Panel</div>
                      <button className={s.fpClose} onClick={() => setPanel(null)} aria-label="Close">✕</button>
                    </div>
                    <div className={s.directorRow}>
                      <label className={s.dirField}><span>Movement</span>
                        <select className={s.qSelect} value={camera} onChange={(e) => setCamera(e.target.value)}>
                          {CAMERAS.map((c) => <option key={c.l} value={c.l}>{c.l}</option>)}
                        </select>
                      </label>
                      <label className={s.dirField}><span>Speed ramp</span>
                        <select className={s.qSelect} value={speedRamp} onChange={(e) => setSpeedRamp(e.target.value)}>
                          {['Linear', 'Slow-mo', 'Ramp up', 'Ramp down', 'Freeze'].map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </label>
                      {/* Duration moved to the main video control row (Model | Mode | Duration | Aspect | Quality | Audio). */}
                    </div>
                    <div className={s.dirSplit}>
                      <div className={s.dirCol}>
                        <div className={s.fpLabel}>Shot type</div>
                        <div className={s.chipRow}>
                          {SHOT_TYPES.map((c) => (
                            <span key={c} className={`${s.chip} ${shotTypes.includes(c) ? s.on : ''}`}
                              onClick={() => setShotTypes((st) => st.includes(c) ? st.filter((x) => x !== c) : [...st, c])}>{c}</span>
                          ))}
                        </div>
                      </div>
                      <div className={s.dirCol}>
                        <div className={s.fpLabel}>Motion guidance</div>
                        <div className={s.chipRow}>
                          {MOTIONS.map((m) => (
                            <span key={m} className={`${s.chip} ${motionGuide === m ? s.on : ''}`} onClick={() => setMotionGuide(m)}>{m}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {panel === 'advanced' && (
                  <>
                    <div className={s.fpHead}>
                      <div className={s.fpTitle}>Advanced prompt</div>
                      <button className={s.fpClose} onClick={() => setPanel(null)} aria-label="Close">✕</button>
                    </div>
                    <div className={s.advGrid}>
                      <div className={s.advCol}>
                        <div className={s.fpLabel}>Cinematic Direction</div>
                        <textarea className={s.advTextarea} placeholder="Golden hour. Anamorphic bokeh. Fog rolling across a still lake…" value={cineDirection} onChange={(e) => setCineDirection(e.target.value)} />
                      </div>
                      <div className={s.advCol}>
                        <div className={s.fpLabel}>Negative Prompt{negNote}</div>
                        <textarea className={s.advTextarea} placeholder="blurry, low quality, watermark, oversaturated, flat lighting…" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} disabled={!negSupported} />
                      </div>
                    </div>
                  </>
                )}
                {/* Frames & Reference foundation panel — only rendered when the model supports these inputs (none yet).
                    Slots are scaffold; provider upload + send wiring lands in the next step. */}
                {/* (The 'Frames & Reference' panel was replaced by inline Start/End Frame slots in the video control row.) */}
              </div>
            </div>
          )}

          {/* ══ PROMPT BAR (fixed compact height) ══ */}
          <div className={`${s.promptArea} ${focused ? s.lit : ''}`} style={{ height: promptBarHeight }} ref={promptAreaRef}>
            {/* Attached left mode dock — shares the same mode state as the top switch */}
            <div className={s.modeDock} style={lockedMode ? { display: 'none' } : undefined}>
              {(['image', 'video', 'audio'] as Mode[]).map((m) => (
                <button key={m} className={`${s.modeDockBtn} ${mode === m ? s.modeDockOn : ''}`} onClick={() => setMode(m)} title={m[0].toUpperCase() + m.slice(1)}>
                  {modeIcon(m)}
                  <span>{m[0].toUpperCase() + m.slice(1)}</span>
                </button>
              ))}
            </div>
            <div className={s.promptGlow} />
            <div className={`${s.promptShell} ${focused ? s.focused : ''}`}>
              {mode !== 'audio' && curRefs.length > 0 && (
                <div className={s.refChips}>
                  <span className={s.refChipsLabel}>
                    {mode === 'image' ? imgRefChipHeader : (vidImgRef ? 'Reference images' : 'References')} {curRefs.length}{mode === 'image' ? `/${imgMaxRefs}` : (vidImgRef && vidMaxRefs ? `/${vidMaxRefs}` : '')}{vidRefPromptOnly ? ' · prompt guide only' : ''}{vidImgRef ? ' · required' : ''}
                  </span>
                  {curRefs.map((u, i) => (
                    <div key={i} className={`${s.refChip}${mode === 'video' ? ` ${s.refChipVid}` : ''}`} title={mode === 'image' ? imgRefTooltip : 'Reference'}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={u} alt="reference" />
                      {/* Video-only @imageN mention label (Phase 1): stable by refs.video order — type it in the prompt. */}
                      {mode === 'video' && <span className={s.refChipMention} aria-hidden>@image{i + 1}</span>}
                      {/* Role dropdown removed (2026-06-12): role intent is expressed via prompt tagging / @image mentions.
                          videoRefTags state kept (defaults empty → no role applied); the @mention behavior is unchanged. */}
                      <button className={s.refChipRm} onClick={() => removeRef(i)} aria-label="Remove reference">✕</button>
                    </div>
                  ))}
                </div>
              )}
              <div className={s.promptRow}>
                {/* Video-only @ mention picker — opens while typing "@"; click or keyboard inserts @imageN. */}
                {mode === 'video' && mentionOpen && refs.video.length > 0 && (
                  <div className={s.mentionMenu} role="listbox" aria-label="Insert image reference">
                    {refs.video.map((u, i) => {
                      const role = videoRefTags[u]
                      return (
                        <div
                          key={i}
                          role="option"
                          aria-selected={i === mentionHighlight}
                          className={`${s.mentionOpt} ${i === mentionHighlight ? s.on : ''}`}
                          onMouseEnter={() => setMentionHighlight(i)}
                          onMouseDown={(e) => { e.preventDefault(); insertMention(i + 1) }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={u} alt="" />
                          <div className={s.mentionOptText}>
                            <div className={s.mentionOptLabel}>Image{i + 1}</div>
                            <div className={s.mentionOptSub}>@image{i + 1}</div>
                          </div>
                          {role && <span className={s.mentionOptRole}>{VIDEO_REF_TAG_LABELS[role]}</span>}
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className={s.promptStack}>
                  {/* Video-only in-box mention overlay: a pointer-events:none mirror that visually replaces @imageN
                      with [thumb] ImageN INSIDE the prompt box. It mirrors the textarea's text metrics; the textarea
                      stays the plain-text source of truth (its text is made transparent only while mentions exist —
                      no contenteditable, no rich-text editor, no extra row, no reduced typing space). */}
                  {mode === 'video' && videoPromptParts && (
                    <div ref={promptMirrorRef} className={s.promptMirror} aria-hidden>
                      {videoPromptParts.map((part, idx) =>
                        part.type === 'text'
                          ? <span key={idx}>{part.text}</span>
                          : part.valid
                            ? (
                              // Width-reserving slot: the literal "@imageN" (transparent) reserves the EXACT textarea
                              // text width so the caret + line wrapping stay aligned; the visual chip is overlaid
                              // absolutely (zero layout footprint, clipped to the slot so it never shifts later text).
                              <span key={idx} className={s.mentionSlot}>
                                @image{part.n}
                                <span className={s.mentionChip}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  {part.url && <img src={part.url} alt="" />}
                                  Image{part.n}
                                </span>
                              </span>
                            )
                            : <span key={idx} className={s.inlineMentionBad}>@image{part.n}</span>
                      )}
                    </div>
                  )}
                  <textarea
                    ref={promptTaRef}
                    className={`${s.promptInput} ${s.scroll} ${mode === 'video' && videoPromptParts ? s.promptInputOverlay : ''}`}
                    placeholder={PLACEHOLDERS[mode]}
                    value={prompt}
                    maxLength={2000}
                    onChange={onPromptChange}
                    onKeyDown={onPromptKeyDown}
                    onScroll={onPromptScroll}
                    onFocus={() => setFocused(true)}
                    onBlur={() => { setFocused(false); window.setTimeout(() => setMentionOpen(false), 120) }}
                  />
                </div>
                <div className={s.promptRowRight}>
                  {mode !== 'audio' && (
                    <button className={s.enhanceBtn} onClick={enhance} title="Appends a preset detail phrase to your prompt (no AI — just adds descriptive words).">
                      Add detail
                    </button>
                  )}
                  {audOverLimit && (
                    <span className={s.pfCount} style={{ color: '#ff6b6b', fontWeight: 600 }}>
                      Text is over the {audMaxChars} character limit.
                    </span>
                  )}
                  <span
                    className={s.pfCount}
                    style={audMaxChars != null ? { color: audOverLimit ? '#ff6b6b' : '#b8a9f0', fontWeight: 600 } : undefined}
                  >
                    {audMaxChars != null
                      ? <>{audCharCount}&thinsp;/&thinsp;{audMaxChars}</>
                      : <>{prompt.length}&thinsp;/&thinsp;2000</>}
                  </span>
                </div>
              </div>

              {/* Audio half-knobs moved into the footer row (between the Model chip and Generate) — see the akRow below. */}

              <div className={s.promptFooter}>
                <div className={s.pfLeft}>
                  <div className={s.chipWrap}>
                    <button className={`${s.modelChip} ${panel === 'model' ? s.modelChipOn : ''}`} onClick={() => togglePanel('model')} title={`Model · ${currentModelName}`}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.4" /><rect x="6" y="6" width="4" height="4" stroke="currentColor" strokeWidth="1.2" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
                      <span className={s.modelChipLabel}>Model</span>
                      <span className={s.modelChipValue}>{currentModelName}</span>
                    </button>
                    {panel === 'model' && (
                      <ModelPicker
                        models={currentModels}
                        currentId={currentModelId}
                        onSelect={(id) => { setCurrentModel(id); setPanel(null) }}
                        mode={mode}
                        userPlan={plan}
                        onToast={toast}
                      />
                    )}
                  </div>
                  {/* ── Video prompt-bar controls — fixed order: Model | Mode | Duration | Aspect | Quality | Audio | (Start/End Frame).
                       Capability-driven: each renders only when the selected model supports it. Same glass-chip style as the rest of the dock. ── */}
                  {mode === 'video' && vidControls && (
                    <>
                      {/* Mode chip removed — the effective workflow (text-to-video / image-to-video / first-last-frame) is
                          AUTO-derived from the inputs: a Reference/Start Frame → image-to-video; both frames → first/last. */}
                      <div className={s.chipWrap}>
                        <button className={`${s.pfBtn} ${s.chipIV} ${s.chipDuration} ${panel === 'vidduration' ? s.pfOn : ''}`} onClick={() => togglePanel('vidduration')} title={`Duration · ${vidDuration}s`}>
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.4" /><path d="M8 5.5V8.5L10 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          <span className={s.modelChipValue}>{vidDuration}s</span>
                        </button>
                        {panel === 'vidduration' && (
                          <div className={s.chipPop}>
                            <div className={s.chipPopHead}>Duration</div>
                            {vidDurations.map((d) => (
                              <button key={d} className={`${s.droplet} ${vidDuration === d ? s.dropletOn : ''}`} onClick={() => { setVidDuration(d); setPanel(null) }}><span className={s.dropletName}>{d}s</span></button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className={s.chipWrap}>
                        <button className={`${s.pfBtn} ${s.chipIV} ${s.chipAspect} ${panel === 'aspect' ? s.pfOn : ''}`} onClick={() => togglePanel('aspect')} title={`Aspect · ${currentAspect}`}>
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" /></svg>
                          <span className={s.modelChipValue}>{currentAspect}</span>
                        </button>
                        {panel === 'aspect' && (
                          <div className={s.chipPop}>
                            <div className={s.chipPopHead}>Aspect Ratio</div>
                            {aspectOptions.map((opt) => (
                              <button key={opt} className={`${s.droplet} ${currentAspect === opt ? s.dropletOn : ''}`} onClick={() => { setAspect(opt); setPanel(null) }}><span className={s.dropletName}>{opt}</span></button>
                            ))}
                          </div>
                        )}
                      </div>
                      {vidControls.qualityOptions.length > 1 && (
                        <div className={s.chipWrap}>
                          <button className={`${s.pfBtn} ${s.chipIV} ${s.chipQuality} ${panel === 'vidquality' ? s.pfOn : ''}`} onClick={() => togglePanel('vidquality')} title={`Quality · ${vidQuality}`}>
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><path d="M5 6.5h6M5 9h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
                            <span className={s.modelChipValue}>{vidQuality}</span>
                          </button>
                          {panel === 'vidquality' && (
                            <div className={s.chipPop}>
                              <div className={s.chipPopHead}>Quality</div>
                              {vidControls.qualityOptions.map((opt) => (
                                <button key={opt} className={`${s.droplet} ${vidQuality === opt ? s.dropletOn : ''}`} onClick={() => { setVidQuality(opt); setPanel(null) }}><span className={s.dropletName}>{opt}</span></button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {vidControls.audioToggle ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={vidAudioOn}
                          aria-label={vidAudioOn ? 'Audio on — click to turn off' : 'Audio off — click to turn on'}
                          className={`${s.pfBtn} ${s.chipIV} ${s.chipAudio} ${s.audioToggle} ${vidAudioOn ? s.audioToggleOn : s.audioToggleOff}`}
                          onClick={() => setVidAudioOn((v) => !v)}
                          title={vidAudioOn ? 'Audio on — click to turn off' : 'Audio off — click to turn on'}
                        >
                          {vidAudioOn
                            ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 6v4h2.5L9 13V3L5.5 6H3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.7 4.3a6 6 0 0 1 0 7.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                            : <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 6v4h2.5L9 13V3L5.5 6H3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M2.6 13.4L13.4 2.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
                          <span className={s.audioState}>{vidAudioOn ? 'On' : 'Off'}</span>
                        </button>
                      ) : vidControls.audioIncluded ? (
                        <span className={s.audioPill} title="Native audio — included (always on) for this model">
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 6v4h2.5L9 13V3L5.5 6H3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                          Audio
                        </span>
                      ) : null}
                      {/* Start / End Frame inputs live in the compact Reference panel (Reference button → right column),
                          NOT in the dock — the prompt bar stays clean. */}
                    </>
                  )}
                  {/* Audio duration/length selector — standard chip + popup (same pattern as the video duration chip). */}
                  {mode === 'audio' && audHasTiers && (() => {
                    const ctrlLabel = audCfg?.taskType === 'song' ? 'Duration' : 'Length'
                    const tiers = audCfg?.tiers ?? []
                    const cur = tiers.find((t) => t.seconds === audDuration) ?? tiers[0]
                    return (
                      <div className={s.chipWrap}>
                        <button className={`${s.pfBtn} ${s.chipIV} ${s.chipAudDur} ${panel === 'audduration' ? s.pfOn : ''}`} onClick={() => togglePanel('audduration')} title={`${ctrlLabel} · ${cur?.label ?? ''}`}>
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.4" /><path d="M8 5.5V8.5L10 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          <span className={s.modelChipValue}>{cur?.label ?? ''}</span>
                        </button>
                        {panel === 'audduration' && (
                          <div className={s.chipPop}>
                            <div className={s.chipPopHead}>{ctrlLabel}</div>
                            {tiers.map((t) => (
                              <button key={t.seconds} className={`${s.droplet} ${audDuration === t.seconds ? s.dropletOn : ''}`} onClick={() => { setAudDuration(t.seconds); setPanel(null) }}><span className={s.dropletName}>{t.label}</span></button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  {/* Audio Genre / Mood — standard chip selectors (music models only; hidden for TTS). Wired into the prompt. */}
                  {mode === 'audio' && audCfg?.taskType !== 'tts' && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${s.chipIV} ${panel === 'audgenre' ? s.pfOn : ''}`} onClick={() => togglePanel('audgenre')} title={`Genre · ${audGenre}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" /><circle cx="12" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" /><path d="M7 12V4l7-1.4v7.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        <span className={s.modelChipValue}>{audGenre === 'Auto' ? 'Genre' : `Genre: ${audGenre}`}</span>
                      </button>
                      {panel === 'audgenre' && (
                        <div className={`${s.chipPop} ${s.scroll}`} style={{ maxHeight: 260, overflowY: 'auto' }}>
                          <div className={s.chipPopHead}>Genre</div>
                          {AUDIO_GENRES.map((g) => (
                            <button key={g} className={`${s.droplet} ${audGenre === g ? s.dropletOn : ''}`} onClick={() => { setAudGenre(g); setPanel(null) }}><span className={s.dropletName}>{g}</span></button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {mode === 'audio' && audCfg?.taskType !== 'tts' && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${s.chipIV} ${panel === 'audmood' ? s.pfOn : ''}`} onClick={() => togglePanel('audmood')} title={`Mood · ${audMood}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 9.5s1 1.5 2.5 1.5 2.5-1.5 2.5-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="6" cy="6.6" r="0.7" fill="currentColor" /><circle cx="10" cy="6.6" r="0.7" fill="currentColor" /></svg>
                        <span className={s.modelChipValue}>{audMood === 'Auto' ? 'Mood' : `Mood: ${audMood}`}</span>
                      </button>
                      {panel === 'audmood' && (
                        <div className={`${s.chipPop} ${s.scroll}`} style={{ maxHeight: 260, overflowY: 'auto' }}>
                          <div className={s.chipPopHead}>Mood</div>
                          {AUDIO_MOODS.map((m) => (
                            <button key={m} className={`${s.droplet} ${audMood === m ? s.dropletOn : ''}`} onClick={() => { setAudMood(m); setPanel(null) }}><span className={s.dropletName}>{m}</span></button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Audio instrumental toggle — only for instrumental-capable models (ACE-Step + ElevenLabs Music). */}
                  {mode === 'audio' && audCfg?.instrumental && (
                    <button className={`${s.pfBtn} ${s.chipIV} ${aceInstrumental ? s.pfOn : ''}`} onClick={() => { setAceInstrumental((v) => !v); setPanel(null) }} title="Instrumental only — generate with no vocals/lyrics">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M6 11V4l7-1.5v7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><circle cx="4.3" cy="11" r="1.8" stroke="currentColor" strokeWidth="1.4" /><circle cx="11.3" cy="9.5" r="1.8" stroke="currentColor" strokeWidth="1.4" /></svg>
                      <span className={s.modelChipValue}>Instrumental{aceInstrumental ? ' · on' : ''}</span>
                    </button>
                  )}
                  {/* ACE-Step optional custom-lyrics chip (hidden when instrumental is on). */}
                  {mode === 'audio' && isAceStep && !aceInstrumental && (
                        <div className={s.chipWrap}>
                          <button className={`${s.pfBtn} ${s.chipIV} ${panel === 'acelyrics' ? s.pfOn : ''}`} onClick={() => togglePanel('acelyrics')} title="Optional lyrics — leave empty to let the style/tags drive the song">
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 3.5h10M3 7h10M3 10.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                            <span className={s.modelChipValue}>Lyrics{aceLyrics.trim() ? ' · added' : ' (optional)'}</span>
                          </button>
                          {panel === 'acelyrics' && (
                            <div className={s.chipPop} style={{ width: 300, maxWidth: '80vw' }}>
                              <div className={s.chipPopHead}>Lyrics (optional)</div>
                              <textarea
                                className={s.scroll}
                                value={aceLyrics}
                                onChange={(e) => setAceLyrics(e.target.value)}
                                placeholder="Write the song lyrics here, or leave empty to let the style/tags drive the song…"
                                rows={6}
                                style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, color: '#fff', fontSize: 12, lineHeight: 1.5, padding: 8, marginTop: 6 }}
                              />
                            </div>
                          )}
                        </div>
                  )}
                  {mode === 'image' && (
                    <div className={s.countChip} title={`${numImages <= imgMaxImages ? `${numImages} image${numImages > 1 ? 's' : ''} — single request` : `${numImages} images — ${Math.ceil(numImages / imgMaxImages)} requests of up to ${imgMaxImages}`}${genCost > 0 ? ` · ~${genCost} QLC` : ''}`}>
                      <button className={s.countBtn} onClick={() => setNumImages((n) => Math.max(1, n - 1))} disabled={numImages <= 1} aria-label="Fewer images">−</button>
                      <span className={s.countVal}>{numImages}/16</span>
                      <button className={s.countBtn} onClick={() => setNumImages((n) => Math.min(16, n + 1))} disabled={numImages >= 16} aria-label="More images">+</button>
                    </div>
                  )}
                  {mode === 'image' && (
                    <div className={s.chipWrap}>
                      {aspectOptions.length <= 1 ? (
                        /* Truthful fixed-aspect chip: some image models (e.g. Grok / grok-2-image, xAI) expose NO
                           provider aspect-ratio control, so we render a disabled "Fixed" chip instead of a fake
                           selector. No dropdown, no interaction — the user clearly sees the ratio is fixed. */
                        <button className={`${s.pfBtn} ${s.chipIV}`} disabled title="Aspect ratio is fixed for this model — the provider has no aspect-ratio control">
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" /></svg>
                          <span className={s.modelChipValue}>{currentAspect} (Fixed)</span>
                        </button>
                      ) : (
                        <>
                          <button className={`${s.pfBtn} ${s.chipIV} ${s.chipAspect} ${panel === 'aspect' ? s.pfOn : ''}`} onClick={() => togglePanel('aspect')} title={`Aspect · ${currentAspect}`}>
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" /></svg>
                            <span className={s.modelChipValue}>{currentAspect}</span>
                          </button>
                          {panel === 'aspect' && (
                            <div className={s.chipPop}>
                              <div className={s.chipPopHead}>Aspect Ratio</div>
                              {aspectOptions.map((opt) => (
                                <button key={opt} className={`${s.droplet} ${currentAspect === opt ? s.dropletOn : ''}`} onClick={() => { setAspect(opt); setPanel(null) }}>
                                  <span className={s.dropletName}>{opt}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {/* (Video controls now live in the ordered sequence above: Mode | Duration | Aspect | Quality | Audio | Start/End Frame.) */}
                  {mode === 'image' && imgSupportsQuality && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${s.chipIV} ${s.chipQuality} ${panel === 'quality' ? s.pfOn : ''}`} onClick={() => togglePanel('quality')} title={`Quality · ${imgQuality}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l1.8 4.4 4.7.4-3.6 3 1.1 4.6L8 11l-4 2.4 1.1-4.6-3.6-3 4.7-.4L8 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
                        <span className={s.modelChipValue}>{imgQuality}</span>
                      </button>
                      {panel === 'quality' && (
                        <div className={s.chipPop}>
                          <div className={s.chipPopHead}>Quality</div>
                          {IMG_QUALITY.map((opt) => (
                            <button key={opt} className={`${s.droplet} ${imgQuality === opt ? s.dropletOn : ''}`} onClick={() => { setImgQuality(opt); setPanel(null) }}>
                              <span className={s.dropletName}>{opt}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {mode === 'image' && imgSpeedTiers && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${s.chipIV} ${s.chipQuality} ${panel === 'imgspeed' ? s.pfOn : ''}`} onClick={() => togglePanel('imgspeed')} title={`Speed · ${imgSpeedTiers.find((t) => t.id === imgSpeed)?.label ?? imgSpeed}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8l1-5.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                        <span className={s.modelChipValue}>{imgSpeedTiers.find((t) => t.id === imgSpeed)?.label ?? imgSpeed}</span>
                      </button>
                      {panel === 'imgspeed' && (
                        <div className={s.chipPop}>
                          <div className={s.chipPopHead}>Speed</div>
                          {imgSpeedTiers.map((t) => (
                            <button key={t.id} className={`${s.droplet} ${imgSpeed === t.id ? s.dropletOn : ''}`} onClick={() => { setImgSpeed(t.id); setPanel(null) }}>
                              <span className={s.dropletName}>{t.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {mode === 'image' && imgResTiers && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${s.chipIV} ${s.chipQuality} ${panel === 'imgresolution' ? s.pfOn : ''}`} onClick={() => togglePanel('imgresolution')} title={`Resolution · ${imgResolution}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><path d="M5 8h6M8 5v6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
                        <span className={s.modelChipValue}>{imgResolution}</span>
                      </button>
                      {panel === 'imgresolution' && (
                        <div className={s.chipPop}>
                          <div className={s.chipPopHead}>Resolution</div>
                          {imgResTiers.map((t) => (
                            <button key={t.id} className={`${s.droplet} ${imgResolution === t.id ? s.dropletOn : ''}`} onClick={() => { setImgResolution(t.id); setPanel(null) }}>
                              <span className={s.dropletName}>{t.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {mode === 'image' && imgQualityTiers && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${s.chipIV} ${s.chipQuality} ${panel === 'imgquality' ? s.pfOn : ''}`} onClick={() => togglePanel('imgquality')} title={`Quality · ${imgQualityTiers.find((t) => t.id === imgGptQuality)?.label ?? imgGptQuality}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 13V8M8 13V3M13 13V6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        <span className={s.modelChipValue}>{imgQualityTiers.find((t) => t.id === imgGptQuality)?.label ?? imgGptQuality}</span>
                      </button>
                      {panel === 'imgquality' && (
                        <div className={s.chipPop}>
                          <div className={s.chipPopHead}>Quality</div>
                          {imgQualityTiers.map((t) => (
                            <button key={t.id} className={`${s.droplet} ${imgGptQuality === t.id ? s.dropletOn : ''}`} onClick={() => { setImgGptQuality(t.id); setPanel(null) }}>
                              <span className={s.dropletName}>{t.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {mode === 'image' && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${panel === 'style' ? s.pfOn : ''}`} onClick={() => togglePanel('style')} title={`Prompt style · ${imgStyle} (appended to the prompt — works on every model)`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" /><circle cx="5.8" cy="6.4" r="1" fill="currentColor" /></svg>
                        <span className={s.modelChipLabel}>Prompt Style</span><span className={s.modelChipValue}>{imgStyle}</span>
                      </button>
                      {panel === 'style' && (
                        <div className={s.chipPop}>
                          <div className={s.chipPopHead}>Prompt Style</div>
                          {IMG_STYLES.map((opt) => (
                            <button key={opt} className={`${s.droplet} ${imgStyle === opt ? s.dropletOn : ''}`} onClick={() => { setImgStyle(opt); setPanel(null) }}>
                              <span className={s.dropletName}>{opt}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Provider Style — capability-driven, REAL provider `style` enum (Ideogram V3 / Recraft V3 only).
                      Separate from Prompt Style; cost-neutral. Renders only when the selected model has styleOptions. */}
                  {mode === 'image' && imgStyleOptions && (
                    <div className={s.chipWrap}>
                      <button className={`${s.pfBtn} ${s.chipIV} ${s.chipQuality} ${panel === 'providerstyle' ? s.pfOn : ''}`} onClick={() => togglePanel('providerstyle')} title={`Provider style (${currentModelName}) · ${imgStyleOptions.find((o) => o.id === imgProviderStyle)?.label ?? 'default'}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 2a6 6 0 0 0 0 12c1 0 1.5-.6 1.5-1.3 0-.8-.7-1.2-.7-1.9 0-.5.4-.9 1-.9H11a3 3 0 0 0 3-3c0-2.8-2.7-4.9-6-4.9Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><circle cx="5.5" cy="7" r="0.9" fill="currentColor" /><circle cx="9" cy="5.2" r="0.9" fill="currentColor" /></svg>
                        <span className={s.modelChipValue}>{imgStyleOptions.find((o) => o.id === imgProviderStyle)?.label ?? 'Style'}</span>
                      </button>
                      {panel === 'providerstyle' && (
                        <div className={s.chipPop}>
                          <div className={s.chipPopHead}>Provider Style</div>
                          {imgStyleOptions.map((o) => (
                            <button key={o.id} className={`${s.droplet} ${imgProviderStyle === o.id ? s.dropletOn : ''}`} onClick={() => { setImgProviderStyle(o.id); setPanel(null) }}>
                              <span className={s.dropletName}>{o.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {mode === 'video' && (
                    <button className={`${s.pfBtn} ${panel === 'references' ? s.pfOn : ''}`} onClick={() => togglePanel('references')}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 11L6 7.5L8.5 10L11 7.5L13.5 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      Reference
                    </button>
                  )}
                  {mode === 'image' && imgSupportsReference && (
                    <button className={`${s.pfBtn} ${panel === 'references' ? s.pfOn : ''}`} onClick={() => togglePanel('references')} title={imgRefTooltip}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 11L6 7.5L8.5 10L11 7.5L13.5 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      {imgRefLabel}
                    </button>
                  )}
                  {mode === 'image' && !imgSupportsReference && (
                    <button className={s.pfBtn} disabled title={`References are available only on compatible models: ${refCapableNames}.`}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 11L6 7.5L8.5 10L11 7.5L13.5 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      Reference
                    </button>
                  )}
                  {mode === 'video' && (
                    <button className={`${s.pfBtn} ${panel === 'director' ? s.pfOn : ''}`} onClick={() => togglePanel('director')}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="3" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M1.5 6H14.5M5 3V6M10 3V6" stroke="currentColor" strokeWidth="1.3" /></svg>
                      Director
                    </button>
                  )}
                  {mode !== 'audio' && (
                    <button className={`${s.pfBtn} ${panel === 'advanced' ? s.pfOn : ''}`} onClick={() => togglePanel('advanced')}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                      Advanced
                    </button>
                  )}
                </div>
                {DEBUG_PAYLOADS && mode === 'video' && (
                  <button type="button" className={s.pfBtn} style={{ marginRight: 8, opacity: 0.85, alignSelf: 'center' }} title="DEV: preview the exact provider endpoint + payload (no provider call, no credits, no generation row)" onClick={() => void handleGenerate(true)} disabled={busy}>
                    Preview Payload
                  </button>
                )}
                <button className={`${s.genBtn} ${busy ? s.busy : ''}`} onClick={() => void handleGenerate()} disabled={busy || audOverLimit}>
                  {busy ? (
                    <>
                      <svg className={s.spinIcon} width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.22)" strokeWidth="2" /><path d="M8 2A6 6 0 0 1 14 8" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>
                      <span className={s.genBtnLabel}>Generating…</span>
                    </>
                  ) : (
                    <>
                      <span className={s.genBtnLabel}>Generate</span>
                      {genCost > 0 && <span className={s.genCostNum}>{genCost} QLC</span>}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
          {/* ══ WORKSPACE LAYER — freeform notes + dragged history assets (overlap + z-index) ══ */}
          <div className={s.workspaceLayer} ref={wsRef} style={lockedMode && !audioOnly ? { display: 'none' } : undefined}>
            <div className={s.notesTrigger} style={{ top: 350 }}>
              <span className={s.notesTriggerLabel}>Notes</span>
              <button className={s.notesTriggerPlus} onClick={addNote} aria-label="Add note" title="Add a note">+</button>
            </div>
            {wsItems.map((it) =>
              it.kind === 'note' ? (
                <div
                  key={it.id}
                  className={`${s.wsItem} ${s.wsNote} ${draggingId === it.id ? s.wsDragging : ''}`}
                  style={{ left: it.x, top: it.y, zIndex: it.z, transform: `rotate(${noteTilt(it.id)}deg)` }}
                  onPointerDown={(e) => wsPointerDown(e, it.id)}
                  onPointerMove={(e) => wsDragMove(e, it.id)}
                  onPointerUp={(e) => wsDragEnd(e, it.id)}
                  onPointerCancel={(e) => wsDragEnd(e, it.id)}
                >
                  <span className={s.wsPin} aria-hidden />
                  <div className={s.wsPaper}>
                    <div className={s.wsNoteBar}>
                      <button className={s.wsRemove} data-no-drag onClick={() => removeWsItem(it.id)} aria-label="Delete note">✕</button>
                    </div>
                    <textarea
                      className={s.wsNoteText}
                      data-no-drag
                      value={it.text}
                      placeholder="Write a note…"
                      onChange={(e) => updateNote(it.id, e.target.value)}
                    />
                  </div>
                </div>
              ) : (
                <div
                  key={it.id}
                  className={`${s.wsItem} ${s.wsAsset}`}
                  style={{ left: it.x, top: it.y, zIndex: it.z }}
                  onPointerDown={(e) => wsPointerDown(e, it.id)}
                  onPointerMove={(e) => wsDragMove(e, it.id)}
                  onPointerUp={(e) => wsDragEnd(e, it.id)}
                >
                  <button className={s.wsRemove} data-no-drag onClick={() => removeWsItem(it.id)} aria-label="Remove">✕</button>
                  {wsBroken.has(it.id) ? (
                    <div className={s.wsAudio} title="This generation is no longer available">
                      <span className={s.wsAudioLabel}>⚠ Media unavailable</span>
                    </div>
                  ) : it.assetType === 'image' ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img className={s.wsMedia} src={it.url} alt={it.prompt} draggable={false} onError={() => setWsBroken((p) => new Set(p).add(it.id))} />
                  ) : it.assetType === 'video' ? (
                    <video className={s.wsMedia} src={it.url} muted loop playsInline autoPlay onError={() => setWsBroken((p) => new Set(p).add(it.id))} />
                  ) : (
                    <div className={s.wsAudio}>
                      <button className={s.wsAudioBtn} data-no-drag onClick={() => toggleWsAudio(it.id, it.url)} aria-label={wsPlaying === it.id ? 'Pause' : 'Play'}>{wsPlaying === it.id ? '❚❚' : '▶'}</button>
                      <span className={s.wsAudioLabel}>{it.prompt || 'Audio'}</span>
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        </main>

        {/* ══ RIGHT PANEL ══ */}
        <aside className={s.rightPanel} ref={rightPanelRef}>
          {/* History header moved to the Playground topbar row; the dropdown still opens here in the right panel. */}
          {histOpen && (
            <div className={s.historyDrop}>
              <div className={`${s.historyList} ${s.scroll}`}>
                {histItems.length === 0 ? (
                  <div className={s.histEmpty}>Nothing yet</div>
                ) : (
                  <>
                    <div className={s.histGroupLabel}>Recent</div>
                    {histItems.map((h) => (
                      <HistoryItem key={h.id} item={h} onOpen={(it) => setPreviewItem(it)} onRemix={(p) => { setPrompt(p + ' — variation') }} onReuse={(p) => { setPrompt(p) }} />
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ══ HISTORY PREVIEW MODAL ══ */}
      {previewItem && (
        <HistoryPreview
          key={previewItem.id}
          item={previewItem}
          onClose={() => setPreviewItem(null)}
          onRemix={(it) => { setPrompt(it.prompt); setPreviewItem(null) }}
          onAdd={(it, url) => {
            if (!url) return
            if (mode === 'image') {
              // Reference pilot: flux2max (image ref) + ideogram (style ref); single PUBLIC reference (replace).
              if (!imgSupportsReference) { toast(`Reference is available only on compatible models: ${refCapableNames}`); return }
              // Use the SELECTED output image's URL (multi-output aware), or a Cinema Studio item's safe still — NEVER the mp4.
              const refUrl = it.type === 'image' ? url : (it.source === 'cinema_studio' ? it.stillUrl : undefined)
              if (!refUrl) { toast(it.source === 'cinema_studio' ? 'This Cinema clip has no reusable still yet' : 'Pick an image to use as a reference'); return }
              setRefs((r) => ({ ...r, image: [refUrl] }))
              setPreviewItem(null); return
            }
            if (mode === 'video') {
              // Video reference = an image url (generated image / upload / cinema still — never the mp4 when a still
              // exists). UI-level reference metadata + @image prompt helper, INDEPENDENT of Start/End frame support,
              // so it is never gated on frame capability.
              const refUrl = it.type === 'image'
                ? url
                : (it.source === 'cinema_studio' && it.stillUrl ? it.stillUrl : (it.type === 'video' ? url : undefined))
              if (!refUrl) { toast('Pick an image to use as a reference'); return }
              setRefs((r) => (r.video.includes(refUrl) ? r : { ...r, video: [...r.video, refUrl] }))
              setPreviewItem(null); return
            }
            toast('Reference not supported here')
          }}
          canStartFrame={mode === 'video' && !!vidControls?.startFrame && previewItem.type === 'image'}
          canEndFrame={mode === 'video' && !!vidControls?.endFrame && previewItem.type === 'image'}
          onStartFrame={(url) => { if (assignFrameUrl('start', url)) setPreviewItem(null) }}
          onEndFrame={(url) => { if (assignFrameUrl('end', url)) setPreviewItem(null) }}
        />
      )}

      {/* ══ TOASTS ══ */}
      <div className={s.toastArea}>
        {DEBUG_PAYLOADS && debugResult && (() => {
          const dr = debugResult as Record<string, unknown>
          const endpoint = String(dr.endpoint ?? '—')
          const credits = dr.credits
          const input = dr.input ?? dr
          const note = String(dr.note ?? '')
          const full = JSON.stringify(dr, null, 2)
          return (
            <div onClick={() => setDebugResult(null)} style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(5,5,12,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 95vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: '#0c0c16', border: '1px solid rgba(123,97,255,0.35)', borderRadius: 14, boxShadow: '0 24px 80px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e8f5' }}>Preview Payload <span style={{ color: '#7B61FF' }}>· DEV</span></span>
                  <button onClick={() => setDebugResult(null)} style={{ background: 'none', border: 'none', color: 'rgba(230,230,245,0.7)', fontSize: 18, cursor: 'pointer' }} aria-label="Close">✕</button>
                </div>
                <div style={{ padding: '12px 16px', overflow: 'auto' }}>
                  <div style={{ fontSize: 12, color: 'rgba(230,230,245,0.85)', marginBottom: 8, wordBreak: 'break-all' }}><b style={{ color: '#3BE7FF' }}>endpoint</b>&nbsp; {endpoint}</div>
                  <div style={{ fontSize: 12, color: 'rgba(230,230,245,0.85)', marginBottom: 10 }}><b style={{ color: '#3BE7FF' }}>QLC</b>&nbsp; {credits == null ? '—' : String(credits)}</div>
                  <pre style={{ margin: 0, padding: 12, background: '#07070e', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, fontSize: 11.5, lineHeight: 1.5, color: '#cfd2e6', overflow: 'auto', maxHeight: '48vh' }}>{JSON.stringify(input, null, 2)}</pre>
                  <div style={{ fontSize: 11, color: 'rgba(123,200,140,0.95)', marginTop: 10 }}>✓ No provider call. No QLC charged. No generation created.</div>
                  {note && <div style={{ fontSize: 11, color: 'rgba(230,230,245,0.55)', marginTop: 4 }}>{note}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <button onClick={() => { try { void navigator.clipboard.writeText(full); toast('Payload copied') } catch { toast('Copy failed') } }} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(123,97,255,0.4)', background: 'rgba(123,97,255,0.14)', color: '#e8e8f5', fontSize: 12, cursor: 'pointer' }}>Copy JSON</button>
                  <button onClick={() => setDebugResult(null)} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: 'rgba(230,230,245,0.85)', fontSize: 12, cursor: 'pointer' }}>Close</button>
                </div>
              </div>
            </div>
          )
        })()}
        {toasts.map((t) => <div key={t.id} className={s.toast}><div className={s.toastPip} />{t.msg}</div>)}
      </div>
    </div>
  )
}

// ── Small presentational helpers ──────────────────────────────────────────────

function FamilyIcon({ ids, models, logo }: { ids: string[]; models: QelarixModel[]; logo?: string }) {
  const m = models.find(model => ids.includes(model.id))
  const color = m ? (providerColor[m.provider] ?? '#7B61FF') : '#7B61FF'
  // Local provider PNG (forced white via CSS filter). If it's missing or fails to load, fall back to the colored initials.
  const [imgFailed, setImgFailed] = useState(false)
  const initials = !m ? '?' :
    m.provider === 'Black Forest Labs' ? 'BFL' :
    m.provider === 'Stability AI' || m.provider === 'Stability' ? 'SA' :
    m.provider === 'ElevenLabs' ? '11' :
    m.provider === 'Luma AI' ? 'Lu' :
    m.provider === 'Kuaishou' ? 'Kl' :
    m.provider === 'ByteDance' ? 'BD' :
    m.provider === 'ACE-Step' ? 'AC' :
    m.provider.slice(0, 2).toUpperCase()
  return (
    <span className={s.familyIcon} style={{ background: `${color}18`, borderColor: `${color}30` }}>
      {logo && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" aria-hidden className={s.familyLogoImg} onError={() => setImgFailed(true)} />
      ) : (
        <span style={{ color, fontSize: '11px', fontWeight: 800, letterSpacing: '-0.3px' }}>{initials}</span>
      )}
    </span>
  )
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ProviderBadge({ provider }: { provider: string }) {
  const bg = providerColor[provider] ?? 'rgba(123,97,255,0.4)'
  const initials = provider === 'Black Forest Labs' ? 'BFL'
    : provider === 'Stability AI' || provider === 'Stability' ? 'SA'
    : provider === 'ElevenLabs' ? '11'
    : provider === 'Luma AI' ? 'Luma'
    : provider === 'Kuaishou' ? 'Kling'
    : provider === 'ByteDance' ? 'BD'
    : provider === 'ACE-Step' ? 'ACE'
    : provider.slice(0, 3)
  return <span className={s.providerBadge} style={{ background: bg }}>{initials}</span>
}

function ModelPicker({ models, currentId, onSelect, mode, userPlan, onToast }: {
  models: QelarixModel[]
  currentId: string
  onSelect: (id: string) => void
  mode: 'image' | 'video' | 'audio'
  userPlan: string
  onToast: (msg: string) => void
}) {
  const [hoveredFamily, setHoveredFamily] = useState<string | null>(null)
  const [submenuTop, setSubmenuTop] = useState(0)
  const layoutRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const families = PICKER_FAMILIES[mode]
  const featuredIds = PICKER_FEATURED[mode]
  const featuredModels = featuredIds.map(id => models.find(m => m.id === id)).filter(Boolean) as QelarixModel[]
  const activeFamilyId = hoveredFamily ?? families[0]?.id
  const activeFamilyModels = models.filter(m => families.find(f => f.id === activeFamilyId)?.ids.includes(m.id))

  // Align the floating submenu with the active family row (fixes "submenu pinned to the top").
  // Clamp so a low family's submenu can't spill past the bottom of the picker.
  useLayoutEffect(() => {
    const row = activeRowRef.current, layout = layoutRef.current, pane = paneRef.current
    if (!row || !layout) return
    const layoutRect = layout.getBoundingClientRect()
    const desired = row.getBoundingClientRect().top - layoutRect.top
    const paneH = pane ? pane.getBoundingClientRect().height : 0
    const maxTop = Math.max(0, layoutRect.height - paneH)
    setSubmenuTop(Math.max(0, Math.min(desired, maxTop)))
  }, [activeFamilyId, mode])

  return (
    <div className={s.modelFrame}>
      <div className={s.modelPickerLayout} ref={layoutRef}>
        {/* Left: Featured + Family nav */}
        <div className={s.modelFamilyNav}>
          {featuredModels.length > 0 && (
            <>
              <div className={s.modelSectionHead}>Featured</div>
              {featuredModels.map(m => {
                const locked = !canAccessModel(userPlan as PlanId, m.id)
                const fam = families.find(f => f.ids.includes(m.id))
                const metaParts = featuredMetaParts(m)
                return (
                  <button key={m.id} className={`${s.familyRow} ${currentId === m.id ? s.pickerRowOn : ''}`} style={locked ? { opacity: 0.55 } : undefined} onClick={() => { onSelect(m.id); if (locked) onToast(`${m.name} is not available yet`) }} title={locked ? `${m.name} — requires a higher plan` : (m.description ?? m.name)}>
                    <FamilyIcon ids={[m.id]} models={models} logo={fam?.logo} />
                    <span className={s.familyRowInfo}>
                      <span className={s.familyRowName}>{m.name}</span>
                      {metaParts.length > 0 && <span className={s.familyRowDesc}>{metaParts.join(' · ')}</span>}
                    </span>
                    {locked ? <span className={`${s.modelBadge} ${s.badgeLock}`}><QIcon name="lock" size={11} /></span>
                      : (m.badges[0] && <span className={`${s.modelBadge} ${modelBadgeClass(m.badges[0])}`}>{m.badges[0]}</span>)}
                  </button>
                )
              })}
              <div className={s.modelSectionHead} style={{ marginTop: 4 }}>All Models</div>
            </>
          )}
          {!featuredModels.length && <div className={s.modelSectionHead}>All Models</div>}
          {families.map(f => (
            <button key={f.id} ref={activeFamilyId === f.id ? activeRowRef : undefined} className={`${s.familyRow} ${activeFamilyId === f.id ? s.familyRowOn : ''}`} onMouseEnter={() => setHoveredFamily(f.id)} onClick={() => setHoveredFamily(f.id)}>
              <FamilyIcon ids={f.ids} models={models} logo={f.logo} />
              <span className={s.familyRowInfo}>
                <span className={s.familyRowName}>{f.label}</span>
                <span className={s.familyRowDesc}>{f.desc}</span>
              </span>
              <span className={s.familyArrow}>›</span>
            </button>
          ))}
        </div>
        {/* Right: compact flat model list for active family — opens beside the hovered row */}
        {activeFamilyModels.length > 0 && (
          <div className={s.modelFamilyPane} ref={paneRef} style={{ top: submenuTop }}>
            <div className={s.modelFamilyPaneHead}>{families.find(f => f.id === activeFamilyId)?.label}</div>
            {activeFamilyModels.map(m => {
              const locked = !canAccessModel(userPlan as PlanId, m.id)
              const caps = modelCardCaps(m)
              const metaParts = [caps.dur, caps.res, caps.audio ? 'Audio' : null].filter(Boolean) as string[]
              return (
                <button key={m.id} className={`${s.subRow} ${currentId === m.id ? s.subRowOn : ''}`} style={locked ? { opacity: 0.55 } : undefined} onClick={() => { onSelect(m.id); if (locked) onToast(`${m.name} is not available yet`) }} title={locked ? `${m.name} — requires a higher plan` : (m.description ?? m.name)}>
                  <span className={s.subRowTop}>
                    <span className={s.subRowName}>{m.name}</span>
                    {locked ? <span className={`${s.modelBadge} ${s.badgeLock}`}><QIcon name="lock" size={11} /></span>
                      : (m.badges[0] && <span className={`${s.modelBadge} ${modelBadgeClass(m.badges[0])}`}>{m.badges[0]}</span>)}
                  </span>
                  {metaParts.length > 0 && (
                    <span className={s.subRowMeta}>{metaParts.join(' · ')}</span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// Mode-specific animated empty-state hero (no active result / not generating).
// CSS-only animation; one short inspirational slogan per mode. Decorative (aria-hidden art).
function ModeHero({ mode }: { mode: Mode }) {
  if (mode === 'video') {
    return (
      <div className={s.hero}>
        <div className={`${s.heroStage} ${s.heroVideo}`} aria-hidden>
          <div className={s.heroGlow} />
          <div className={s.vidSweep} />
          <div className={`${s.vidRing} ${s.vidRing1}`} />
          <div className={`${s.vidRing} ${s.vidRing2}`} />
          <div className={s.vidCore}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M9 7.2L17.2 12L9 16.8V7.2Z" fill="rgba(233,229,255,0.96)" />
            </svg>
          </div>
        </div>
        <div className={s.heroSlogan}>Turn moments into motion.</div>
      </div>
    )
  }
  if (mode === 'audio') {
    return (
      <div className={s.hero}>
        <div className={`${s.heroStage} ${s.heroAudio}`} aria-hidden>
          <div className={s.heroGlow} />
          <div className={`${s.aoRing} ${s.aoRing1}`} />
          <div className={`${s.aoRing} ${s.aoRing2}`} />
          <div className={`${s.aoRing} ${s.aoRing3}`} />
          <div className={s.aoCore}>
            <div className={s.aoVis}>
              {Array.from({ length: 18 }).map((_, i) => (
                <div
                  key={i}
                  className={s.aoBar}
                  style={{ height: 6 + Math.abs(Math.sin(i * 0.6) * 26), animationDelay: `${i * 0.08}s`, animationDuration: `${1.1 + (i % 5) * 0.16}s` }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className={s.heroSlogan}>Give silence a pulse.</div>
      </div>
    )
  }
  // image — small animated card stack; real Qelarix asset lives inside the front card
  return (
    <div className={s.hero}>
      <div className={`${s.heroStage} ${s.heroImage}`} aria-hidden>
        <div className={s.heroGlow} />
        <div className={`${s.imgCard} ${s.imgCardB}`} />
        <div className={`${s.imgCard} ${s.imgCardA}`} />
        <div
          className={`${s.imgCard} ${s.imgCardFront}`}
          style={{ backgroundImage: "url('/playground/qelarix_image_088.png')" }}
        >
          <div className={s.imgShine} />
        </div>
      </div>
      <div className={s.heroSlogan}>Imagine it. Shape it.</div>
    </div>
  )
}

// Audio knob / DJ-mixer experiment fully removed — the audio composer now uses the same standard chip/dropdown
// controls as image/video (Model · Duration · Instrumental · Lyrics in the composer footer). ArcKnob/HalfKnob/DJKnob,
// the genre/mood/length/vocal knobs, the waveform panel, and the AudioStudio empty-state were all deleted.

// RefSection removed — references now live in the prompt-bar floating panel (see References panel).

// Shared image-only zoom: hover zoom cursor + hint, click → enlarged preview PORTALED to <body> (escapes the
// .genCanvas stacking context so it sits above the floating composer). Close via ✕ / backdrop / Escape.
// Single source used by ActiveResult AND BulkPanel — the zoom logic is never duplicated.
function ZoomableImage({ src, alt, imgClassName }: { src: string; alt: string; imgClassName?: string }) {
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])
  if (!src) return null
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className={imgClassName ? `${s.zoomable} ${imgClassName}` : s.zoomable} onClick={() => setZoom(true)} />
      <span className={s.zoomHint} aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" /><path d="M10.5 10.5L14 14M5 7h4M7 5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></span>
      {zoom && typeof document !== 'undefined' && createPortal(
        <div className={s.zoomOverlay} onClick={() => setZoom(false)} role="dialog" aria-modal="true">
          <button className={s.zoomClose} onClick={() => setZoom(false)} aria-label="Close preview">✕</button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={s.zoomImg} src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
        </div>,
        document.body,
      )}
    </>
  )
}

function ActiveResult({ item, canRef, onReuse, onUseRef, onClose }: {
  item: GenItem; canRef: boolean; onReuse: (p: string) => void; onUseRef: (url: string) => void; onClose: () => void
}) {
  // Multi-output (image only): surface ALL returned images. The selected thumb is the primary preview and the
  // target of Download / Use-as-reference. Video/audio always return one output, so the grid never shows for them.
  const imgs = item.type === 'image' && item.urls && item.urls.length > 0 ? item.urls : (item.url ? [item.url] : [])
  const [sel, setSel] = useState(0)
  const multi = item.type === 'image' && imgs.length > 1
  // Truthful output duration: read the ACTUAL loaded <video> element's duration (never the stale selected/model-card
  // duration). Set on loadedmetadata; null until known or if unavailable (so old items / images never show a wrong value).
  const [vidDur, setVidDur] = useState<number | null>(null)
  const activeUrl = imgs[Math.min(sel, imgs.length - 1)] ?? item.url
  const dlExt = item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'mp3' : 'png'
  const fileName = `qelarix-${item.type}-${item.id}${multi ? `-${sel + 1}` : ''}.${dlExt}`
  const promptEl = item.prompt ? <div className={s.activePrompt}>{item.prompt}</div> : null
  const actionsEl = (
    <div className={s.activeActions}>
      {activeUrl && (
        <button className={`${s.actBtn} ${s.actBtnPrimary}`} onClick={() => downloadAsset(activeUrl, fileName)}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1.5V10.5M4.5 7L8 10.5L11.5 7M2.5 13.5H13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {multi ? `Download #${sel + 1}` : 'Download'}
        </button>
      )}
      {multi && (
        <button className={s.actBtn} onClick={() => downloadAssets(imgs, `qelarix-${item.type}-${item.id}`)} title="Downloads each image separately.">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1.5V10.5M4.5 7L8 10.5L11.5 7M2.5 13.5H13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Download all ({imgs.length})
        </button>
      )}
      <button className={s.actBtn} onClick={() => onReuse(item.prompt)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 1 1.6 3.7M3 12.5V8.5H7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Reuse prompt
      </button>
      {canRef && activeUrl && (
        <button className={s.actBtn} onClick={() => onUseRef(activeUrl)}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 11L6 7.5L8.5 10L11 7.5L13.5 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {multi ? `Use #${sel + 1} as reference` : 'Use as reference'}
        </button>
      )}
    </div>
  )
  // Audio: single column (player + info). Image/video: media (left) + info/actions side panel (right) so the prompt
  // and actions are never hidden behind the bottom prompt composer (.promptArea is absolute/floating over the canvas).
  if (item.type === 'audio') {
    return (
      <div className={s.activeResult}>
        <div className={s.activeAudio}>
          <div className={s.activeWave} aria-hidden="true">
            {Array.from({ length: 28 }).map((_, i) => (
              <span key={i} className={s.activeWaveBar} style={{ height: 8 + Math.abs(Math.sin(i * 0.5) * 30), animationDelay: `${i * 0.05}s` }} />
            ))}
          </div>
          {item.url && <audio src={item.url} controls className={s.activeAudioPlayer} />}
        </div>
        {promptEl}
        {actionsEl}
      </div>
    )
  }
  return (
    <div className={`${s.activeResult} ${s.activeSplit}`}>
      <div className={s.activeMediaCol}>
        <div className={s.activeMedia}>
          {item.type === 'video' && (
            <button className={s.activeClose} onClick={onClose} aria-label="Close preview" title="Close preview">✕</button>
          )}
          {item.type === 'video'
            ? <video src={activeUrl} controls playsInline preload="metadata" onLoadedMetadata={(e) => { const d = e.currentTarget.duration; setVidDur(Number.isFinite(d) && d > 0 ? Math.round(d) : null) }} />
            : activeUrl ? <ZoomableImage src={activeUrl} alt={item.prompt} /> : null}
        </div>
        {/* Multi-image selector: click a thumb to make it the primary preview + the Download/Use-as-reference target. */}
        {multi && (
          <div className={s.resultGrid}>
            {imgs.map((u, i) => (
              <button key={i} className={`${s.stripThumb} ${i === sel ? s.active : ''}`} onClick={() => setSel(i)} title={`Image ${i + 1} of ${imgs.length}`} aria-label={`Show image ${i + 1}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt={`Output ${i + 1}`} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={s.activeInfoCol}>
        {item.type === 'video' && vidDur != null && (
          <div style={{ fontSize: 12, color: '#b8a9f0', fontWeight: 600 }}>Duration · {vidDur}s</div>
        )}
        {promptEl}
        {actionsEl}
      </div>
    </div>
  )
}

function StripThumb({ item, active, onClick }: { item: GenItem; active: boolean; onClick: () => void }) {
  const count = item.type === 'image' && item.urls ? item.urls.length : 1
  return (
    <button className={`${s.stripThumb} ${active ? s.active : ''}`} onClick={onClick} title={count > 1 ? `${item.prompt} — ${count} images` : item.prompt}>
      {item.type === 'audio'
        ? <div className={s.stripAudio}><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M8 1.5V14.5M5 4V12M11 4V12M2 6.5V9.5M14 6.5V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></div>
        : item.type === 'video'
        ? <video src={item.url} muted playsInline />
        /* eslint-disable-next-line @next/next/no-img-element */
        : <img src={item.url} alt={item.prompt} />}
      {count > 1 && <span className={s.multiBadge}>×{count}</span>}
    </button>
  )
}

// Bulk Generation v1 — combined batch result + live progress. Reuses the multi-output grid (selectable primary).
function BulkPanel({ bulk, canRef, onReuse, onUseRef, onRetry, onClear }: {
  bulk: BulkState; canRef: boolean; onReuse: (p: string) => void; onUseRef: (url: string) => void; onRetry: () => void; onClear: () => void
}) {
  const [sel, setSel] = useState(0)
  const doneImages = bulk.urls.length
  const failedImages = bulk.jobs.filter((j) => j.status === 'failed').reduce((a, j) => a + j.n, 0)
  const runningJobs = bulk.jobs.filter((j) => j.status === 'running').length
  const pct = bulk.total > 0 ? Math.min(100, Math.round((doneImages / bulk.total) * 100)) : 0
  const activeUrl = bulk.urls[Math.min(sel, Math.max(0, bulk.urls.length - 1))]
  return (
    <div className={`${s.activeResult} ${s.bulkResult}`}>
      <div className={s.bulkHead}>
        <div className={s.bulkCount}>
          {bulk.active ? `Generating ${doneImages} / ${bulk.total}` : `Batch complete — ${doneImages} / ${bulk.total}`}
          {failedImages > 0 && <span className={s.bulkFailed}> · {failedImages} failed</span>}
        </div>
        <div className={s.bulkBar}><div className={s.bulkBarFill} style={{ width: `${pct}%` }} /></div>
        {bulk.active && <div className={s.bulkNote}>{runningJobs} request{runningJobs !== 1 ? 's' : ''} running · {bulk.modelName}</div>}
      </div>

      {activeUrl && (
        <div className={s.activeMedia}>
          <ZoomableImage src={activeUrl} alt={bulk.prompt} />
        </div>
      )}

      {(bulk.urls.length > 0 || failedImages > 0) && (
        <div className={s.resultGrid}>
          {bulk.urls.map((u, i) => (
            <button key={i} className={`${s.stripThumb} ${i === sel ? s.active : ''}`} onClick={() => setSel(i)} title={`Image ${i + 1} of ${bulk.urls.length}`} aria-label={`Show image ${i + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt={`Output ${i + 1}`} />
            </button>
          ))}
          {Array.from({ length: failedImages }).map((_, i) => (
            <div key={`f${i}`} className={s.bulkSlotFailed} title="This image failed — use “Retry failed”">✕</div>
          ))}
        </div>
      )}

      {bulk.prompt && <div className={s.activePrompt}>{bulk.prompt}</div>}

      <div className={s.activeActions}>
        {activeUrl && (
          <button className={`${s.actBtn} ${s.actBtnPrimary}`} onClick={() => downloadAsset(activeUrl, `qelarix-image-${bulk.batchId}-${sel + 1}.png`)}>Download #{sel + 1}</button>
        )}
        {bulk.urls.length > 1 && (
          <button className={s.actBtn} onClick={() => downloadAssets(bulk.urls, `qelarix-image-${bulk.batchId}`)} title="Downloads each completed image separately.">Download all ({bulk.urls.length})</button>
        )}
        <button className={s.actBtn} onClick={() => onReuse(bulk.prompt)}>Reuse prompt</button>
        {canRef && activeUrl && <button className={s.actBtn} onClick={() => onUseRef(activeUrl)}>Use #{sel + 1} as reference</button>}
        {!bulk.active && failedImages > 0 && <button className={s.actBtn} onClick={onRetry}>Retry failed ({failedImages})</button>}
        {!bulk.active && <button className={s.actBtn} onClick={onClear}>Clear</button>}
      </div>
    </div>
  )
}

function HistoryItem({ item, onRemix, onReuse, onOpen }: { item: HistItem; onRemix: (p: string) => void; onReuse: (p: string) => void; onOpen: (item: HistItem) => void }) {
  const isAudio = item.type === 'audio'
  const isVideo = item.type === 'video'
  const badgeClass = isAudio ? s.badgeAudio : isVideo ? s.badgeVideo : s.badgeImage
  const isCinema = item.source === 'cinema_studio'
  const imgCount = item.type === 'image' && item.urls ? item.urls.length : 1

  return (
    <div
      className={s.histItem}
      onClick={() => onOpen(item)}
      title={item.prompt}
      draggable={!!item.url}
      onDragStart={(e) => {
        if (!item.url) return
        // Drag a history asset into the center workspace (freeform idea board). Local UI only.
        e.dataTransfer.setData('application/qelarix-asset', JSON.stringify({ type: item.type, url: item.url, prompt: item.prompt }))
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <div className={`${s.histThumb} ${isAudio ? s.audioThumb : ''}`}>
        {isAudio ? (
          <div className={s.waveform}>
            {Array.from({ length: 13 }).map((_, i) => (
              <div key={i} className={s.wbar} style={{ height: 5 + Math.abs(Math.sin(i * 0.7 + 1) * 14), animationDelay: `${i * 0.07}s` }} />
            ))}
          </div>
        ) : item.url ? (
          isVideo
            ? <video className={s.histThumbInner} src={item.url} muted playsInline />
            /* eslint-disable-next-line @next/next/no-img-element */
            : <img className={s.histThumbInner} src={item.url} alt={item.prompt} />
        ) : (
          <div className={s.thumbPlaceholder}>
            {isVideo
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" /><path d="M17 9.5L21 7V17L17 14.5V9.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="8.5" cy="9" r="1.8" fill="currentColor" /><path d="M3.5 17L9 11.5L13 15L16.5 12L20.5 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </div>
        )}
        <span className={`${s.histBadge} ${badgeClass}`}>
          {isAudio
            ? <><svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M2 3V7M5 1.5V8.5M8 4V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>Audio</>
            : isVideo
            ? <><svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><path d="M1.5 1L7 4L1.5 7V1Z" /></svg>Video</>
            : <>Image</>}
        </span>
        {imgCount > 1 && <span className={s.multiBadge}>×{imgCount}</span>}
      </div>
      <div className={s.histInfo}>
        <div className={s.histPrompt}>{item.prompt || (isAudio ? 'Audio clip' : 'Untitled')}</div>
        <div className={s.histMeta}>
          <span className={s.histTag}>{item.model || item.type}</span>
          {/* Source label shows ONLY for the Cinema Studio exception — Playground is the implicit default (no per-card noise). */}
          {isCinema && <span className={`${s.histSource} ${s.histSourceCinema}`}>Cinema Studio</span>}
          <span className={s.histTime}>{relTime(item.createdAt)}</span>
        </div>
      </div>
      <div className={s.histActions}>
        {item.url && <button className={s.ha} onClick={(e) => { e.stopPropagation(); downloadAsset(item.url!, `qelarix-${item.type}-${item.id}.${item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'mp3' : 'png'}`) }}>Save</button>}
        <button className={s.ha} onClick={(e) => { e.stopPropagation(); onRemix(item.prompt) }}>Remix</button>
        <button className={s.ha} onClick={(e) => { e.stopPropagation(); onReuse(item.prompt) }}>Reuse</button>
      </div>
    </div>
  )
}

// Centered glowing-glass preview modal "pulled" from a History item. Local UI only — no backend.
function HistoryPreview({ item, onClose, onRemix, onAdd, canStartFrame, canEndFrame, onStartFrame, onEndFrame }: {
  item: HistItem
  onClose: () => void
  onRemix: (item: HistItem) => void
  onAdd: (item: HistItem, url: string) => void
  canStartFrame?: boolean
  canEndFrame?: boolean
  onStartFrame?: (url: string) => void
  onEndFrame?: (url: string) => void
}) {
  const isAudio = item.type === 'audio'
  const isVideo = item.type === 'video'
  const typeLabel = isAudio ? 'AUDIO' : isVideo ? 'VIDEO' : 'IMAGE'
  const badgeClass = isAudio ? s.badgeAudio : isVideo ? s.badgeVideo : s.badgeImage
  // Multi-output (image only): all parsed URLs; the selected thumb drives the large preview + reference/open targets.
  const imgs = item.type === 'image' && item.urls && item.urls.length > 0 ? item.urls : (item.url ? [item.url] : [])
  const [sel, setSel] = useState(0)
  const selectedUrl = imgs[Math.min(sel, imgs.length - 1)] ?? item.url
  const multi = item.type === 'image' && imgs.length > 1
  // Truthful duration from the ACTUAL loaded <video> element (preview modal) — never the stale selected/model duration.
  const [pvDur, setPvDur] = useState<number | null>(null)
  const canAdd = !isAudio && !!selectedUrl // reference-add applies to image/video only
  const originLabel = item.source === 'cinema_studio' ? 'Cinema Studio' : 'Playground'

  return (
    <div className={s.pvOverlay} onClick={onClose} role="dialog" aria-modal="true">
      <div className={s.pvModal} onClick={(e) => e.stopPropagation()}>
        <button className={s.pvClose} onClick={onClose} aria-label="Close">✕</button>

        {/* LEFT — media preview */}
        <div className={s.pvMedia}>
          {isAudio ? (
            <div className={s.pvAudio}>
              <div className={s.pvAudioOrb} aria-hidden>
                <div className={s.pvWave}>
                  {Array.from({ length: 22 }).map((_, i) => (
                    <div key={i} className={s.pvWbar} style={{ height: 8 + Math.abs(Math.sin(i * 0.6) * 34), animationDelay: `${i * 0.06}s` }} />
                  ))}
                </div>
              </div>
              {item.url && <audio className={s.pvAudioPlayer} src={item.url} controls />}
            </div>
          ) : isVideo ? (
            item.url
              ? <>
                  <video className={s.pvVideo} src={item.url} controls playsInline preload="metadata" onLoadedMetadata={(e) => { const d = e.currentTarget.duration; setPvDur(Number.isFinite(d) && d > 0 ? Math.round(d) : null) }} />
                  {pvDur != null && <div style={{ fontSize: 12, color: '#b8a9f0', fontWeight: 600, marginTop: 6, textAlign: 'center' }}>Duration · {pvDur}s</div>}
                </>
              : <div className={s.pvPlaceholder} aria-hidden><svg width="40" height="40" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" /><path d="M17 9.5L21 7V17L17 14.5V9.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg></div>
          ) : (
            selectedUrl ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', width: '100%', minHeight: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={s.pvImage} src={selectedUrl} alt={item.prompt} />
                {multi && (
                  <div className={s.resultGrid}>
                    {imgs.map((u, i) => (
                      <button key={i} className={`${s.stripThumb} ${i === sel ? s.active : ''}`} onClick={() => setSel(i)} title={`Image ${i + 1} of ${imgs.length}`} aria-label={`Show image ${i + 1}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={u} alt={`Output ${i + 1}`} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : <div className={s.pvPlaceholder} aria-hidden><svg width="40" height="40" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="8.5" cy="9" r="1.8" fill="currentColor" /><path d="M3.5 17L9 11.5L13 15L16.5 12L20.5 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
          )}
        </div>

        {/* RIGHT — info panel */}
        <div className={s.pvInfo}>
          <span className={`${s.pvBadge} ${badgeClass}`}>{typeLabel}</span>

          <div className={s.pvField}>
            <div className={s.pvLabel}>Prompt</div>
            <div className={s.pvPrompt}>{item.prompt || '—'}</div>
          </div>
          <div className={s.pvField}>
            <div className={s.pvLabel}>Model</div>
            <div className={s.pvValue}>{item.model || item.type}</div>
          </div>
          <div className={s.pvField}>
            <div className={s.pvLabel}>Origin</div>
            <div className={`${s.pvValue} ${item.source === 'cinema_studio' ? s.histSourceCinema : ''}`}>{originLabel}</div>
          </div>
          <div className={s.pvField}>
            <div className={s.pvLabel}>Created</div>
            <div className={s.pvValue}>{relTime(item.createdAt)}</div>
          </div>
          {selectedUrl && (
            <div className={s.pvField}>
              <div className={s.pvLabel}>File{multi ? ` (${sel + 1} of ${imgs.length})` : ''}</div>
              <a className={s.pvLink} href={selectedUrl} target="_blank" rel="noreferrer">Open original ↗</a>
            </div>
          )}
          {item.source === 'cinema_studio' && item.stillUrl && (
            <div className={s.pvStillNote}>Includes a still image (thumbnail) you can reuse as an image reference — not the video itself.</div>
          )}

          <div className={s.pvActions}>
            {canAdd && <button className={s.pvAdd} onClick={() => onAdd(item, selectedUrl!)}>{multi ? `Use #${sel + 1} as reference` : 'Use as reference'}</button>}
            {canStartFrame && selectedUrl && <button className={s.pvRemix} onClick={() => onStartFrame?.(selectedUrl)}>Use as Start Frame</button>}
            {canEndFrame && selectedUrl && <button className={s.pvRemix} onClick={() => onEndFrame?.(selectedUrl)}>Use as End Frame</button>}
            {selectedUrl && <button className={s.pvRemix} onClick={() => downloadAsset(selectedUrl, `qelarix-${item.type}-${item.id}${multi ? `-${sel + 1}` : ''}.${item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'mp3' : 'png'}`)}>{multi ? `Download #${sel + 1}` : 'Download'}</button>}
            {multi && <button className={s.pvRemix} onClick={() => downloadAssets(imgs, `qelarix-${item.type}-${item.id}`)} title="Downloads each image separately.">Download all ({imgs.length})</button>}
            <button className={s.pvRemix} onClick={() => onRemix(item)}>Reuse prompt</button>
          </div>
        </div>
      </div>
    </div>
  )
}
