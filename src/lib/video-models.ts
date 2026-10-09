import { calculateVideoCost } from './credits'

export { calculateVideoCost }

export const CAMERA_MOTIONS = [
  'Static', 'Pan Left', 'Pan Right', 'Tilt Up', 'Tilt Down',
  'Dolly In', 'Dolly Out', 'Orbit Left', 'Orbit Right',
] as const

export type CameraMotion = typeof CAMERA_MOTIONS[number]
export type AspectRatio = '16:9' | '9:16' | '1:1'

export interface VideoModelConfig {
  id: string
  falEndpoint: string | null
  muapiModel?: string
  label: string
  description: string
  badge?: string
  minPlan?: 'free' | 'starter' | 'pro' | 'business' | 'ultra'
  /** Phase1 catalog-truth: hidden from selectable video models + not generatable when true */
  comingSoon?: boolean
  durations: number[]
  aspectRatios: AspectRatio[]
  hasAudio: boolean
  /** Optional per-model output resolution tier (e.g. Grok 720p/480p, Wan 2.2 480p/580p/720p, Wan 2.5 480p/720p/1080p — SAME endpoint, resolution param). */
  resolution?: '480p' | '580p' | '720p' | '1080p'
  // ── In-prompt-box capability FOUNDATION (Playground v1.2). All optional; UNSET ⇒ that control stays hidden.
  // Left unpopulated for now so no non-functional control ships; the merge/wiring task sets these per-model as each becomes functional. ──
  /** In-box resolution choices (e.g. ['480p','580p','720p']); a Quality selector shows when length > 1. */
  qualityOptions?: string[]
  /** User can toggle audio on/off within ONE model (vs. audio fixed/included) ⇒ shows an interactive Audio toggle. */
  audioToggle?: boolean
  /** Supports an image-reference input slot in the prompt box. */
  supportsImageReference?: boolean
  /** Supports a start-frame input slot. */
  supportsStartFrame?: boolean
  /** Supports an end-frame input slot. */
  supportsEndFrame?: boolean
  /** Max selectable reference images for reference-to-video (e.g. Kling O1 → image_urls[]). UNSET ⇒ single (legacy single-ref). */
  maxImageReferences?: number
  /** Extra workflow modes beyond the always-present 'text-to-video'. */
  extraVideoModes?: ('image-to-video' | 'first-last-frame' | 'extend-video' | 'reference-to-video')[]
  /** Maps an in-box quality label → the EFFECTIVE runtime slug (existing variant entry) that carries the
   *  truthful endpoint/resolution/price for that quality. Lets one primary model drive multiple resolution
   *  tiers via the prompt box (cost + payload) before the picker is merged. */
  qualityVariants?: Record<string, string>
  /** Maps an in-box workflow MODE → the EFFECTIVE runtime slug (existing variant entry) carrying that mode's
   *  truthful endpoint/durations/frames/price. Lets one family entry drive advanced modes via the Mode control
   *  (e.g. Veo 3.1 + 'first-last-frame' → 'veo31_flf') with no extra picker row. */
  modeVariants?: Record<string, string>
  estimatedSeconds: number
  euroCost: number
  previewGradient: string
  features?: string[]
}

export const VIDEO_MODELS: VideoModelConfig[] = [
  // ── Starter+ ──────────────────────────────────────────────────────────────
  {
    id: 'ltx2',
    falEndpoint: 'fal-ai/ltx-video',
    label: 'LTX Video',
    minPlan: 'free',
    description: 'Fast and quality output, ideal for short clips',
    durations: [3, 5],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,    estimatedSeconds: 30,
    euroCost: 0.50,
    previewGradient: 'linear-gradient(135deg, #1a1a4e 0%, #2d1b69 100%)',
  },
  {
    id: 'wan26',
    comingSoon: true, // Phase2 endpoint-verify: fal pricing API returns 404 for fal-ai/wan-video
    falEndpoint: 'fal-ai/wan-video',
    label: 'Wan 2.6',
    minPlan: 'free',
    description: 'Cinematic style with excellent camera movement',
    badge: 'Popular',
    durations: [3, 5, 8],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,    estimatedSeconds: 60,
    euroCost: 0.60,
    previewGradient: 'linear-gradient(135deg, #0f2027 0%, #1e3a5f 50%, #2c5364 100%)',
  },
  {
    // Wan 2.2 A14B — real fal endpoint VERIFIED 200 (prompt-only, output=video, no audio). 720p standard tier.
    // num_frames 17-161 @16fps → 5/8/10s only (15s = 240 frames > 161 cap, NOT supported). MASTER FINAL 720p: 5/8/10 = 80/128/160.
    id: 'wan22',
    falEndpoint: 'fal-ai/wan/v2.2-a14b/text-to-video',
    label: 'Wan 2.2',
    minPlan: 'starter',
    description: 'Alibaba Wan 2.2 — high-quality text-to-video, up to 10s',
    badge: 'NEW',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,
    resolution: '720p',
    // In-box quality control (v1.2 wiring): one Wan 2.2 experience; quality → effective variant slug (price/resolution).
    qualityOptions: ['480p', '580p', '720p'],
    qualityVariants: { '480p': 'wan22_480', '580p': 'wan22_580', '720p': 'wan22' },    estimatedSeconds: 90,
    euroCost: 0.80,
    previewGradient: 'linear-gradient(135deg, #0f2027 0%, #1e3a5f 50%, #2c5364 100%)',
  },
  {
    // Wan 2.2 A14B — 580p balanced tier (SAME endpoint, resolution=580p). MASTER FINAL 580p: 5/8/10 = 60/96/120.
    id: 'wan22_580',
    falEndpoint: 'fal-ai/wan/v2.2-a14b/text-to-video',
    label: 'Wan 2.2 580p',
    minPlan: 'starter',
    description: 'Alibaba Wan 2.2 at 580p — balanced quality/cost, up to 10s',
    badge: 'NEW',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,
    resolution: '580p',    estimatedSeconds: 80,
    euroCost: 0.60,
    previewGradient: 'linear-gradient(135deg, #0f2027 0%, #1e3a5f 50%, #2c5364 100%)',
  },
  {
    // Wan 2.2 A14B — 480p budget tier (SAME endpoint, resolution=480p). MASTER FINAL 480p: 5/8/10 = 40/64/80.
    id: 'wan22_480',
    falEndpoint: 'fal-ai/wan/v2.2-a14b/text-to-video',
    label: 'Wan 2.2 480p',
    minPlan: 'starter',
    description: 'Alibaba Wan 2.2 at 480p — fast, low-cost, up to 10s',
    badge: 'FAST',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,
    resolution: '480p',    estimatedSeconds: 60,
    euroCost: 0.40,
    previewGradient: 'linear-gradient(135deg, #0f2027 0%, #1e3a5f 50%, #2c5364 100%)',
  },
  {
    // Wan 2.5 — real fal endpoint VERIFIED 200 (fal-ai/wan-25-preview/text-to-video; prompt-only, output=video, resolution 480p/720p/1080p, duration 5/10s).
    // COMING SOON: this is a PREVIEW (non-GA) endpoint + premium tier; audio capability (audio_url input) unverified for prompt-only. Hidden until provider GA + final pricing/audio. MASTER COMING SOON 2026-06-02.
    id: 'wan25',
    comingSoon: true,
    falEndpoint: 'fal-ai/wan-25-preview/text-to-video',
    label: 'Wan 2.5',
    minPlan: 'pro',
    description: 'Alibaba Wan 2.5 (preview) — premium text-to-video up to 1080p',
    badge: 'SOON',
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,
    resolution: '1080p',    estimatedSeconds: 120,
    euroCost: 1.50,
    previewGradient: 'linear-gradient(135deg, #0f2027 0%, #1e3a5f 50%, #2c5364 100%)',
  },
  {
    id: 'luma3',
    falEndpoint: 'fal-ai/luma-dream-machine/ray-2',
    label: 'Luma Dream Machine',
    minPlan: 'starter',
    description: 'Realistic camera movements and atmospheric lighting',
    // DURATION TRUTH 2026-06-06: fal-ai/luma-dream-machine/ray-2 accepts ONLY 5s/9s (route maps d>=9?"9s":"5s").
    // Old [5,8,10] over-offered — 8s silently delivered 5s, 10s delivered 9s. Now [5,9] so display == dispatch.
    durations: [5, 9],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,    // Image-to-Video exposed as a Mode within the Luma family (no extra picker row). Selecting it resolves the
    // effective runtime slug to luma3_i2v (dedicated …/ray-2/image-to-video endpoint: start image + optional end).
    extraVideoModes: ['image-to-video'],
    modeVariants: { 'image-to-video': 'luma3_i2v' },
    estimatedSeconds: 90,
    euroCost: 0.85,
    previewGradient: 'linear-gradient(135deg, #2d1b69 0%, #6d28d9 100%)',
  },
  {
    // Luma Ray Image-to-Video — runtime-only variant reached via the Luma family Mode control (NOT a picker row).
    // Endpoint verified (fal): fal-ai/luma-dream-machine/ray-2/image-to-video — prompt + image_url (start) +
    // optional end_image_url (end); duration enum 5s/9s; 540p locked in the route; no audio; no camera_motion.
    // Pricing reuses the luma3 base tier (route + preview map luma3_i2v → 'luma3'; NO separate VIDEO_PRICES key).
    id: 'luma3_i2v',
    falEndpoint: 'fal-ai/luma-dream-machine/ray-2/image-to-video',
    // Hidden from picker + StudioPage model lists (they filter !comingSoon). This is a runtime-only variant reached
    // via the Luma family Mode control, NOT a picker row. The video route does NOT gate on comingSoon → still fully
    // generatable in the Playground image-to-video flow. Keeps the new i2v variant out of the Cinema (/video) modal.
    comingSoon: true,
    label: 'Luma Dream Machine (Image-to-Video)',
    minPlan: 'starter',
    description: 'Animate a start image (with an optional end image) into video — Luma Ray.',
    durations: [5, 9],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,    supportsStartFrame: true,
    supportsEndFrame: true,
    estimatedSeconds: 90,
    euroCost: 0.85,
    previewGradient: 'linear-gradient(135deg, #2d1b69 0%, #6d28d9 100%)',
  },
  {
    id: 'pika25',
    falEndpoint: 'fal-ai/pika/v2.1/text-to-video',
    label: 'Pika 2.1', // Phase1 catalog-truth: served endpoint pika/v2.1 (was "Pika 2.2")
    minPlan: 'starter',
    description: 'Creative effects and stylized video content for social media',
    durations: [3, 5],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,    estimatedSeconds: 45,
    euroCost: 0.80,
    previewGradient: 'linear-gradient(135deg, #1a2a4a 0%, #3b0764 100%)',
  },
  // ── Pro+ ─────────────────────────────────────────────────────────────────
  {
    id: 'kling3',
    // Flagship "Kling 3.0" — routes to the v3/PRO tier (2026-06-11). Previously shared the v3/standard endpoint with
    // kling3_standard, which made flagship "Kling 3.0" deliver standard-tier output; now on its own pro-tier endpoint.
    falEndpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
    label: 'Kling 3.0',
    minPlan: 'pro',
    description: 'Multi-shot cinematic sequences — best-value text-to-video',
    badge: 'POPULAR',
    // Truthful durations: the route snaps v3 durations to 5/10/15, so 8s silently delivered 10s → removed (2026-06-06).
    // Pricing UNCHANGED (VIDEO_PRICES.kling3 + credits kept per spec) despite the endpoint move to v3/pro (2026-06-11).
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 120,
    euroCost: 1.20,
    previewGradient: 'linear-gradient(135deg, #003344 0%, #006688 100%)',
  },
  {
    id: 'kling3pro',
    falEndpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
    label: 'Kling 3.0 Pro',
    minPlan: 'pro',
    description: 'Professional cinematic control — up to 10 sec, maximum quality',
    badge: 'ULTRA',
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    // Kling 3.0 Pro I2V smoke test FAILED (2026-06-05); do NOT expose until the provider payload/audio schema for
    // fal-ai/kling-video/v3/pro/image-to-video is re-verified. Kept TEXT-TO-VIDEO only — no extraVideoModes/modeVariants,
    // no kling3pro_i2v variant, no v1.6 fallback. Seedance/Luma I2V + Kling V2.6 Start/End frame are unaffected.
    estimatedSeconds: 180,
    euroCost: 1.80,
    previewGradient: 'linear-gradient(135deg, #2a2000 0%, #665500 50%, #998800 100%)',
  },
  {
    id: 'happyhorse',
    comingSoon: true, // Phase3: VIDEO_PRICES.happyhorse missing → calculateVideoCost returns 0 → HTTP 400. Excel absent → safest gate. Endpoint itself verified 200 in Phase 2.
    falEndpoint: 'fal-ai/happy-horse/text-to-video',
    label: 'Happy Horse',
    minPlan: 'pro',
    description: 'Advanced cinematography with dynamic camera movements',
    badge: 'PRO',
    durations: [5, 8],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,    estimatedSeconds: 90,
    euroCost: 1.00,
    previewGradient: 'linear-gradient(135deg, #2d1b00 0%, #78350f 100%)',
  },
  {
    id: 'happyhorse10',
    falEndpoint: 'fal-ai/minimax/video-01',
    label: 'Happy Horse 1.0',
    minPlan: 'pro',
    description: '#1 ranked AI video — native 1080p + integrated audio',
    badge: '🔥 Exclusive',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 120,
    euroCost: 1.00,
    previewGradient: 'linear-gradient(135deg, #1a0500 0%, #92400e 50%, #b45309 100%)',
    features: ['native_audio', '1080p'],
  },
  {
    id: 'seedance20',
    falEndpoint: 'bytedance/seedance-2.0/text-to-video',
    label: 'Seedance 2.0',
    minPlan: 'pro',
    description: 'Native audio + video in one generation. Multi-shot sequences. 720p.',
    badge: 'PREMIUM',
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    // Image-to-Video exposed as a Mode within the Seedance family (no extra picker row). Selecting it resolves the
    // effective runtime slug to seedance20_i2v (dedicated …/image-to-video endpoint: single start image; native audio).
    extraVideoModes: ['image-to-video'],
    modeVariants: { 'image-to-video': 'seedance20_i2v' },
    estimatedSeconds: 150,
    euroCost: 1.60,
    previewGradient: 'linear-gradient(135deg, #3a1500 0%, #8b3200 50%, #ff6b35 100%)',
    features: ['native_audio', 'multi_shot', '720p'],
  },
  {
    id: 'seedance2',
    falEndpoint: 'bytedance/seedance-2.0/fast/text-to-video',
    label: 'Seedance 2.0 Fast',
    minPlan: 'pro',
    description: 'Advanced animation with integrated audio support',
    badge: 'Pro+Audio',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    // Image-to-Video exposed as a Mode within the Seedance Fast family (resolves to seedance2_i2v — single start image).
    extraVideoModes: ['image-to-video'],
    modeVariants: { 'image-to-video': 'seedance2_i2v' },
    estimatedSeconds: 150,
    euroCost: 1.60,
    previewGradient: 'linear-gradient(135deg, #3b0764 0%, #6d28d9 50%, #4c1d95 100%)',
  },
  {
    id: 'seedance2lite',
    comingSoon: true, // Phase1 catalog-truth: MUAPI status wiring not implemented
    falEndpoint: null,
    muapiModel: 'seedance-2-lite',
    label: 'Seedance 2.0 Lite',
    minPlan: 'pro',
    description: 'Seedance 2.0 Lite — audio, fast generation, exclusive via MUAPI',
    badge: 'MUAPI',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 90,
    euroCost: 0.80,
    previewGradient: 'linear-gradient(135deg, #1a0040 0%, #4c0080 50%, #7c3aed 100%)',
    features: ['native_audio'],
  },
  {
    // Seedance 2.0 Image-to-Video — runtime-only variant reached via the Seedance family Mode control (NOT a picker row).
    // Endpoint (verified via Cinema registry): bytedance/seedance-2.0/image-to-video — prompt + SINGLE start image_url +
    // native audio. NO end frame, NO multi-reference, NO role payload. Pricing reuses the seedance20 base tier
    // (route + preview map seedance20_i2v → 'seedance20'; NO separate VIDEO_PRICES key).
    id: 'seedance20_i2v',
    falEndpoint: 'bytedance/seedance-2.0/image-to-video',
    comingSoon: true, // hidden from picker/StudioPage (filter !comingSoon); reached only via the Mode control. Route does NOT gate on comingSoon → fully generatable.
    label: 'Seedance 2.0 (Image-to-Video)',
    minPlan: 'pro',
    description: 'Animate a start image into video with native audio — Seedance 2.0.',
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    supportsStartFrame: true,
    supportsEndFrame: false,
    estimatedSeconds: 150,
    euroCost: 1.60,
    previewGradient: 'linear-gradient(135deg, #3a1500 0%, #8b3200 50%, #ff6b35 100%)',
  },
  {
    // Seedance 2.0 Fast Image-to-Video — runtime-only variant reached via the Seedance Fast family Mode control.
    // Endpoint (verified): bytedance/seedance-2.0/fast/image-to-video — SINGLE start image_url + native audio. NO end
    // frame, NO multi-reference, NO role payload. Pricing reuses seedance2 (map seedance2_i2v → 'seedance2'; no new key).
    id: 'seedance2_i2v',
    falEndpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    comingSoon: true,
    label: 'Seedance 2.0 Fast (Image-to-Video)',
    minPlan: 'pro',
    description: 'Animate a start image into video (fast) with native audio — Seedance 2.0 Fast.',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    supportsStartFrame: true,
    supportsEndFrame: false,
    estimatedSeconds: 90,
    euroCost: 1.60,
    previewGradient: 'linear-gradient(135deg, #3b0764 0%, #6d28d9 50%, #4c1d95 100%)',
  },
  {
    // Resolved 2026-06-02: real fal-hosted endpoint xai/grok-imagine-video/text-to-video VERIFIED (prompt-only, output=video, resolution default 720p, native audio). Exposed at 720p; MASTER FINAL 5/8/10/15 = 70/112/140/210, audio surcharge 0. (Was wrongly routed to Luma + coming_soon.)
    id: 'grokvideo',
    falEndpoint: 'xai/grok-imagine-video/text-to-video',
    label: 'Grok Imagine Video',
    minPlan: 'pro',
    description: 'xAI Grok Imagine — expressive, physics-aware video with native audio (720p)',
    badge: 'PRO',
    durations: [5, 8, 10, 15],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,
    resolution: '720p', // endpoint default; sent explicitly for robustness. Charged via VIDEO_PRICES.grokvideo (720p).
    // In-box quality control (v1.2 wiring): one Grok experience; quality → effective variant slug. Audio is native/included (NO toggle).
    qualityOptions: ['480p', '720p'],
    qualityVariants: { '480p': 'grokvideo480', '720p': 'grokvideo' },    estimatedSeconds: 60,
    euroCost: 0.90,
    previewGradient: 'linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 50%, #111827 100%)',
  },
  {
    // Grok Imagine Video 480p budget tier — SAME verified fal endpoint as grokvideo, resolution=480p sent per-model. MASTER FINAL 5/8/10/15 = 50/80/100/150, audio surcharge 0.
    id: 'grokvideo480',
    falEndpoint: 'xai/grok-imagine-video/text-to-video',
    label: 'Grok Imagine Video 480p',
    minPlan: 'pro',
    description: 'xAI Grok Imagine at 480p — faster, lower-cost, with native audio',
    badge: 'FAST',
    durations: [5, 8, 10, 15],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,
    resolution: '480p',    estimatedSeconds: 50,
    euroCost: 0.75,
    previewGradient: 'linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 50%, #111827 100%)',
  },
  {
    id: 'veo4',
    falEndpoint: 'fal-ai/veo2',
    label: 'Veo 2', // Phase1 catalog-truth: served endpoint fal-ai/veo2 (was "Veo 4")
    minPlan: 'pro',
    description: 'Google Veo 2 — cinematic text-to-video with camera motion and native audio',
    badge: '⭐ New',
    // Truthful durations: fal-ai/veo2 caps at 8s and the route clamps to Math.min(d,8), so 10s was removed
    // (2026-06-05) — UI must not offer/charge 10s while the provider delivers 8s. VIDEO_PRICES.veo4[10] is
    // intentionally KEPT for historical/back-compat; the clamp stays as a safety fallback. Matches Cinema [5,8].
    durations: [5, 8],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 200,
    euroCost: 2.00,
    previewGradient: 'linear-gradient(135deg, #0c1445 0%, #1a237e 50%, #3730a3 100%)',
    features: ['native_audio', 'camera_control'],
  },
  {
    // SUPERSEDED 2026-06-02 by the verified Veo 3 entries below (id 'veo3'/'veo3_silent', locked pricing,
    // truthful 4/6/8s + 16:9/9:16). Left unused/not-exposed (no catalog row, no bridge) to avoid breaking references.
    id: 'veo4_standard',
    falEndpoint: 'fal-ai/veo3',
    label: 'Veo 3', // Phase1 catalog-truth: served endpoint fal-ai/veo3 (was "Veo 4 Standard")
    minPlan: 'pro',
    description: 'Google Veo 4 Standard — 1080p high quality with AI audio',
    badge: 'PRO',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 160,
    euroCost: 1.60,
    previewGradient: 'linear-gradient(135deg, #0a1628 0%, #1e3a8a 50%, #1d4ed8 100%)',
  },
  {
    // Veo 3 — real fal endpoint VERIFIED 200 (fal-ai/veo3; prompt-only, output=video, duration enum 4s/6s/8s,
    // generate_audio on/off, aspect 16:9/9:16, resolution default 720p). Audio-ON variant. MASTER FINAL: 4/6/8s = 111/166/223.
    id: 'veo3',
    falEndpoint: 'fal-ai/veo3',
    label: 'Veo 3',
    minPlan: 'pro',
    description: 'Google Veo 3 — cinematic video, optional native audio (720p, 4-8s)',
    badge: 'PRO',
    durations: [4, 6, 8],
    aspectRatios: ['16:9', '9:16'],
    hasAudio: true,
    // In-box audio control (v1.2 wiring): one Veo 3 experience; audio on/off uses the veo3 no/yes price column
    // + generate_audio. (The interim 'veo3_silent' picker entry stays until the next picker-merge task.)
    audioToggle: true,    estimatedSeconds: 150,
    euroCost: 6.00,
    previewGradient: 'linear-gradient(135deg, #0a1628 0%, #1e3a8a 50%, #1d4ed8 100%)',
  },
  {
    // Veo 3 — audio-OFF (silent) variant. SAME endpoint, generate_audio=false (hasAudio:false → with_audio:false).
    // MASTER FINAL: 4/6/8s = 76/110/147 (no audio surcharge).
    id: 'veo3_silent',
    falEndpoint: 'fal-ai/veo3',
    label: 'Veo 3 (Silent)',
    minPlan: 'pro',
    description: 'Google Veo 3 without audio — lower-cost silent video (720p, 4-8s)',
    badge: 'PRO',
    durations: [4, 6, 8],
    aspectRatios: ['16:9', '9:16'],
    hasAudio: false,    estimatedSeconds: 150,
    euroCost: 4.00,
    previewGradient: 'linear-gradient(135deg, #0a1628 0%, #1e3a8a 50%, #1d4ed8 100%)',
  },
  {
    // Phase5: renamed id veo31 → veo31_standard (creditKey split), endpoint corrected fal-ai/veo3 → fal-ai/veo3.1 (verified $0.40/sec), un-gated.
    id: 'veo31_standard',
    falEndpoint: 'fal-ai/veo3.1',
    label: 'Veo 3.1',
    minPlan: 'pro',
    description: 'Google Veo 3.1 Standard — premium quality with native audio',
    badge: 'PRO',
    // DURATION TRUTH 2026-06-06: fal-ai/veo3.1 accepts ONLY 4s/6s/8s (live 422 proved 5/10/15 invalid; API schema confirmed). Was [5,10,15].
    durations: [4, 6, 8],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    // First/Last Frame exposed as a Mode within the Veo 3.1 family (no extra picker row). Selecting the mode
    // resolves the effective runtime slug to veo31_flf (its own endpoint / 4-6-8s durations / frames / price).
    extraVideoModes: ['first-last-frame'],
    modeVariants: { 'first-last-frame': 'veo31_flf' },
    estimatedSeconds: 180,
    euroCost: 1.80,
    previewGradient: 'linear-gradient(135deg, #0c1445 0%, #1a237e 50%, #283593 100%)',
  },
  {
    // Veo 3.1 First/Last Frame — runtime-only variant reached via the Veo 3.1 family Mode control (NOT a picker row).
    // Endpoint verified (fal OpenAPI): fal-ai/veo3.1/first-last-frame-to-video requires prompt + first_frame_url +
    // last_frame_url; duration enum '4s'/'6s'/'8s'; generate_audio (audio included); default 720p. Standard tier only
    // this task — no Fast, no separate 1080p/4K pricing. Price key veo31_flf: 4s 65 / 6s 97 / 8s 129 (no==yes).
    id: 'veo31_flf',
    falEndpoint: 'fal-ai/veo3.1/first-last-frame-to-video',
    label: 'Veo 3.1 First/Last Frame',
    minPlan: 'pro',
    description: 'Google Veo 3.1 — first/last-frame interpolation between a start and end image (native audio)',
    badge: 'PRO',
    durations: [4, 6, 8],
    aspectRatios: ['16:9', '9:16'],
    hasAudio: true,    supportsStartFrame: true,
    supportsEndFrame: true,
    estimatedSeconds: 180,
    euroCost: 1.95,
    previewGradient: 'linear-gradient(135deg, #0c1445 0%, #1a237e 50%, #283593 100%)',
  },
  {
    // Group 2: Veo 3.1 Fast — endpoint fal-ai/veo3.1/fast verified 200; creditKey veo31 (MASTER FINAL: 5s 19/28, 10s 37/56, 15s 56/83). Capability mirrors veo31_standard.
    id: 'veo31',
    falEndpoint: 'fal-ai/veo3.1/fast',
    label: 'Veo 3.1 Fast',
    minPlan: 'pro',
    description: 'Google Veo 3.1 Fast — faster, lower-cost generation with native audio',
    badge: 'FAST',
    // DURATION TRUTH 2026-06-06: fal-ai/veo3.1/fast accepts ONLY 4s/6s/8s (fal API schema verified, default 8s). Was [5,10,15].
    durations: [4, 6, 8],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 120,
    euroCost: 0.50,
    previewGradient: 'linear-gradient(135deg, #0c1445 0%, #1a237e 50%, #283593 100%)',
  },
  {
    id: 'kling3_4k',
    falEndpoint: 'fal-ai/kling-video/v3/4k/text-to-video',
    label: 'Kling V3 4K',
    minPlan: 'pro',
    description: 'Ultra-HD 4K video up to 15s with native audio.',
    badge: 'NEW',
    durations: [5, 10, 15],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 240,
    euroCost: 2.00,
    previewGradient: 'linear-gradient(135deg, #001a33 0%, #003366 100%)',
  },
  {
    id: 'kling3_standard',
    falEndpoint: 'fal-ai/kling-video/v3/standard/text-to-video',
    label: 'Kling V3 Standard',
    minPlan: 'starter',
    description: 'Balanced speed and quality for everyday video generation.',
    badge: 'HOT',
    durations: [5, 10, 15],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 120,
    euroCost: 0.80,
    previewGradient: 'linear-gradient(135deg, #003344 0%, #006688 100%)',
  },
  {
    id: 'kling3_omni',
    // Distinct product entry sharing the v3/pro endpoint with kling3pro (owner-confirmed; fal endpoint verified valid). Not coming soon.
    falEndpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
    label: 'Kling V3 Omni',
    minPlan: 'pro',
    description: 'Flexible generation across creative styles using V3 Omni architecture.',
    badge: 'NEW',
    durations: [5, 10, 15],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    estimatedSeconds: 200,
    euroCost: 1.20,
    previewGradient: 'linear-gradient(135deg, #1a0040 0%, #4400aa 100%)',
  },
  {
    id: 'kling26_pro',
    falEndpoint: 'fal-ai/kling-video/v2.6/pro/text-to-video',
    label: 'Kling V2.6 Pro',
    minPlan: 'pro',
    description: 'Mature pipeline with audio, adjustable cfg, and pro rendering.',
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    // Kling V2.6 start/end frame: VERIFIED — the v2.6 text-to-video endpoint accepts image_url (start) +
    // tail_image_url (end). route.ts already maps first_frame_url→image_url, last_frame_url→tail_image_url, so this
    // is flags-only (no route/pricing/credits change, no new endpoint/variant). V3 endpoints stay prompt-only.
    supportsStartFrame: true,
    supportsEndFrame: true,
    estimatedSeconds: 180,
    euroCost: 1.00,
    previewGradient: 'linear-gradient(135deg, #2a2000 0%, #665500 50%, #998800 100%)',
  },
  {
    id: 'kling26_standard',
    falEndpoint: 'fal-ai/kling-video/v2.6/standard/text-to-video',
    label: 'Kling V2.6 Standard',
    minPlan: 'starter',
    description: 'Reliable 5-10s video with cfg scale control and rendering speed options.',
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: true,    // Kling V2.6 start/end frame: VERIFIED — the v2.6 text-to-video endpoint accepts image_url (start) +
    // tail_image_url (end). route.ts already maps first_frame_url→image_url, last_frame_url→tail_image_url, so this
    // is flags-only (no route/pricing/credits change, no new endpoint/variant). V3 endpoints stay prompt-only.
    supportsStartFrame: true,
    supportsEndFrame: true,
    estimatedSeconds: 120,
    euroCost: 0.50,
    previewGradient: 'linear-gradient(135deg, #003344 0%, #006688 100%)',
  },
  {
    // Kling O1 Reference-to-Video — REAL reference-to-video: prompt + 1..N subject/character reference images sent as
    // image_urls[]. Endpoint fal-ai/kling-video/o1/reference-to-video. Pricing ALREADY locked in VIDEO_PRICES.kling_o1_reference
    // (5s=25 / 10s=50, no audio variant → no==yes). NO start/end/FLF frame, NO image_url. Fills the video
    // character/subject-consistency gap (audit 2026-06-07). hasAudio:false so no fake audio toggle + correct (no) price column.
    id: 'kling_o1_reference',
    falEndpoint: 'fal-ai/kling-video/o1/reference-to-video',
    label: 'Kling O1',
    minPlan: 'pro',
    description: 'Reference-to-video with multiple image references for subject/character consistency.',
    badge: 'NEW',
    durations: [5, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    hasAudio: false,
    supportsImageReference: true,
    maxImageReferences: 4, // product-safe cap; refs are sent as image_urls[] (NOT image_url / start / end frames)
    estimatedSeconds: 150,
    euroCost: 0.75,
    previewGradient: 'linear-gradient(135deg, #1a0040 0%, #4400aa 100%)',
  },
  {
    // Sora 2 — real fal endpoint VERIFIED 200 (fal-ai/sora-2/text-to-video; prompt-only [character_ids optional/unused],
    // duration enum 4/8/12/16/20s, native audio, aspect 16:9/9:16, 720p). Route sets delete_video:false; status route persists to our storage.
    // MASTER FINAL locked: 4/8/12/16/20s = 24/34/52/64/82, audio surcharge 0.
    id: 'sora2',
    falEndpoint: 'fal-ai/sora-2/text-to-video',
    label: 'Sora 2',
    minPlan: 'pro',
    description: 'OpenAI Sora 2 — cinematic text-to-video with native audio (4-20s)',
    badge: 'NEW',
    durations: [4, 8, 12, 16, 20],
    aspectRatios: ['16:9', '9:16'],
    hasAudio: true,    estimatedSeconds: 120,
    euroCost: 2.00,
    previewGradient: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%)',
  },
  {
    // Sora 2 Pro — real fal endpoint VERIFIED 200 (fal-ai/sora-2/text-to-video/pro; prompt-only [character_ids optional/unused],
    // duration enum 4/8/12/16/20s, native audio, aspect 16:9/9:16). Endpoint default resolution is 1080p — the route FORCES 720p to match the 720p-only locked pricing.
    // MASTER FINAL locked (720p): 4/8/12/16/20s = 65/103/135/178/217, audio surcharge 0.
    id: 'sora2pro',
    falEndpoint: 'fal-ai/sora-2/text-to-video/pro',
    label: 'Sora 2 Pro',
    minPlan: 'pro',
    description: 'OpenAI Sora 2 Pro — premium cinematic text-to-video with native audio (720p, 4-20s)',
    badge: 'PRO',
    durations: [4, 8, 12, 16, 20],
    aspectRatios: ['16:9', '9:16'],
    hasAudio: true,    estimatedSeconds: 150,
    euroCost: 6.00,
    previewGradient: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%)',
  },
]

export function getModelById(id: string): VideoModelConfig | undefined {
  return VIDEO_MODELS.find((m) => m.id === id)
}
