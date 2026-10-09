import { getModelById, type AspectRatio } from './video-models'

/**
 * Prompt-only video capability descriptor — a thin, READ-ONLY view derived from the single
 * source of truth (`src/lib/video-models.ts`). Keyed by the runtime video model slug, which is
 * the same key used by the Playground `VIDEO_MODEL_IDS` bridge and by `VIDEO_PRICES` / the
 * `creditKey` in `credits.ts`.
 *
 * It captures ONLY prompt-only reusable truth: endpoint, truthful durations, truthful aspect
 * ratios, and whether the model produces audio. It deliberately contains NO scene / timeline /
 * reference / continuity / start-end-frame logic — those stay Cinema-Studio-specific.
 *
 * Nothing here is invented: every value is read straight from `video-models.ts` (which already
 * holds the verified per-model truth). Cinema Studio may later consume the same descriptor, but
 * this module changes no runtime behavior on its own.
 */
export interface VideoPromptCapability {
  /** runtime slug (e.g. 'kling3pro', 'ltx2') — matches VIDEO_PRICES key */
  id: string
  /** human label from the registry */
  label: string
  /** served provider endpoint (null for unmapped/coming-soon) */
  endpoint: string | null
  /** truthful, model-supported durations (seconds) */
  durations: number[]
  /** truthful, model-supported aspect ratios */
  aspects: AspectRatio[]
  /** whether the model truly produces audio (drives with_audio + cost audio column) */
  hasAudio: boolean
}

/** Read the prompt-only capability view for a runtime video slug, or undefined if unknown. */
export function getVideoCapability(runtimeSlug: string): VideoPromptCapability | undefined {
  const m = getModelById(runtimeSlug)
  if (!m) return undefined
  return {
    id: m.id,
    label: m.label,
    endpoint: m.falEndpoint,
    durations: m.durations,
    aspects: m.aspectRatios,
    hasAudio: m.hasAudio,
  }
}

/**
 * In-prompt-box video CONTROL capabilities (Playground v1.2 foundation). Capability-driven: a control
 * renders ONLY when this descriptor says the selected model supports it — never blindly global.
 *
 * Advanced flags (quality tiers, audio toggle, image-ref / start / end frame, extra workflow modes) are
 * read from the registry's optional capability fields, which are intentionally UNSET right now so no
 * non-functional control ships. The merge/wiring task populates them per-model as each control becomes
 * truthfully functional. `audioIncluded` is the one value derived live from existing truth (read-only).
 */
export type VideoWorkflowMode =
  | 'text-to-video'
  | 'image-to-video'
  | 'first-last-frame'
  | 'extend-video'
  | 'reference-to-video'

export interface VideoControlCapabilities {
  /** in-box resolution choices; Quality selector shows when length > 1 */
  qualityOptions: string[]
  /** interactive audio on/off toggle (vs. fixed) */
  audioToggle: boolean
  /** audio is fixed/included ⇒ show a read-only "Audio" indicator (no toggle) */
  audioIncluded: boolean
  /** image-reference input slot supported */
  imageReference: boolean
  /** max selectable image references (reference-to-video, e.g. Kling O1 → image_urls[]); 1 = single, 0 = none */
  maxImageReferences: number
  /** start-frame input slot supported */
  startFrame: boolean
  /** end-frame input slot supported */
  endFrame: boolean
  /** workflow modes supported (always includes 'text-to-video') */
  modes: VideoWorkflowMode[]
}

/** Endpoints whose fal input schema exposes a real `generate_audio` on/off param — VERIFIED via fal OpenAPI 2026-06-02.
 *  Veo 2/3/3.1 (+ Fast / First-Last-Frame), Kling v2.1/v2.6/v3, and Seedance 2.0 / Fast / 1.5 accept it. Sora 2 / Sora 2
 *  Pro and Grok Imagine Video do NOT (native audio, always on — no off param), so they must NOT show a (fake) toggle. */
function providerSupportsAudioOff(endpoint?: string | null): boolean {
  if (!endpoint) return false
  if (/veo2|veo3/.test(endpoint)) return true
  if (/kling-video\/(v2\.1|v2\.6|v3)/.test(endpoint)) return true
  if (/seedance-2\.0|seedance\/v2|seedance\/v1\.5/.test(endpoint)) return true
  return false
}

/** Read the in-box control capabilities for a runtime video slug, or undefined if unknown. */
export function getVideoControls(runtimeSlug: string): VideoControlCapabilities | undefined {
  const m = getModelById(runtimeSlug)
  if (!m) return undefined
  // Product rule: EVERY audio-capable model whose provider accepts an audio-off param exposes a REAL On/Off toggle.
  // Explicit m.audioToggle wins; otherwise derive from verified provider support. Models with audio but no provider
  // off-param (Sora 2 / Sora 2 Pro / Grok) fall through to `audioIncluded` (read-only indicator) — never a fake toggle.
  const audioToggle = !!m.hasAudio && (m.audioToggle ?? providerSupportsAudioOff(m.falEndpoint))
  const modes: VideoWorkflowMode[] = ['text-to-video', ...((m.extraVideoModes ?? []) as VideoWorkflowMode[])]
  return {
    qualityOptions: m.qualityOptions ?? [],
    audioToggle,
    audioIncluded: m.hasAudio && !audioToggle,
    imageReference: !!m.supportsImageReference,
    maxImageReferences: m.maxImageReferences ?? (m.supportsImageReference ? 1 : 0),
    startFrame: !!m.supportsStartFrame,
    endFrame: !!m.supportsEndFrame,
    modes,
  }
}

/**
 * Union of frame capabilities across a PRIMARY video model AND its mode variants. The auto-i2v UX uses this so the
 * Start/End Frame cards stay usable as entry points: e.g. Seedance/Luma show an active Start Frame card while the
 * primary is still text-to-video, and setting it auto-resolves to the image-to-video variant. Read-only; derived
 * straight from `video-models.ts` (primary + every `modeVariants` target). Dispatch/validation still use the
 * EFFECTIVE slug's own caps — this only governs which frame cards are offered.
 */
export function getVideoFamilyFrames(primarySlug: string): { startFrame: boolean; endFrame: boolean } {
  const m = getModelById(primarySlug)
  const slugs = [primarySlug, ...(m?.modeVariants ? Object.values(m.modeVariants) : [])]
  let startFrame = false
  let endFrame = false
  for (const s of slugs) {
    const v = getModelById(s)
    if (v?.supportsStartFrame) startFrame = true
    if (v?.supportsEndFrame) endFrame = true
  }
  return { startFrame, endFrame }
}

/**
 * Resolve the EFFECTIVE runtime slug for a primary video model given the in-box quality selection.
 * Capability-driven: reads the model's `qualityVariants` map (label → variant slug). When a quality is
 * selected and mapped, returns the variant slug (which carries the truthful endpoint/resolution/price);
 * otherwise returns the primary slug unchanged. Audio on/off is NOT a slug switch — it uses the model's
 * no/yes price column + `with_audio` — so it is intentionally not handled here.
 */
export function resolveVideoVariantSlug(runtimeSlug: string, quality?: string): string {
  const m = getModelById(runtimeSlug)
  if (m?.qualityVariants && quality && m.qualityVariants[quality]) return m.qualityVariants[quality]
  return runtimeSlug
}

/**
 * Resolve the EFFECTIVE runtime slug for the selected in-box WORKFLOW MODE. Capability-driven: reads the
 * model's `modeVariants` map (mode → variant slug). When a mode is selected and mapped (e.g. Veo 3.1 +
 * 'first-last-frame' → 'veo31_flf'), returns the variant slug (its own endpoint / durations / frames / price);
 * otherwise returns the slug unchanged. Compose with `resolveVideoVariantSlug` (quality) for the full effective slug.
 */
export function resolveVideoModeSlug(runtimeSlug: string, mode?: VideoWorkflowMode): string {
  const m = getModelById(runtimeSlug)
  if (m?.modeVariants && mode && m.modeVariants[mode]) return m.modeVariants[mode]
  return runtimeSlug
}

/**
 * Clamp a requested duration to the model's nearest supported duration.
 * Mirrors `calculateVideoCost`'s nearest-duration fallback so the UI/payload never request a
 * duration the model does not actually support. Returns the request unchanged if the model is
 * unknown or declares no durations.
 */
export function clampVideoDuration(runtimeSlug: string, requested: number): number {
  const caps = getVideoCapability(runtimeSlug)
  if (!caps || caps.durations.length === 0) return requested
  if (caps.durations.includes(requested)) return requested
  return caps.durations.reduce(
    (prev, cur) => (Math.abs(cur - requested) < Math.abs(prev - requested) ? cur : prev),
    caps.durations[0],
  )
}
