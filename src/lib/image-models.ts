import { PLAN_GATING_ENABLED } from './plans'
import { CREDITS } from "./credits"
import type { ImageModel } from "./credits"

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3"
export type ImageQuality = "standard" | "hd"

export interface ImageModelConfig {
  id: ImageModel
  label: string
  provider: string
  falEndpoint: string | null
  plan: "free" | "starter" | "pro" | "ultra" | "business"
  credits: number
  maxImages: number
  aspectRatios: AspectRatio[]
  /**
   * Negative-prompt capability (provider-verified). 'native' → send the provider `negative_prompt` field (SD 3.5,
   * Ideogram V3). 'prompt_fallback' → append "avoid: …" to the prompt (NOT used in Phase 1). Omitted/'none' → no
   * negative-prompt control. Drives the Playground UI gate AND dispatch. Cost-neutral.
   */
  negativePromptSupport?: "none" | "native" | "prompt_fallback"
  supportsQuality: boolean
  description: string
  badge?: string
  icon: string
  isNew?: boolean
  /** Pilot: single public-URL reference image on the model's CURRENT endpoint (no edit/i2i endpoint switch). */
  supportsReference?: boolean
  maxReferences?: number
  /** UI wording for the reference control: 'image' = generic reference (flux2max), 'style' = style transfer (ideogram). Defaults to 'image'. */
  referenceKind?: 'image' | 'style'
  /**
   * Verified quality tiers that change provider cost AND credits. `id` = the provider quality value (e.g.
   * gpt-image-2 'low'|'medium'|'high', surfaced as GPT Fast/Standard/Ultra). The selected tier drives BOTH the
   * Playground preview and the route deduction + the `quality` payload. Mutually exclusive with speed/resolution tiers.
   */
  qualityTiers?: { id: string; label: string; credits: number }[]
  /** Default quality tier id (e.g. 'medium'). */
  defaultQuality?: string
  /**
   * Provider-level STYLE enum (COST-NEUTRAL) — verified only for Ideogram V3 (AUTO/GENERAL/REALISTIC/DESIGN) and
   * Recraft V3 (realistic_image/digital_illustration/vector_illustration). `id` = the exact provider value; the route
   * maps it to the provider `style` field. SEPARATE from the universal prompt-style presets. No price/credit impact.
   */
  styleOptions?: { id: string; label: string }[]
  /**
   * Verified resolution tiers that change provider cost AND credits (e.g. Nano Banana Pro 2K/4K via the
   * provider `resolution` enum). Present ONLY where a discrete provider tier truthfully changes the charge.
   * The selected tier drives BOTH the Playground preview and the route deduction.
   */
  resolutionTiers?: { id: string; label: string; credits: number }[]
  /** Default resolution tier id (e.g. '2K'). */
  defaultResolution?: string
  /**
   * Verified rendering-speed tiers that change provider cost AND credits (e.g. Ideogram V3 TURBO/BALANCED/QUALITY
   * via the `rendering_speed` enum). `id` = the provider rendering_speed value. The selected tier drives BOTH the
   * Playground preview and the route deduction + the rendering_speed payload. Mutually exclusive with quality/resolution tiers.
   */
  speedTiers?: { id: string; label: string; credits: number }[]
  /** Default rendering-speed tier id (e.g. 'BALANCED'). */
  defaultSpeed?: string
  /**
   * Reference-input capability descriptor (single source of truth for both the Playground UI and the route
   * payload mapping). Present ONLY where reference is truthfully wired. Phase A/B: single image (maxRefs 1).
   *   mode         — 'none' | 'image' (subject/redux) | 'style' | 'multi' | 'edit' (edit endpoints deferred)
   *   maxRefs      — max selectable references
   *   payloadField — provider field the route writes ('image_url' single, 'image_urls'/'reference_image_urls' array)
   *   endpoint     — optional edit/i2i endpoint override (NOT used in Phase A/B; t2i endpoint stays)
   */
  reference?: {
    mode: "none" | "image" | "style" | "multi" | "edit"
    maxRefs: number
    payloadField: "image_url" | "image_urls" | "reference_image_urls"
    endpoint?: string
  }
}

export const IMAGE_MODELS: ImageModelConfig[] = [
  {
    id: "sd35",
    label: "Stable Diffusion 3.5",
    provider: "Stability AI",
    falEndpoint: "fal-ai/stable-diffusion-v35-large",
    plan: "free",
    credits: CREDITS.image.sd35,
    maxImages: 4,
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:2"],
    negativePromptSupport: "native", // SD 3.5 Large — provider-verified native `negative_prompt`
    supportsQuality: false,
    description: "High quality, fast generation",
    icon: "🖼️",
  },
  {
    id: "flux2pro",
    label: "FLUX 2 Pro", // v1.2 rollout: provider-verified fal-ai/flux-2-pro (FLUX.2 [pro], $0.03/MP)
    provider: "Black Forest Labs",
    falEndpoint: "fal-ai/flux-2-pro",
    plan: "starter",
    credits: CREDITS.image.flux2pro,
    maxImages: 1, // FLUX.2 num_images not provider-verified yet → single image (no overcharge). Raise to 4 after a live smoke test.
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    supportsQuality: false, // FLUX.2 has no std/hd 'raw' toggle wired → keep the Quality chip hidden (truthful)
    description: "FLUX.2 Pro — studio-grade detail and color",
    badge: "Popularan",
    icon: "⚡",
  },
  {
    id: "flux2max",
    label: "FLUX 1.1 Pro Ultra", // Phase1 catalog-truth: endpoint fal-ai/flux-pro/v1.1-ultra (not FLUX 2)
    provider: "Black Forest Labs",
    falEndpoint: "fal-ai/flux-pro/v1.1-ultra",
    plan: "pro",
    credits: CREDITS.image.flux2max,
    maxImages: 4, // was artificially capped at 1; fal schema num_images max 4; route already passes num_images
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    supportsQuality: true,
    supportsReference: true, // pilot: single public-URL reference via image_url on the same fal-ai/flux-pro/v1.1-ultra endpoint
    maxReferences: 1,
    reference: { mode: "image", maxRefs: 1, payloadField: "image_url" }, // descriptor (single source) — route writes image_url
    description: "Ultra-high resolution and detail",
    badge: "Ultra",
    icon: "🌟",
  },
  {
    id: "ideogram",
    label: "Ideogram V3",
    provider: "Ideogram",
    falEndpoint: "fal-ai/ideogram/v3",
    plan: "starter",
    credits: CREDITS.image.ideogram,
    maxImages: 4, // fal schema num_images max 8; product-safe cap 4
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    negativePromptSupport: "native", // Ideogram V3 — provider-verified native `negative_prompt` (Phase 1: now exposed in UI)
    supportsQuality: false,
    supportsReference: true, // style-reference pilot: single public-URL STYLE ref via image_urls on the same fal-ai/ideogram/v3 endpoint
    maxReferences: 1,
    referenceKind: "style",
    reference: { mode: "style", maxRefs: 1, payloadField: "image_urls" }, // descriptor (single source) — route writes image_urls:[url]
    // Verified fal `rendering_speed` enum (TURBO/BALANCED/QUALITY). Provider $0.03 / $0.06 / $0.09; default BALANCED.
    speedTiers: [
      { id: "TURBO", label: "Turbo", credits: CREDITS.image.ideogram_turbo },
      { id: "BALANCED", label: "Balanced", credits: CREDITS.image.ideogram },
      { id: "QUALITY", label: "Quality", credits: CREDITS.image.ideogram_quality },
    ],
    defaultSpeed: "BALANCED",
    // Provider-verified style enum (cost-neutral): fal-ai/ideogram/v3 `style` AUTO/GENERAL/REALISTIC/DESIGN.
    styleOptions: [
      { id: "AUTO", label: "Auto" },
      { id: "GENERAL", label: "General" },
      { id: "REALISTIC", label: "Realistic" },
      { id: "DESIGN", label: "Design" },
    ],
    description: "Excellent for text in images and logos",
    icon: "💡",
  },
  {
    id: "recraft",
    label: "Recraft V3",
    provider: "Recraft",
    falEndpoint: "fal-ai/recraft/v3/text-to-image",
    plan: "starter",
    credits: CREDITS.image.recraft,
    maxImages: 1, // route buildFalInput deletes num_images for recraft → returns 1; cap so credits never overcharge
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:2"],
    supportsQuality: false,
    // Provider-verified style enum (cost-neutral): fal-ai/recraft/v3 `style` realistic_image/digital_illustration/vector_illustration.
    styleOptions: [
      { id: "realistic_image", label: "Realistic Image" },
      { id: "digital_illustration", label: "Digital Illustration" },
      { id: "vector_illustration", label: "Vector Illustration" },
    ],
    description: "Illustrations and vector style",
    icon: "✏️",
  },
  {
    id: "seedream5",
    label: "Seedream 4.0", // v1.2 rollout: provider-verified fal-ai/bytedance/seedream/v4 ($0.03/img). Master "Seedream 5.0" = real v4; no v5 endpoint exists.
    provider: "ByteDance",
    falEndpoint: "fal-ai/bytedance/seedream/v4/text-to-image",
    plan: "starter",
    credits: CREDITS.image.seedream5,
    maxImages: 4, // seedream v4 supports num_images; route 'seedream' branch unchanged
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    supportsQuality: false,
    // Reference/edit pilot (v1.2, mirrors Seedream 4.5): refs route to fal-ai/bytedance/seedream/v4/edit ($0.03/img,
    // SAME as t2i — no surcharge → reuse seedream5/seedream5_4k credits). Provider allows up to 10 refs; Qelarix caps at 4.
    // No route/dispatch/boost change needed — the generic reference systems already handle any model with reference.endpoint.
    supportsReference: true,
    maxReferences: 4,
    referenceKind: "image",
    reference: { mode: "multi", maxRefs: 4, payloadField: "image_urls", endpoint: "fal-ai/bytedance/seedream/v4/edit" },
    // Verified: image_size accepts a {width,height} object up to 4096² (provider default 2048²). Flat $0.03/image —
    // NO 4K surcharge, so 4K is a Qelarix resolution premium, not a provider-cost tier. The route maps tier+aspect
    // to constraint-valid dimensions (v4: total 960²–4096²). Mirrors the Nano Banana resolution-tier mechanism.
    resolutionTiers: [
      { id: "2K", label: "2K", credits: CREDITS.image.seedream5 },
      { id: "4K", label: "4K", credits: CREDITS.image.seedream5_4k },
    ],
    defaultResolution: "2K",
    description: "Seedream 4.0 — cinematic quality, deep scene understanding",
    icon: "🌸",
    isNew: true,
  },
  {
    id: "seedream45",
    label: "Seedream 4.5", // v1.2: fal-ai/bytedance/seedream/v4.5/text-to-image ($0.04/img); 2K/4K resolution tiers + first reference/edit pilot (refs → v4.5/edit).
    provider: "ByteDance",
    falEndpoint: "fal-ai/bytedance/seedream/v4.5/text-to-image",
    plan: "starter",
    credits: CREDITS.image.seedream45,
    maxImages: 4, // conservative (matches Seedream 4.0 pattern); provider-verified num_images 1-6 — kept at 4
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    supportsQuality: false,
    // First reference/edit pilot (v1.2): refs route to fal-ai/bytedance/seedream/v4.5/edit ($0.04/img, SAME as t2i — no
    // surcharge → reuse seedream45/seedream45_4k credits). Provider allows up to 10 refs; Qelarix starts product-safe at 4.
    supportsReference: true,
    maxReferences: 4,
    referenceKind: "image",
    reference: { mode: "multi", maxRefs: 4, payloadField: "image_urls", endpoint: "fal-ai/bytedance/seedream/v4.5/edit" },
    // Verified: image_size accepts a {width,height} object up to 4096². Flat $0.04/image — NO 4K surcharge (4K is a
    // Qelarix resolution premium). v4.5 stricter floor (each side 1920–4096 OR total 2560×1440–4096²); the route's
    // aspect-aware sizing stays inside it. Mirrors the Nano Banana resolution-tier mechanism.
    resolutionTiers: [
      { id: "2K", label: "2K", credits: CREDITS.image.seedream45 },
      { id: "4K", label: "4K", credits: CREDITS.image.seedream45_4k },
    ],
    defaultResolution: "2K",
    description: "Seedream 4.5 — newer ByteDance model with stronger text rendering and consistency (2K/4K).",
    icon: "🌸",
    isNew: true,
  },
  // GPT Image 2 (real OpenAI gpt-image-2) is integrated below as an ACTIVE model (v1.2 2026-06-03) — NOT DALL·E.
  // DALL·E stays removed (no dall-e-3 branch, no fallback). CREDITS.image.gptimage2_hd remains an inert Cinema-type key.
  {
    id: "grokimagine",
    label: "Grok Imagine",
    provider: "xAI",
    falEndpoint: null,
    plan: "pro",
    credits: CREDITS.image.grokimagine,
    maxImages: 4, // xAI grok-2-image n max 10; product-safe cap 4 (route already passes n)
    // grok-2-image has NO verified provider aspect-ratio control (the xAI image API documents no OpenAI-style
    // size/aspect parameter — Grok truth audit 2026-06-03). Locked to a single fixed 1:1 so the UI never offers a
    // ratio the provider would silently ignore. Revisit only when a newer Grok image family is audited.
    aspectRatios: ["1:1"],
    supportsQuality: false,
    description: "xAI's image model",
    icon: "🚀",
    isNew: true,
  },
  {
    id: "nanobanana2",
    label: "Nano Banana 2", // Phase1 catalog-truth: endpoint fal-ai/nano-banana-2 (Google)
    provider: "Google",
    falEndpoint: "fal-ai/nano-banana-2",
    plan: "free",
    credits: CREDITS.image.nanobanana2,
    maxImages: 2, // num_images verified present in current fal schema (max 4); conservative re-enable at 2 — recommend a live smoke test before raising to 4
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    supportsQuality: false,
    // Reference/edit (v1.2 Priority 2, mirrors Nano Banana Pro Edit): refs route to fal-ai/nano-banana-2/edit.
    // VERIFIED generation==editing pricing parity (1K=$0.08, 2K=$0.12, 4K=$0.16 — 1.5×/2×) → reuse nanobanana2 /
    // nanobanana2_2k / nanobanana2_4k credits, NO surcharge, no new keys. Provider allows 10+ refs; Qelarix caps at 4.
    // No route/dispatch/boost change — the generic reference systems + nano-banana resolution branch already handle it.
    supportsReference: true,
    maxReferences: 4,
    referenceKind: "image",
    reference: { mode: "multi", maxRefs: 4, payloadField: "image_urls", endpoint: "fal-ai/nano-banana-2/edit" },
    // Verified fal `resolution` enum 0.5K/1K/2K/4K (0.5K intentionally NOT exposed). 1K=$0.08 / 2K=$0.12 / 4K=$0.16.
    resolutionTiers: [
      { id: "1K", label: "1K", credits: CREDITS.image.nanobanana2 },
      { id: "2K", label: "2K", credits: CREDITS.image.nanobanana2_2k },
      { id: "4K", label: "4K", credits: CREDITS.image.nanobanana2_4k },
    ],
    defaultResolution: "1K",
    description: "Nano Banana 2 — fast Google image model with accurate text; resolution selectable (1K/2K/4K).",
    icon: "🎨",
  },
  {
    id: "nanobanana_pro",
    label: "Nano Banana Pro", // Phase1 catalog-truth: endpoint fal-ai/nano-banana-pro (Google)
    provider: "Google",
    falEndpoint: "fal-ai/nano-banana-pro",
    plan: "pro", // Phase3: aligned with image route allow-lists (not in FREE/STARTER_IMAGE_MODELS); 25cr fits pro+ tier
    credits: CREDITS.image.nanobanana_pro,
    maxImages: 2, // num_images verified present in current fal schema (max 4); conservative re-enable at 2 — recommend a live smoke test before raising to 4
    aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
    supportsQuality: false,
    // Reference/edit (v1.2 Priority 1, mirrors Seedream Edit): refs route to fal-ai/nano-banana-pro/edit.
    // VERIFIED generation==editing pricing parity ($0.15 1K/2K, $0.30 4K — 4K = 2×) → reuse nanobanana_pro /
    // nanobanana_pro_4k credits, NO surcharge, no new keys. Provider allows 10+ refs; Qelarix caps at 4.
    // No route/dispatch/boost change — the generic reference systems + nano-banana resolution branch already handle it.
    supportsReference: true,
    maxReferences: 4,
    referenceKind: "image",
    reference: { mode: "multi", maxRefs: 4, payloadField: "image_urls", endpoint: "fal-ai/nano-banana-pro/edit" },
    // Verified resolution tier (fal `resolution` enum): 1K/2K = $0.15, 4K = $0.30. Expose 2K (default) + 4K.
    resolutionTiers: [
      { id: "2K", label: "2K", credits: CREDITS.image.nanobanana_pro },
      { id: "4K", label: "4K", credits: CREDITS.image.nanobanana_pro_4k },
    ],
    defaultResolution: "2K",
    description: "Fastest generation — ideal for quick drafts",
    icon: "🏎️",
  },
  {
    id: "imagen4fast",
    label: "Imagen 4 Fast",
    provider: "Google",
    falEndpoint: "fal-ai/imagen4/preview/fast",
    plan: "starter",
    credits: CREDITS.image.imagen4fast,
    maxImages: 4,
    aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
    supportsQuality: false,
    description: "Google's photorealistic model",
    icon: "🔵",
    isNew: true,
  },
  {
    id: "gptimage2",
    label: "GPT Image 2",
    provider: "OpenAI",
    falEndpoint: null, // served via DIRECT OpenAI Images API (POST /v1/images/generations, model gpt-image-2). NOT fal, NOT DALL·E, NO fallback.
    plan: "pro",
    credits: CREDITS.image.gptimage2, // GPT Standard (medium) = default = 4
    maxImages: 4, // OpenAI n 1-10; product-safe cap 4
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    supportsQuality: false, // uses the 3-way qualityTiers below (GPT Fast/Standard/Ultra), NOT the binary std/HD chip
    // Reference/edit (v1.2 Priority 3): GPT Image 2 Edit via OpenAI Images API POST /v1/images/edits (multipart).
    // NOT fal descriptor routing — deliberately NO `reference.endpoint`. The route's gptimage2 branch downloads refs
    // server-side → binary image[] parts (public URLs are never forwarded to OpenAI). First rollout: maxRefs 2, no mask.
    // Reuses GPT Fast/Standard/Ultra credits (token-billed; edit adds image-input tokens → Fast margin to be smoke-tested).
    // These flags only light up the EXISTING reference UI/strip; the GPT branch reads body.referenceImageUrls directly.
    supportsReference: true,
    maxReferences: 2,
    referenceKind: "image",
    // Verified OpenAI quality tiers (gpt-image-2): low/medium/high -> user labels GPT Fast/Standard/Ultra. Token-billed;
    // per-image cost rises with quality. Selected tier drives BOTH the Playground preview AND the route deduction +
    // the `quality` payload. Mirrors the Ideogram speed-tier / Nano Banana resolution-tier mechanism.
    qualityTiers: [
      { id: "low", label: "GPT Fast", credits: CREDITS.image.gptimage2_fast },
      { id: "medium", label: "GPT Standard", credits: CREDITS.image.gptimage2 },
      { id: "high", label: "GPT Ultra", credits: CREDITS.image.gptimage2_ultra },
    ],
    defaultQuality: "medium",
    description: "GPT Image 2 — OpenAI flagship image model with quality tiers (Fast / Standard / Ultra).",
    icon: "🧠",
    isNew: true,
  },
]

export const ASPECT_RATIO_LABELS: Record<AspectRatio, string> = {
  "1:1": "Kvadrat (1:1)",
  "16:9": "Horizontalno (16:9)",
  "9:16": "Vertikalno (9:16)",
  "4:3": "Standard (4:3)",
  "3:4": "Portrait (3:4)",
  "3:2": "Foto (3:2)",
  "2:3": "Tall (2:3)",
}

export const ASPECT_RATIO_DIMS: Record<AspectRatio, { w: number; h: number }> = {
  "1:1": { w: 1024, h: 1024 },
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "4:3": { w: 1024, h: 768 },
  "3:4": { w: 768, h: 1024 },
  "3:2": { w: 1152, h: 768 },
  "2:3": { w: 768, h: 1152 },
}

/**
 * Credits for an image model at the selected quality tier. Tiered models (e.g. DALL·E 3) charge per
 * tier; flat models return model.credits. Used by BOTH the Playground preview and the route deduction
 * so preview === charge for every quality.
 */
export function getImageTierCredits(model: ImageModelConfig, quality?: ImageQuality): number {
  if (model.qualityTiers && model.qualityTiers.length > 0) {
    const t = model.qualityTiers.find((q) => q.id === (quality ?? "standard")) ?? model.qualityTiers[0]
    return t.credits
  }
  return model.credits
}

/**
 * Credits for a resolution-tiered image model (e.g. Nano Banana Pro 2K/4K). Flat models return
 * model.credits. Used by BOTH the Playground preview and the route deduction so preview === charge.
 */
export function getImageResolutionCredits(model: ImageModelConfig, resolution?: string): number {
  if (model.resolutionTiers && model.resolutionTiers.length > 0) {
    const want = resolution ?? model.defaultResolution ?? model.resolutionTiers[0].id
    const t = model.resolutionTiers.find((r) => r.id === want) ?? model.resolutionTiers[0]
    return t.credits
  }
  return model.credits
}

/**
 * Credits for a rendering-speed-tiered image model (e.g. Ideogram V3 Turbo/Balanced/Quality). Flat models
 * return model.credits. Used by BOTH the Playground preview and the route deduction so preview === charge.
 */
export function getImageSpeedCredits(model: ImageModelConfig, speed?: string): number {
  if (model.speedTiers && model.speedTiers.length > 0) {
    const want = speed ?? model.defaultSpeed ?? model.speedTiers[0].id
    const t = model.speedTiers.find((x) => x.id === want) ?? model.speedTiers[0]
    return t.credits
  }
  return model.credits
}

/**
 * Credits for a quality-tiered image model (e.g. GPT Image 2 low/medium/high → GPT Fast/Standard/Ultra). Flat models
 * return model.credits. Used by BOTH the Playground preview and the route deduction so preview === charge.
 */
export function getImageQualityCredits(model: ImageModelConfig, quality?: string): number {
  if (model.qualityTiers && model.qualityTiers.length > 0) {
    const want = quality ?? model.defaultQuality ?? model.qualityTiers[0].id
    const t = model.qualityTiers.find((q) => q.id === want) ?? model.qualityTiers[0]
    return t.credits
  }
  return model.credits
}

export function getImageModelById(id: string): ImageModelConfig | undefined {
  return IMAGE_MODELS.find((m) => m.id === id)
}

export function canAccessImageModel(plan: string, modelId: string): boolean {
  const model = getImageModelById(modelId)
  if (!model) return false
  if (!PLAN_GATING_ENABLED) return true
  const order = ["free", "starter", "pro", "ultra", "business"]
  return order.indexOf(plan) >= order.indexOf(model.plan)
}
