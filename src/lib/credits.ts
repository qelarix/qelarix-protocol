export const CREDITS = {
  image: {
    // v1.2 image truth cleanup 2026-06-03 — credits from cleaned MASTER (Final Image Pricing). 1 credit = $0.03.
    sd35: 2,                // MASTER: ~$0.03 est
    imagen4fast: 3,         // MASTER: ~$0.06 est
    nanobanana2: 4,         // MASTER: Nano Banana 2 1K tier ($0.08) — tiered via fal resolution enum
    nanobanana2_2k: 6,      // MASTER: Nano Banana 2 2K ($0.12)
    nanobanana2_4k: 8,      // MASTER: Nano Banana 2 4K ($0.16)
    flux2pro: 2,            // MASTER: FLUX 2 Pro, $0.03/MP (fal-ai/flux-2-pro)
    ideogram: 3,            // MASTER: Ideogram V3 BALANCED (default, $0.06) — rendering_speed tier
    ideogram_turbo: 2,      // MASTER: Ideogram V3 TURBO ($0.03)
    ideogram_quality: 5,    // MASTER: Ideogram V3 QUALITY ($0.09)
    recraft: 5,             // MASTER: Recraft V3 (~$0.09 est) — served fal-ai/recraft/v3
    grokimagine: 4,         // MASTER: Grok Imagine — provider cost verified $0.07/image; 4 credits = $0.12; margin ~1.71x
    nanobanana_pro: 8,      // MASTER: Nano Banana Pro 2K ($0.15)
    nanobanana_pro_4k: 12,  // MASTER: Nano Banana Pro 4K ($0.30)
    flux2max: 3,            // MASTER: FLUX 1.1 Pro Ultra (~$0.06 est) — served fal-ai/flux-pro/v1.1-ultra
    seedream5: 2,           // MASTER: Seedream 4.0 2K ($0.03 flat) — fal-ai/bytedance/seedream/v4. Resolution tier (image_size object).
    seedream5_4k: 3,        // MASTER: Seedream 4.0 4K ($0.03 flat — no 4K surcharge) — image_size up to 4096²; Qelarix resolution premium
    seedream45: 2,          // MASTER: Seedream 4.5 2K ($0.04 flat) — fal-ai/bytedance/seedream/v4.5. Resolution tier (image_size object).
    seedream45_4k: 3,       // MASTER: Seedream 4.5 4K ($0.04 flat — no 4K surcharge) — image_size up to 4096²; Qelarix resolution premium
    // GPT Image 2 (REAL OpenAI gpt-image-2 — NOT DALL·E). v1.2 integration 2026-06-03: now an ACTIVE Playground model
    // with quality tiers (OpenAI low/medium/high → user labels GPT Fast/Standard/Ultra). Served via a direct OpenAI
    // Images API route branch (b64 → existing `generations` storage bucket). NO DALL·E, NO DALL·E fallback.
    gptimage2_fast: 2,      // GPT Fast     → OpenAI quality "low"    (~$0.006/img est)
    gptimage2: 4,           // GPT Standard → OpenAI quality "medium" (~$0.053/img est) — DEFAULT
    gptimage2_ultra: 12,    // GPT Ultra    → OpenAI quality "high"   (~$0.211/img est)
    // ⚠️ INERT compat key — kept ONLY for the Cinema StudioPage `ImageModel` type (off-limits). gpt-image-2 has no
    // "hd" tier; not read at runtime. Do NOT re-expose DALL·E.
    gptimage2_hd: 24,
  },
  // ⚠️ LEGACY / NON-RUNTIME — superseded by VIDEO_PRICES + calculateVideoCost (the real per
  // duration×audio video charge). Kept only as historical reference; no route reads CREDITS.video
  // or getVideoCredits at runtime (verified). The catalog display credit derives from VIDEO_PRICES
  // via catalog.getModelCredits — do NOT reintroduce these flat numbers into pricing/deduction.
  video: {
    ltx2: 40,
    wan26: 60,
    luma3: 85,
    pika25: 80,
    kling3: 120,
    kling3pro: 180,
    happyhorse: 100,
    happyhorse10: 100,
    seedance2: 160,
    seedance20: 160,
    grokvideo: 90,
    runway: 100,
    veo31: 180,
    veo31audio: 280,
    veo4: 200,
    veo4audio: 320,
    veo4_standard: 160,
    seedance2lite: 80,
    kling3_4k: 200,
    kling3_standard: 80,
    kling3_omni: 120,
    kling26_pro: 100,
    kling26_standard: 50,
  },
  audio: {
    stability30s: 20,
    stability60s: 40,
    stability2min: 80,
    // ── Audio batch v1.2 (provider truth from fal model pages; $0.03/credit, margin >= 1.1) ──
    eleven_v3: 6,               // fal-ai/elevenlabs/tts/eleven-v3 — $0.10/1000 chars; per-gen <=1000 chars
    eleven_multilingual_v2: 6,  // fal-ai/elevenlabs/tts/multilingual-v2 — $0.10/1000 chars
    lyria2: 8,                  // fal-ai/lyria2 — $0.10/30s instrumental music
    ace_step_60: 8,             // fal-ai/ace-step — song w/ lyrics, <=60s ($0.0002/sec)
    ace_step_120: 12,           // fal-ai/ace-step — song w/ lyrics, <=120s
    elevenlabs_music_1m: 40,    // fal-ai/elevenlabs/music — $0.80/output min (rounds UP); 1 min → 1.5x floor
    elevenlabs_music_2m: 80,    // 2 min → $1.60 → 1.5x
    elevenlabs_music_3m: 120,   // 3 min → $2.40 → 1.5x  (no 30s tier: provider rounds up to 1 min)
    suno_generate_sounds: 8,    // muapi suno-generate-sounds — SFX; COMING_SOON (provisional)
  },
  edit: {
    bg_remove: 5,
    upscale2x: 10,
    upscale4x: 20,
    face_swap: 10,
    outfit: 15,
    inpaint: 20,
    expand: 15,
    relight: 15,
  },
  marketing: {
    seedance_15s: 80,
    seedance_30s: 160,
    seedance_60s: 280,
  },
  character: {
    flux_kontext: 15,
  },
  storyboard: {
    scene: 15,
    regenerate: 5,
  },
  shorts: {
    voiceover: 30,
    video_30s: 200,
    video_60s: 400,
  },
  lipSync: {
    latentsync: 20,
    wav2lip_hd: 25,
    musetalk: 30,
    ditto: 30,
    hedra: 35,
    infinite_talk: 30,
    ltx_lipsync: 25,
    video_retalking: 25,
    sadtalker: 20,
    // ── Lip Sync Phase 1 expansion (fal.ai; per-second pricing → client duration caps). ──
    kling_lipsync: 12,              // fal-ai/kling-video/lipsync/audio-to-video (V2V, ~$0.03/clip → ~12x)
    kling_avatar_v2_standard: 30,   // fal-ai/kling-video/ai-avatar/v2/standard (I2V, ~$0.45/8s → ~2x)
    kling_avatar_v2_pro: 50,        // fal-ai/kling-video/ai-avatar/v2/pro (I2V, ~$0.92/8s → ~1.6x)
    sync_lipsync_2_pro: 40,         // fal-ai/sync-lipsync/v2/pro (V2V, ~$0.67/8s → ~1.8x)
  },
  influencer: {
    generate_image: 15,
    generate_video: 120,
    generate_voice: 20,
  },
  muapi: {
    video_extend_5s: 60,
    video_extend_10s: 100,
    watermark_remover: 30,
    seedance2lite: 80,
    background_remover: 4,   // MuAPI ai-background-remover ($0.01/run verified) — Apps /apps/background-remover. MASTER Final Image Pricing.
    skin_enhancer: 6,        // MuAPI ai-skin-enhancer ($0.01/run verified) — Apps /apps/skin-enhancer. MASTER pricing to be locked after review.
    object_eraser: 15,       // MuAPI ai-object-eraser ($0.05/run verified, needs mask_image_url) — Apps /apps/object-eraser. MASTER pricing to be locked after review.
    product_photos: 8,       // MuAPI ai-product-shot (needs image_url + scene_description; ~$0.06/run, $0.02 observed) — Apps /apps/product-photos. (ai-product-photography was provider-broken/422.) MASTER pricing to be locked after review.
    style_snap: 8,           // MuAPI ai-dress-change ($0.10/run verified, needs model_image_url + garment_image_url) — Apps /apps/style-snap. User-approved 8 cr (~2.4x). MASTER pricing to be locked after review.
    image_extension: 8,      // fal-ai/ideogram/v3/reframe (Ideogram V3 Reframe, Quality tier $0.09/run) — Apps /apps/image-extension. image_url + image_size(10 target ratios). User-approved 8 cr (~2.7x, 62.5% margin). On fal after MuAPI ideogram-v3-reframe was provider-unstable. (Key kept under `muapi` for continuity.) MASTER pricing to be locked after review.
  },
  // ── fal.ai image tools (canonical fal namespace). ──
  fal: {
    text_remover: 5,         // fal-ai/image-editing/text-removal ($0.04/run) — Apps /apps/text-remover. image_url only, automatic TEXT removal (NOT a watermark/logo remover), output images[0].url. User-approved 5 cr (~3.75x, 73.3% margin). MASTER pricing to be locked after review.
  },
  // ── Video Tools v1 — MASTER locked 2026-06-12 (Final Video Pricing rows 152-158). ──
  // Upscale (fal-ai/bytedance-upscaler/upscale/video): credits per OUTPUT second @30fps; 60fps = 2x credits
  // (2x provider cost, same margin). Pro mode = COMING SOON / DISABLED — never charge/expose it.
  // Extend (fal-ai/pixverse/extend): flat per 5s extension clip. MUAPI extend above stays CURRENT untouched.
  videoTools: {
    video_upscale_1080p: 1,           // $0.0072/s provider → 1 cr/s (margin 4.17x)
    video_upscale_2k: 1,              // $0.0144/s provider → 1 cr/s (margin 2.08x)
    video_upscale_4k: 2,              // $0.0288/s provider → 2 cr/s (margin 2.08x)
    video_extend_pixverse_720p: 12,   // $0.20 provider → 12 cr / 5s clip (margin 1.8x)
    video_extend_pixverse_1080p: 20,  // $0.40 provider → 20 cr / 5s clip (margin 1.5x)
  },
} as const;

export type ImageModel = keyof typeof CREDITS.image;
export type VideoModel = keyof typeof CREDITS.video;
export type AudioModel = keyof typeof CREDITS.audio;
export type EditOperation = keyof typeof CREDITS.edit;

export function getImageCredits(model: ImageModel): number {
  return CREDITS.image[model];
}
/** @deprecated Legacy flat base price — NOT the real charge. Use calculateVideoCost(slug, duration, withAudio)
 *  (VIDEO_PRICES) for any video cost. Retained only for backward compatibility; currently unused at runtime. */
export function getVideoCredits(model: VideoModel): number {
  return CREDITS.video[model];
}
export function getAudioCredits(model: AudioModel): number {
  return CREDITS.audio[model];
}
export function getEditCredits(operation: EditOperation): number {
  return CREDITS.edit[operation];
}

export type MarketingDuration = keyof typeof CREDITS.marketing;
export type CharacterModel = keyof typeof CREDITS.character;

// ─────────────────────────────────────────────────────────────────
// PREVIOUS VALUES (kept for reference — DO NOT DELETE)
// ─────────────────────────────────────────────────────────────────
// CREDITS.video (flat base prices):
// ltx2:40, wan26:60, luma3:85, pika25:80, kling3:120, kling3pro:180,
// happyhorse:100, happyhorse10:100, seedance2:160, seedance20:160,
// grokvideo:90, runway:100, veo31:180, veo31audio:280, veo4:200,
// veo4audio:320, veo4_standard:160, seedance2lite:80, kling3_4k:200,
// kling3_standard:80, kling3_omni:120, kling26_pro:100, kling26_standard:50
//
// DURATION_MULTIPLIERS (in video-models.ts):
// { 3: 0.6, 5: 1.0, 8: 1.5, 10: 2.0 }
// ─────────────────────────────────────────────────────────────────

export const VIDEO_PRICES: Record<string, Record<number, { no: number; yes: number }>> = {
  ltx2:            { 3: { no: 8,   yes: 8   }, 5: { no: 10,  yes: 10  } },
  wan26:           { 3: { no: 10,  yes: 10  }, 5: { no: 15,  yes: 15  }, 8:  { no: 20,  yes: 20  } },
  // Wan 2.2 A14B (fal-ai/wan/v2.2-a14b/text-to-video, no audio, surcharge 0). 5/8/10s only — 15s exceeds the 161-frame cap. MASTER FINAL 2026-06-02.
  wan22:           { 5: { no: 32,  yes: 32  }, 8: { no: 52,  yes: 52  }, 10: { no: 64,  yes: 64  } }, // 720p — REBALANCE 2026-06-03: 6x→~2.4x markup (was 80/128/160); budget model, no premium punishment
  wan22_580:       { 5: { no: 24,  yes: 24  }, 8: { no: 38,  yes: 38  }, 10: { no: 48,  yes: 48  } }, // 580p — REBALANCE 2026-06-03 (was 60/96/120)
  wan22_480:       { 5: { no: 16,  yes: 16  }, 8: { no: 26,  yes: 26  }, 10: { no: 32,  yes: 32  } }, // 480p — REBALANCE 2026-06-03 (was 40/64/80)
  luma3:           { 5: { no: 30,  yes: 30  }, 9: { no: 50,  yes: 50  } }, // DURATION TRUTH 2026-06-06: removed invalid 8s/10s keys (fal ray-2 does 5s/9s only). KEPT 5=30 (~1.64x) / 9=50 (~1.52x) — already >=1.5x at the recorded $0.11/s; NOT lowered to a 25/45 floor (that would dip <1.5x). Luma has no audio (no==yes).
  pika25:          { 3: { no: 12,  yes: 12  }, 5: { no: 20,  yes: 20  } },
  kling3:          { 5: { no: 30,  yes: 38  }, 8: { no: 45,  yes: 56  }, 10: { no: 52,  yes: 65  }, 15: { no: 75,  yes: 94  } }, // RECONCILE 2026-06-03: 10s 50/63→52/65 to MASTER (margin 1.11; code was 1.07 rounding drift)
  kling3pro:       { 5: { no: 50,  yes: 63  }, 10: { no: 92,  yes: 115 } }, // RECONCILE 2026-06-03: 10s 90/113→92/115 to MASTER (margin 1.10; code was 1.08 rounding drift)
  // Phase5 FINAL (Excel rows kling3_4k_5/10/15_4k_no, codeKey=kling3_4k, "Kling V3 4K", per-second billing): old 5→78, 10→155, 15→232.
  // PRICING FIX 2026-06-05: provider cost VERIFIED $0.42/s FLAT regardless of audio (fal). Raised to 1.5x floor: 5→106, 10→211, 15→315.
  // The prior +25% audio surcharge had NO provider basis (4K audio costs the same as no-audio) → removed: no==yes (provider pass-through only).
  kling3_4k:       { 5: { no: 106, yes: 106 }, 10: { no: 211, yes: 211 }, 15: { no: 315, yes: 315 } },
  kling3_standard: { 5: { no: 25,  yes: 31  }, 10: { no: 45,  yes: 56  }, 15: { no: 61,  yes: 76  } }, // RECONCILE 2026-06-03: 15s 60/75→61/76 to MASTER (margin 1.11; code was 1.09 rounding drift)
  kling3_omni:     { 5: { no: 35,  yes: 44  }, 10: { no: 67,  yes: 83  }, 15: { no: 100, yes: 124 } }, // RECONCILE 2026-06-03: 10s 60/75→67/83, 15s 80/100→100/124 to MASTER (code 15s was 0.89× = BELOW provider cost)
  kling26_pro:     { 5: { no: 30,  yes: 38  }, 10: { no: 55,  yes: 69  } },
  kling26_standard:{ 5: { no: 18,  yes: 23  }, 10: { no: 32,  yes: 40  } },
  happyhorse10:    { 5: { no: 30,  yes: 38  }, 8:  { no: 35,  yes: 35  }, 10: { no: 55,  yes: 69  } }, // RECONCILE 2026-06-03: 5s/10s→MASTER (30/38, 55/69; code yes was below provider cost). coming_soon. 8s no MASTER row (kept 35/35)
  seedance2lite:   { 5: { no: 25,  yes: 31  }, 8:  { no: 35,  yes: 44  }, 10: { no: 50,  yes: 63  } },
  // Seedance 2.0 Fast (codeKey=seedance2, $0.2419/s @720p, 1.5x floor on the 'no' base). AUDIO TRUTH 2026-06-06: audio is
  // PROVIDER-INCLUDED at NO extra cost — verified by official fal docs ("Audio generation is included at no extra cost
  // regardless of the generate_audio setting") + live 10s audio test ($3.04 = base rate). The prior +25% audio surcharge
  // was WRONG (overcharged audio) → REMOVED: yes = no. ('no' base values unchanged.)
  seedance2:       { 5: { no: 61,  yes: 61  }, 8:  { no: 97,  yes: 97  }, 10: { no: 121, yes: 121 }, 15: { no: 182, yes: 182 } },
  // Seedance 2.0 (codeKey=seedance20, $0.3034/s @720p, 1.5x floor on the 'no' base). AUDIO TRUTH 2026-06-06: audio is
  // PROVIDER-INCLUDED at NO extra cost — verified by official fal docs + live 10s audio test (provider $3.04 = base rate,
  // no surcharge). The prior +25% audio surcharge was WRONG (overcharged ~+25%) → REMOVED: yes = no. ('no' base unchanged.)
  seedance20:      { 5: { no: 76,  yes: 76  }, 10: { no: 152, yes: 152 }, 15: { no: 228, yes: 228 } },
  // Kling O1 Reference (elements + image_urls). Excel source-of-truth: 5s=25, 10s=50 (no audio variant). Model is live (comingSoon flag removed).
  kling_o1_reference: { 5: { no: 25, yes: 25 }, 10: { no: 50, yes: 50 } },
  // Phase4 FINAL (Excel rows grok_5/10/15_720_yes, codeKey=grokvideo, "Grok Imagine Video", audio Yes/Included): 5→30, 10→60, 15→90. Model currently coming_soon — applies on future activation.
  grokvideo:       { 5: { no: 30,  yes: 30  }, 8: { no: 48,  yes: 48  }, 10: { no: 60,  yes: 60  }, 15: { no: 90,  yes: 90  } }, // REBALANCE 2026-06-03: Grok 720p 6x→~2.5x markup (was 70/112/140/210; audio included, surcharge 0)
  grokvideo480:    { 5: { no: 21,  yes: 21  }, 8: { no: 34,  yes: 34  }, 10: { no: 42,  yes: 42  }, 15: { no: 63,  yes: 63  } }, // REBALANCE 2026-06-03: Grok 480p (was 50/80/100/150; audio included, surcharge 0)
  // Veo 3.1 Fast (codeKey=veo31, fal-ai/veo3.1/fast). DURATION FIX 2026-06-06: provider enum is '4s'/'6s'/'8s' ONLY
  // (live 422 proved 5/10/15 invalid; fal API schema confirmed 4/6/8, default 8s) — keys re-based 5/10/15 → 4/6/8.
  // PRICING FIX: 1.5x of VERIFIED provider $0.10/s no-audio, $0.15/s audio → 4s 20/30, 6s 30/45, 8s 40/60.
  veo31:           { 4: { no: 20,  yes: 30  }, 6: { no: 30,  yes: 45  }, 8: { no: 40,  yes: 60  } },
  // Veo 3.1 Standard (codeKey=veo31_standard, fal-ai/veo3.1). DURATION FIX 2026-06-06: provider enum is '4s'/'6s'/'8s'
  // ONLY (live 422 proved 5/10/15 invalid; fal API schema confirmed 4/6/8) — keys re-based 5/10/15 → 4/6/8.
  // PRICING FIX: 1.5x of VERIFIED provider $0.20/s no-audio, $0.40/s audio → 4s 40/80, 6s 60/120, 8s 80/160.
  veo31_standard:  { 4: { no: 40,  yes: 80  }, 6: { no: 60,  yes: 120 }, 8: { no: 80,  yes: 160 } },
  // Veo 3.1 First/Last Frame. Provider charges ~2x for audio; yes = provider pass-through at constant markup
  // (not an added premium). Audio-off (no) is the cheap path. (Rebalance 2026-06-03: reviewed, left at truth.)
  veo31_flf:       { 4: { no: 41,  yes: 80  }, 6: { no: 61,  yes: 120 }, 8: { no: 81,  yes: 160 } }, // PRICING FIX 2026-06-05 (LIVE SMOKE TEST PASSED, start+end+audio): provider observed 4s-audio = $1.60 ($0.40/s). yes = 1.5x observed audio: 4→80,6→120,8→160. no = 1.5x of $0.20/s no-audio est: 4→41,6→61,8→81. (was 4:33/65,6:49/97,8:65/129 ≈ 1.22x)
  veo4_standard:   { 5: { no: 45,  yes: 56  }, 8:  { no: 70,  yes: 88  }, 10: { no: 90,  yes: 113 } }, // SUPERSEDED by veo3/veo3_silent (real fal-ai/veo3 locked pricing); kept for the legacy unused registry entry.
  // Veo 3 (fal-ai/veo3) MASTER FINAL 2026-06-02 — Kling-V3-4K credit logic. veo3 = audio ON (charges 'yes'); veo3_silent = audio OFF (charges 'no'). 4/6/8s.
  veo3:            { 4: { no: 76,  yes: 111 }, 6: { no: 110, yes: 166 }, 8: { no: 147, yes: 223 } }, // audio (yes) = provider pass-through (~+50%) at constant ~1.1x markup — not an added premium; capping would sell below cost (Rebalance 2026-06-03: left at truth)
  veo3_silent:     { 4: { no: 76,  yes: 76  }, 6: { no: 110, yes: 110 }, 8: { no: 147, yes: 147 } },
  // EMERGENCY PRICING FIX 2026-06-05: Veo 2 (fal-ai/veo2) verified provider cost $0.50/s ($2.50/5s, $4.00/8s).
  // Old 55/85 sold BELOW provider cost (0.66x / 0.64x — every gen lost money). Relocked to a >=1.5x floor:
  // 5s=125cr ($3.75 = 1.50x), 8s=200cr ($6.00 = 1.50x). Audio is questionable (fal lists Veo 2 as silent) so
  // no==yes (NO audio surcharge). The 10s row is kept for historical/back-compat ONLY — the UI no longer offers
  // 10s (durations [5,8]; route clamps to 8s), so the 10s price is never charged; do NOT rely on it.
  veo4:            { 5: { no: 125, yes: 125 }, 8:  { no: 200, yes: 200 }, 10: { no: 110, yes: 138 } },
  minimax:         { 5: { no: 30,  yes: 38  }, 10: { no: 55,  yes: 69  } },
  runway:          { 5: { no: 35,  yes: 35  }, 10: { no: 60,  yes: 60  } },
  // PixVerse V6 I2V — dedicated key (separate from pika25) to cover 5s and 8s
  pixversev6:      { 5: { no: 20,  yes: 20  }, 8: { no: 30,  yes: 30  } },
  // Sora 2 — valid durations: 4/8/12/16/20. Native audio always bundled (no/yes same price).
  // Pricing Final (source of truth): 4s=60, 8s=120, 12s=180, 16s=240, 20s=300
  sora2:    { 4: { no: 24,  yes: 24  }, 8: { no: 34,  yes: 34  }, 12: { no: 52,  yes: 52  }, 16: { no: 81,  yes: 81  }, 20: { no: 100, yes: 100 } }, // PRICING FIX 2026-06-05: 16s/20s raised to 1.5x of VERIFIED $0.10/s (16: 64→81, 20: 82→100); 4/8/12s kept. Native audio, surcharge 0 (no==yes).
  // Sora 2 Pro — valid durations: 4/8/12/20/25. Native audio always bundled.
  // Pricing Final (source of truth): 4s=80, 8s=140, 12s=200, 20s=320, 25s=360
  // Phase4 FINAL (Excel row sora2pro_25_720_yes, codeKey=sora2pro, "Sora 2 Pro", audio Yes/Included): 25→400. 4/8/12/20 already match Excel.
  sora2pro: { 4: { no: 65,  yes: 65  }, 8: { no: 103, yes: 103 }, 12: { no: 241, yes: 241 }, 16: { no: 320, yes: 320 }, 20: { no: 400, yes: 400 } }, // PRICING FIX 2026-06-05: 12/16/20s raised to 2.0x of VERIFIED $0.30/s @720p (12: 135→241, 16: 178→320, 20: 217→400); 4/8s kept. Native audio, surcharge 0 (no==yes).
}

export function calculateVideoCost(
  modelId: string,
  duration: number,
  withAudio: boolean,
): number {
  const modelPrices = VIDEO_PRICES[modelId]
  if (!modelPrices) return 0
  const durationPrices = modelPrices[duration]
  if (!durationPrices) {
    const available = Object.keys(modelPrices).map(Number).sort((a, b) => a - b)
    const closest = available.reduce((prev, curr) =>
      Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
    )
    return modelPrices[closest][withAudio ? 'yes' : 'no']
  }
  return durationPrices[withAudio ? 'yes' : 'no']
}

export function getMarketingCredits(duration: 15 | 30 | 60): number {
  const key = `seedance_${duration}s` as MarketingDuration;
  return CREDITS.marketing[key];
}

export function getCharacterCredits(model: CharacterModel): number {
  return CREDITS.character[model];
}
