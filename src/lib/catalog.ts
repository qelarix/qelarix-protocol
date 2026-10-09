// ─────────────────────────────────────────────────────────────────────────────
// Qelarix — UNIFIED model / pricing / access / capability runtime facade.
//
// This is the SINGLE place the app reads the catalog↔runtime model bridge from
// (and the intended single import point for model/pricing/capability/access truth
// going forward), instead of each surface — Playground, /video, /image, Cinema
// Studio, pricing UI — re-declaring its own copy and drifting out of sync.
//
// The underlying source-of-truth libs are UNCHANGED; this module unifies the read
// path and removes the duplicated, drift-prone bridge maps:
//   • Catalog (display / picker)     → ./models             (QELARIX_MODELS, getModelsByType)
//   • Video runtime + capabilities   → ./video-models, ./video-capabilities
//   • Image runtime                  → ./image-models
//   • Pricing / credits (the charge) → ./credits            (VIDEO_PRICES, calculateVideoCost)
//   • Plans / access                 → ./plans, ./planAccess
//
// The Excel master (Qelarix_Master_Source_Of_Truth_Credits_Offers.xlsx) remains the
// human PLANNING source-of-truth + rollout/pricing-lock reference; this file is the
// unified RUNTIME read source. Change a model/credit/access value in the lib it owns
// and every surface that reads through this facade reflects it automatically.
// ─────────────────────────────────────────────────────────────────────────────
import { calculateVideoCost, CREDITS, VIDEO_PRICES } from './credits'
import { QELARIX_MODELS, type QelarixModel } from './models'
import { canAccessVideo, type PlanId } from './plans'
import { canAccessImageModel } from './image-models'

/**
 * Catalog id (QELARIX_MODELS in ./models) → runtime VIDEO slug (./video-models id and
 * ./credits VIDEO_PRICES key). Unified SUPERSET — consolidated from the former per-page
 * copies that had drifted (Playground was the most complete; the standalone /video page
 * was stale and silently missing every model newer than Veo 2, so they could not generate
 * there). Reading this one map keeps Playground, /video and Cinema-adjacent surfaces aligned.
 */
export const VIDEO_MODEL_IDS: Record<string, string> = {
  wan26: 'wan26', ltx2: 'ltx2', luma_ray3: 'luma3', pika25: 'pika25', kling3: 'kling3',
  kling3_pro: 'kling3pro', kling3_4k: 'kling3_4k', kling3_standard: 'kling3_standard',
  kling26_pro: 'kling26_pro', kling26_standard: 'kling26_standard', kling3_omni: 'kling3_omni',
  kling_o1_reference: 'kling_o1_reference', // reference-to-video (multi image_urls[]); same id catalog↔runtime

  seedance2: 'seedance20', grok_video: 'grokvideo', happy_horse: 'happyhorse10', veo4: 'veo4',
  // Group 1 rollout: Veo 3.1 + Seedance 2.0 Fast via distinct catalog ids → existing runtime slugs.
  veo31_standard: 'veo31_standard', seedance2_fast: 'seedance2',
  // Group 2: Veo 3.1 Fast → runtime veo31 (fal-ai/veo3.1/fast; price VIDEO_PRICES.veo31).
  veo31: 'veo31',
  // Grok Imagine Video 480p budget tier → runtime grokvideo480 (same endpoint, resolution=480p).
  grok_video_480: 'grokvideo480',
  // Wan 2.2 A14B — 720p / 580p / 480p tiers (resolution per runtime variant).
  wan22: 'wan22', wan22_580: 'wan22_580', wan22_480: 'wan22_480',
  // Veo 3 (fal-ai/veo3) — audio-ON (veo3) + legacy audio-OFF silent (veo3_silent) variants.
  veo3: 'veo3', veo3_silent: 'veo3_silent',
  // Sora 2 / Sora 2 Pro (fal-ai/sora-2/text-to-video[/pro]) — native audio.
  sora2: 'sora2', sora2pro: 'sora2pro',
}

/**
 * Catalog id → runtime IMAGE slug (./image-models id). `flux_kontext` is a legacy alias kept so
 * the /image surface is unaffected; the model is comingSoon (hidden in pickers that filter it), so
 * the entry is inert where flux_kontext is not exposed.
 */
export const IMAGE_MODEL_IDS: Record<string, string> = {
  sd35: 'sd35', nano_banana2: 'nanobanana2', imagen4: 'imagen4fast', flux2_pro: 'flux2pro',
  flux2_max: 'flux2max', ideogram3: 'ideogram', recraft_v4: 'recraft',
  gpt_image2: 'gptimage2', // v1.2 2026-06-03: REAL OpenAI gpt-image-2 (NOT DALL·E) — active bridge → runtime gptimage2
  nano_banana_pro: 'nanobanana_pro', grok_imagine: 'grokimagine', seedream5: 'seedream5', seedream45: 'seedream45',
  flux_kontext: 'flux2pro',
}

/** Resolve a catalog id to its runtime VIDEO slug (falls back to the id itself if unmapped). */
export const resolveVideoSlug = (catalogId: string): string => VIDEO_MODEL_IDS[catalogId] ?? catalogId

/** Resolve a catalog id to its runtime IMAGE slug (falls back to the id itself if unmapped). */
export const resolveImageSlug = (catalogId: string): string => IMAGE_MODEL_IDS[catalogId] ?? catalogId

/**
 * Video credit cost by CATALOG id — resolves the bridge, then charges via the central pricing
 * (./credits calculateVideoCost). One call, always consistent with the runtime/deduction truth.
 */
export const getVideoCostByCatalogId = (catalogId: string, duration: number, withAudio: boolean): number =>
  calculateVideoCost(resolveVideoSlug(catalogId), duration, withAudio)

// ─────────────────────────────────────────────────────────────────────────────
// MODEL IDENTITY + CANONICAL CREDIT (display) read accessors.
// These give every surface ONE place to ask "what is this model / what does it
// cost to show on a card", derived from the same pricing truth the routes charge.
// ─────────────────────────────────────────────────────────────────────────────

/** Look up the catalog (display) entry for a catalog id. */
export const getModelById = (catalogId: string): QelarixModel | undefined =>
  QELARIX_MODELS.find((m) => m.id === catalogId)

/**
 * Canonical "from" credit for a catalog id — the price a picker/card should advertise,
 * derived from the SAME source the routes charge from:
 *   • video → the cheapest configuration in VIDEO_PRICES (lowest duration, audio-off floor)
 *   • image → CREDITS.image (flat per-image charge)
 *   • audio / anything without a price table → the model's static catalog credit (already correct)
 * This removes the old drift where the catalog's static `credits` (copied from the legacy flat
 * CREDITS.video map) advertised a number the deduction path never charged.
 */
export function getModelCredits(catalogId: string): number {
  const m = getModelById(catalogId)
  if (!m) return 0
  if (m.type === 'video') {
    const table = VIDEO_PRICES[resolveVideoSlug(catalogId)]
    if (table) {
      const floor = Math.min(...Object.values(table).map((d) => d.no))
      if (Number.isFinite(floor)) return floor
    }
    return m.credits
  }
  if (m.type === 'image') {
    const c = (CREDITS.image as Record<string, number>)[resolveImageSlug(catalogId)]
    return typeof c === 'number' ? c : m.credits
  }
  return m.credits
}

/**
 * Unified per-model access check by CATALOG id — resolves the bridge then defers to the
 * existing central gates (plans.canAccessVideo for video, image-models.canAccessImageModel
 * for image, which reads each model's `plan` field). One entry point for all media types.
 */
export function canAccessModel(planId: PlanId | 'tester', catalogId: string): boolean {
  const m = getModelById(catalogId)
  if (!m) return false
  if (m.type === 'video') return canAccessVideo(planId, resolveVideoSlug(catalogId))
  if (m.type === 'image') return canAccessImageModel(planId, resolveImageSlug(catalogId))
  return true
}

/**
 * Dev/CI guard: returns every selectable model whose static catalog `credits` no longer matches
 * the canonical credit derived from the pricing truth. Empty array = fully in sync. Use in a test
 * or a one-off console check to catch future drift before it reaches the picker.
 */
export function validateCatalogCreditsSync(): Array<{ id: string; static: number; canonical: number }> {
  const drift: Array<{ id: string; static: number; canonical: number }> = []
  for (const m of QELARIX_MODELS) {
    if (m.comingSoon) continue
    const canonical = getModelCredits(m.id)
    if (canonical > 0 && canonical !== m.credits) drift.push({ id: m.id, static: m.credits, canonical })
  }
  return drift
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports — so a surface can import model/pricing/access truth from ONE module.
// (The owning libs remain the source-of-truth; this is just the single read door.)
// ─────────────────────────────────────────────────────────────────────────────
export { QELARIX_MODELS, getModelsByType, getFeaturedModels, getNewModels, providerColor } from './models'
export type { QelarixModel } from './models'
export {
  PLANS, getPlan, canAccessVideo, canUseFreeModel, hasFeature, hasPageAccess, PLAN_LEVEL, getPlanRank,
} from './plans'
export type { PlanId, Plan } from './plans'
export { CREDITS, VIDEO_PRICES, calculateVideoCost, getImageCredits } from './credits'
export { canAccessImageModel, getImageModelById } from './image-models'
