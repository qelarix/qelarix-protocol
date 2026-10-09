/**
 * Qelarix — Unified Audio Model Registry
 *
 * Single source of truth for all audio models (same pattern as video-models.ts /
 * image-models.ts). The audio generate route AND the Playground audio UI both derive
 * from this file — no duplicated per-surface audio logic.
 *
 * Pricing lives in credits.ts (CREDITS.audio). This registry references those keys so
 * the same model is the same price everywhere (Excel MASTER -> credits.ts -> here -> UI/route).
 *
 * Provider truth (fal model pages, 2026-06-03):
 *   eleven-v3 / multilingual-v2 : $0.10 / 1000 characters  (TTS)
 *   lyria2                      : $0.10 / 30 seconds        (instrumental music)
 *   ace-step                    : $0.0002 / second          (song / music generation)
 *   suno-generate-sounds (muapi): provisional               (SFX) — COMING_SOON
 *
 * Status rule (Excel SoT): a model is only "active" when its provider route is real and
 * pricing is locked. Suno is COMING_SOON because the muapi audio submit/status flow is
 * not wired (same gap as other muapi models in the catalog).
 */

import { CREDITS } from "./credits";
import { PLAN_GATING_ENABLED } from "./plans";

export type AudioTaskType = "music" | "tts" | "song" | "sfx";
/** Truthful in-box controls beyond the text prompt. Never expose a control a model can't honour. */
export type AudioControl = "length" | "duration";
export type AudioProviderRoute = "stability" | "fal" | "muapi";
export type AudioCreditKey = keyof typeof CREDITS.audio;

export interface AudioDurationTier {
  seconds: number;
  label: string;
  creditKey: AudioCreditKey;
}

export interface AudioModelConfig {
  /** Unified id — used as the Playground catalog id AND the audio route `model` param. */
  id: string;
  label: string;
  provider: string;
  taskType: AudioTaskType;
  route: AudioProviderRoute;
  /** fal.ai endpoint (route === "fal"). */
  falEndpoint?: string;
  /** muapi model slug (route === "muapi"). */
  muapiModel?: string;
  minPlan: "free" | "starter" | "pro" | "ultra" | "business";
  status: "active" | "coming_soon";

  // ── Pricing — exactly one of: tiers (length/duration control) OR flat creditKey ──
  /** Tiered pricing for models with a length/duration control (Stability, ACE-Step). */
  tiers?: AudioDurationTier[];
  /** Flat per-generation credit key (TTS, Lyria). */
  creditKey?: AudioCreditKey;

  /** Truthful in-box controls. Empty = prompt-only. */
  controls: AudioControl[];
  /** TTS input cap (characters). */
  maxChars?: number;
  /** Fixed output length in seconds (display only; models with no duration control). */
  fixedSeconds?: number;
  /** Truthful prompt placeholder for this model. */
  promptPlaceholder: string;
  description: string;
  badge?: string;
  /** Async fal QUEUE path (fal.queue.submit + status polling) instead of synchronous fal.subscribe. */
  async?: boolean;
  /** Supports a vocal/instrumental toggle (force_instrumental for ElevenLabs Music; "[inst]" for ACE-Step). */
  instrumental?: boolean;
}

// ── Plan ranking (mirrors plans.ts ordering) ───────────────────────────────────
const AUDIO_PLAN_ORDER = ["free", "starter", "pro", "ultra", "business"] as const;
export function audioPlanRank(plan: string): number {
  return AUDIO_PLAN_ORDER.indexOf(plan as (typeof AUDIO_PLAN_ORDER)[number]);
}

// ── Registry ────────────────────────────────────────────────────────────────────
export const AUDIO_MODELS: AudioModelConfig[] = [
  // ── Stability Audio (existing family — length control) ──
  {
    id: "stability_audio",
    label: "Stability Audio",
    provider: "Stability AI",
    taskType: "music",
    route: "stability",
    minPlan: "free",
    status: "active",
    tiers: [
      { seconds: 30, label: "30s", creditKey: "stability30s" },
      { seconds: 60, label: "1 min", creditKey: "stability60s" },
      { seconds: 120, label: "2 min", creditKey: "stability2min" },
    ],
    controls: ["length"],
    promptPlaceholder: "Describe the music or sound — instruments, mood, environment…",
    description: "AI music & sound generation — choose the length in the prompt bar.",
  },

  // ── ElevenLabs v3 (TTS) ──
  {
    id: "eleven_v3",
    label: "ElevenLabs v3",
    provider: "ElevenLabs",
    taskType: "tts",
    route: "fal",
    falEndpoint: "fal-ai/elevenlabs/tts/eleven-v3",
    minPlan: "starter",
    status: "active",
    creditKey: "eleven_v3",
    controls: [],
    maxChars: 1000,
    promptPlaceholder: "Type the text to speak (up to 1000 characters)…",
    description: "Expressive text-to-speech. Up to 1000 characters per generation.",
    badge: "NEW",
  },

  // ── ElevenLabs Multilingual v2 (TTS) ──
  {
    id: "eleven_multilingual_v2",
    label: "ElevenLabs Multilingual v2",
    provider: "ElevenLabs",
    taskType: "tts",
    route: "fal",
    falEndpoint: "fal-ai/elevenlabs/tts/multilingual-v2",
    minPlan: "starter",
    status: "active",
    creditKey: "eleven_multilingual_v2",
    controls: [],
    maxChars: 1000,
    promptPlaceholder: "Type the text to speak (multilingual, up to 1000 characters)…",
    description: "Stable multilingual text-to-speech. Up to 1000 characters.",
    badge: "NEW",
  },

  // ── Lyria 2 (instrumental music) ──
  {
    id: "lyria2",
    label: "Lyria 2",
    provider: "Google",
    taskType: "music",
    route: "fal",
    falEndpoint: "fal-ai/lyria2",
    minPlan: "pro",
    status: "active",
    creditKey: "lyria2",
    controls: [],
    fixedSeconds: 30,
    promptPlaceholder: "Describe the instrumental music — genre, mood, instruments…",
    description: "Google Lyria 2 — cinematic instrumental music (~30s).",
    badge: "NEW",
  },

  // ── ACE-Step (song from style tags + optional lyrics / instrumental — duration control) ──
  {
    id: "ace_step",
    label: "ACE-Step",
    provider: "ACE-Step",
    taskType: "song",
    route: "fal",
    falEndpoint: "fal-ai/ace-step",
    minPlan: "pro",
    status: "active",
    tiers: [
      { seconds: 60, label: "≤60s", creditKey: "ace_step_60" },
      { seconds: 120, label: "≤120s", creditKey: "ace_step_120" },
    ],
    controls: ["duration"],
    instrumental: true,
    promptPlaceholder: "Describe the song style / tags — e.g. lofi, female vocal, 90 bpm…",
    description: "Song generation from style tags, with optional lyrics.",
    badge: "NEW",
  },

  // ── ElevenLabs Music (premium full-song generation — ASYNC fal queue) ──
  // $0.80 / output minute, billed rounded UP to the nearest minute → 1m/2m/3m tiers only (no 30s). Long songs use the
  // async submit+status path (NOT fal.subscribe) to avoid request timeouts. Output is mp3 (provider default).
  {
    id: "elevenlabs_music",
    label: "ElevenLabs Music",
    provider: "ElevenLabs",
    taskType: "song",
    route: "fal",
    async: true,
    falEndpoint: "fal-ai/elevenlabs/music",
    minPlan: "pro",
    status: "active",
    tiers: [
      { seconds: 60, label: "1 min", creditKey: "elevenlabs_music_1m" },
      { seconds: 120, label: "2 min", creditKey: "elevenlabs_music_2m" },
      { seconds: 180, label: "3 min", creditKey: "elevenlabs_music_3m" },
    ],
    controls: ["duration"],
    instrumental: true,
    promptPlaceholder: "Describe the song — genre, mood, instruments, vocals…",
    description: "Premium full-song generation — vocals or instrumental, 1–3 minutes.",
    badge: "NEW",
  },

  // ── Suno Generate Sounds (SFX via muapi) — COMING SOON ──
  // muapi audio submit/status flow is not wired (same gap as other muapi models).
  // Catalogued + priced (provisional) but not selectable for generation until wired.
  {
    id: "suno_generate_sounds",
    label: "Suno Generate Sounds",
    provider: "Suno (muapi)",
    taskType: "sfx",
    route: "muapi",
    muapiModel: "suno-generate-sounds",
    minPlan: "pro",
    status: "coming_soon",
    creditKey: "suno_generate_sounds",
    controls: [],
    promptPlaceholder: "Describe the sound effect…",
    description: "Sound-effect generation. Coming soon.",
    badge: "SOON",
  },
];

// ── Lookup / helpers (mirror video/image libs) ─────────────────────────────────
export function getAudioModelById(id: string): AudioModelConfig | undefined {
  return AUDIO_MODELS.find((m) => m.id === id);
}

export function getActiveAudioModels(): AudioModelConfig[] {
  return AUDIO_MODELS.filter((m) => m.status === "active");
}

/**
 * Resolve the creditKey + credit cost for a model, given an optional requested duration.
 * - tiered models: pick the tier matching `seconds`, else the first (smallest) tier.
 * - flat models:   the model's single creditKey.
 */
export function resolveAudioCredits(
  model: AudioModelConfig,
  seconds?: number,
): { creditKey: AudioCreditKey; credits: number; seconds?: number } {
  if (model.tiers && model.tiers.length > 0) {
    const tier =
      (seconds != null ? model.tiers.find((t) => t.seconds === seconds) : undefined) ??
      model.tiers[0];
    return { creditKey: tier.creditKey, credits: CREDITS.audio[tier.creditKey], seconds: tier.seconds };
  }
  const key = model.creditKey as AudioCreditKey;
  return { creditKey: key, credits: CREDITS.audio[key], seconds: model.fixedSeconds };
}

/** True when the plan may use this model (admin/ultra bypass handled by the caller). */
export function canUseAudioModel(model: AudioModelConfig, plan: string): boolean {
  if (model.status !== "active") return false;
  if (!PLAN_GATING_ENABLED) return true;
  const pr = audioPlanRank(plan);
  if (pr === -1) return false;
  return pr >= audioPlanRank(model.minPlan);
}
