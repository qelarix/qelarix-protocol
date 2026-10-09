import { NextRequest, NextResponse } from "next/server"
import { getRequestAuthUser } from "@/lib/authSession"
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling"
import { fal } from "@fal-ai/client"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { getImageCredits } from "@/lib/credits"
import { getImageModelById, canAccessImageModel, ASPECT_RATIO_DIMS, getImageResolutionCredits, getImageSpeedCredits, getImageQualityCredits } from "@/lib/image-models"
import type { AspectRatio } from "@/lib/image-models"
import type { ImageModel } from "@/lib/credits"
import { isInternalUser } from "@/lib/planAccess"

fal.config({ credentials: process.env.FAL_KEY })

async function uploadToStorage(
  falUrl: string,
  userId: string,
  genId: string,
): Promise<string> {
  try {
    const admin = createSupabaseAdmin()
    const imgRes = await fetch(falUrl)
    if (!imgRes.ok) return falUrl
    const buffer = await imgRes.arrayBuffer()
    const uint8 = new Uint8Array(buffer)
    const path = `generations/${userId}/${genId}.jpg`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: uploadError } = await (admin as any).storage
      .from('generations')
      .upload(path, uint8, { contentType: 'image/jpeg', upsert: true })
    if (uploadError) {
      console.error('[storage upload]', uploadError.message)
      return falUrl
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = (admin as any).storage
      .from('generations')
      .getPublicUrl(path)
    return data.publicUrl as string
  } catch (err) {
    console.error('[storage upload error]', err)
    return falUrl
  }
}

interface GenerateImageBody {
  model: string
  prompt: string
  negativePrompt?: string
  aspectRatio: AspectRatio
  numImages?: number
  quality?: string // flux2max binary 'standard'|'hd'; GPT Image 2 quality tier 'low'|'medium'|'high'
  referenceImageUrl?: string // pilot: single PUBLIC reference image — honored for flux2max (v1.1-ultra) only
  resolution?: string // verified resolution tier (e.g. Nano Banana Pro '2K'|'4K' via the provider `resolution` enum)
  renderingSpeed?: string // verified rendering-speed tier (Ideogram V3 'TURBO'|'BALANCED'|'QUALITY' via `rendering_speed`)
  referenceImageUrls?: string[] // forward-compat: multi-reference (descriptor maxRefs). Phase A/B still sends single referenceImageUrl.
  batchId?: string // Bulk v1: client-side fan-out batch id; persisted to settings.batch_id for future grouping (no schema change)
  providerStyle?: string // STYLE v1: provider-level style enum (Ideogram V3 / Recraft V3 only); validated per-model in buildFalInput. Cost-neutral.
}

// Upload raw image bytes (e.g. GPT Image 2 b64_json, decoded) to the EXISTING `generations` storage bucket and
// return a permanent public URL — same bucket/path convention as uploadToStorage(), just from a Buffer instead of a
// fetched URL. Reused, not a new bucket. Returns null on failure (caller treats it as a failed generation → no charge).
async function uploadBufferToStorage(
  bytes: Uint8Array,
  userId: string,
  genId: string,
  contentType = "image/png",
): Promise<string | null> {
  try {
    const admin = createSupabaseAdmin()
    const ext = contentType.includes("png") ? "png" : "jpg"
    const path = `generations/${userId}/${genId}.${ext}`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any).storage.from("generations").upload(path, bytes, { contentType, upsert: true })
    if (error) { console.error("[storage upload b64]", error.message); return null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = (admin as any).storage.from("generations").getPublicUrl(path)
    return (data?.publicUrl as string) ?? null
  } catch (e) {
    console.error("[storage upload b64]", e)
    return null
  }
}

// Reference prompt boost — shared by the generic fal edit path AND the GPT Image 2 edit branch below. Appended to the
// PROVIDER prompt ONLY on the reference/edit path; the user's ORIGINAL prompt is always what's stored on the row.
const REFERENCE_BOOST = "Use the provided reference image(s) as strict visual reference. Preserve important identity, logo, product design, object shape, colors, typography, layout, and recognizable details from the reference image(s). If a character, logo, product, object, style, or brand element appears in the reference image(s), keep it consistent and clearly recognizable in the generated result."

// GPT Image 2 size: the OpenAI Images API `size` param is accepted as the canonical gpt-image enum
// (1024x1024 / 1536x1024 / 1024x1536 / auto) — guaranteed valid for gpt-image-2 AND gpt-image-1. The earlier
// 2048-class custom sizes were rejected with HTTP 400 (the API did not accept them), so we map the aspect selector
// to the nearest canonical size: square → 1024², landscape (16:9, 4:3) → 1536x1024, portrait (9:16, 3:4) → 1024x1536.
// No 4K in this rollout. (If a verified account confirms gpt-image-2 accepts larger custom sizes, revisit.)
function gptImageSize(ar: string): string {
  switch (ar) {
    case "16:9": return "1536x1024"
    case "4:3":  return "1536x1024"
    case "9:16": return "1024x1536"
    case "3:4":  return "1024x1536"
    default:     return "1024x1024"
  }
}

function toSizePreset(ar: string): string {
  switch (ar) {
    case "16:9": return "landscape_16_9"
    case "9:16": return "portrait_16_9"
    case "4:3": return "landscape_4_3"
    case "3:4": return "portrait_4_3"
    case "3:2": return "landscape_4_3"
    case "2:3": return "portrait_4_3"
    default: return "square_hd"
  }
}

// Seedream v4 / v4.5 take image_size as a {width,height} OBJECT (not a preset). Map a resolution tier (2K/4K) plus
// the aspect ratio to real dimensions that stay inside provider constraints:
//   • v4   — total pixels must be 960² … 4096²
//   • v4.5 — each side 1920–4096, OR total pixels 2560×1440 … 4096²
// Area-based sizing (2K ≈ 2048², 4K ≈ 4096²) with the long edge capped at 4096 keeps EVERY supported aspect valid
// for both models: square satisfies the per-side rule; wide/tall satisfy the total-pixels rule (2K area ≈ 4.19M ≥
// the 3.69M v4.5 floor). Dimensions are snapped to multiples of 16 and clamped ≤ 4096.
function seedreamImageSize(ar: string, resolution?: string): { width: number; height: number } {
  const RATIOS: Record<string, [number, number]> = {
    "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16], "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3],
  }
  const [rw, rh] = RATIOS[ar] ?? [1, 1]
  const area = resolution === "4K" ? 4096 * 4096 : 2048 * 2048
  let w = Math.sqrt((area * rw) / rh)
  let h = Math.sqrt((area * rh) / rw)
  const scale = Math.min(1, 4096 / Math.max(w, h)) // cap the long edge at the provider max (4096), preserving aspect
  w *= scale; h *= scale
  const snap = (n: number) => Math.max(16, Math.min(4096, Math.round(n / 16) * 16))
  return { width: snap(w), height: snap(h) }
}

function buildFalInput(
  falEndpoint: string,
  body: GenerateImageBody,
  reference?: { mode: string; maxRefs: number; payloadField: string },
): Record<string, unknown> {
  const dims = ASPECT_RATIO_DIMS[body.aspectRatio]
  const base: Record<string, unknown> = {
    prompt: body.prompt,
    num_images: body.numImages ?? 1,
    image_size: { width: dims.w, height: dims.h },
    enable_safety_checker: true,
  }

  if (body.negativePrompt?.trim()) {
    base.negative_prompt = body.negativePrompt.trim()
  }

  // Per-model specifics
  if (falEndpoint.includes("flux-2")) {
    // FLUX.2 [pro]/[max] text-to-image: prompt + image_size {width,height} (kept from base). No raw/HD toggle
    // or negative_prompt. FLUX @-referencing is not wired here (flux2pro is not a reference model).
    delete base.negative_prompt
    delete base.enable_safety_checker
  } else if (falEndpoint.includes("flux-pro")) {
    delete base.image_size
    delete base.negative_prompt // FLUX 1.1 Pro Ultra has no negative_prompt field (defensive — UI never sends it for flux-pro)
    base.aspect_ratio = body.aspectRatio
    if (body.quality === "hd") base.raw = true
    // (reference now handled by the descriptor-driven block below — preserves flux2max → image_url)
  } else if (falEndpoint.includes("recraft")) {
    // Recraft20bInput: image_size as preset string, no num_images, no negative_prompt
    delete base.image_size
    base.image_size = toSizePreset(body.aspectRatio)
    delete base.num_images
    delete base.negative_prompt
    // Provider-verified style enum (cost-neutral). Omit when unset/invalid → provider default (realistic_image).
    if (body.providerStyle && ["realistic_image", "digital_illustration", "vector_illustration"].includes(body.providerStyle)) base.style = body.providerStyle
  } else if (falEndpoint.includes("ideogram")) {
    // IdeogramV3Input: image_size as preset string, num_images, supports negative_prompt
    delete base.image_size
    base.image_size = toSizePreset(body.aspectRatio)
    // (style reference now handled by the descriptor-driven block below — preserves Ideogram → image_urls:[url])
    // Rendering-speed tier (verified `rendering_speed` enum). Default BALANCED; only TURBO/QUALITY override. Never send invalid values.
    base.rendering_speed = (body.renderingSpeed === "TURBO" || body.renderingSpeed === "QUALITY") ? body.renderingSpeed : "BALANCED"
    // Provider-verified style enum (cost-neutral; AUTO/GENERAL/REALISTIC/DESIGN). Omit when unset/invalid → default AUTO.
    // Skip when a STYLE reference image is attached (image_urls path) so the existing reference workflow stays untouched
    // (provider treats style_codes as exclusive; style enum applies to plain text-to-image here).
    const ideogramHasStyleRef = (Array.isArray(body.referenceImageUrls) && body.referenceImageUrls.length > 0) || typeof body.referenceImageUrl === "string"
    if (!ideogramHasStyleRef && body.providerStyle && ["AUTO", "GENERAL", "REALISTIC", "DESIGN"].includes(body.providerStyle)) base.style = body.providerStyle
  } else if (falEndpoint.includes("seedream")) {
    // Seedream v4 / v4.5: image_size as a {width,height} OBJECT for TRUTHFUL 2K/4K (provider default is 2048²; the old
    // preset strings produced ~1024 output). Resolution tier (2K/4K) + aspect → constraint-valid dims (see
    // seedreamImageSize). Flat per-image price, no 4K surcharge. num_images kept; no negative_prompt (provider has none).
    base.image_size = seedreamImageSize(body.aspectRatio, body.resolution)
    delete base.negative_prompt
  } else if (falEndpoint.includes("imagen4")) {
    // Imagen4PreviewFastInput: aspect_ratio, num_images, no negative_prompt
    delete base.image_size
    base.aspect_ratio = body.aspectRatio
    delete base.negative_prompt
  } else if (falEndpoint.includes("nano-banana")) {
    // Nano Banana 2 & Pro: aspect_ratio string, no negative_prompt. num_images IS supported
    // (verified in current fal OpenAPI schema, max 4) — keep it so the route can request >1.
    delete base.image_size
    delete base.negative_prompt
    base.aspect_ratio = body.aspectRatio
    // Nano Banana Pro resolution tier (verified `resolution` enum 1K/2K/4K). Gated to -pro; default 2K (= 1K price, more pixels).
    if (falEndpoint.includes("nano-banana-pro")) base.resolution = body.resolution ?? "2K"
    else if (falEndpoint.includes("nano-banana-2")) base.resolution = body.resolution ?? "1K" // NB2 tiers 1K/2K/4K (0.5K not exposed)
  } else if (falEndpoint.includes("fast-sdxl")) {
    // Fast SDXL: image_size as { width, height } — keeps the default
  }

  // ── Reference (descriptor-driven; single source = image-models.ts `reference`) ──
  // Preserves the two pilots EXACTLY: FLUX 1.1 Pro Ultra → image_url; Ideogram V3 → image_urls.
  // Single image today (descriptor maxRefs = 1); accepts an array (referenceImageUrls) for later multi-ref.
  if (reference && reference.mode !== "none") {
    const provided = [
      ...(Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls : []),
      ...(typeof body.referenceImageUrl === "string" ? [body.referenceImageUrl] : []),
    ].filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    const urls = provided.slice(0, Math.max(1, reference.maxRefs))
    if (urls.length > 0) {
      if (reference.payloadField === "image_url") base.image_url = urls[0]
      else if (reference.payloadField === "image_urls") base.image_urls = urls
      else if (reference.payloadField === "reference_image_urls") base.reference_image_urls = urls
    }
  }

  return base
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = authUser.id
    const userPlan = (authUser.plan as string) ?? "free"
    const isAdmin = isInternalUser(authUser)
    const isUltra = userPlan === 'ultra'
    let isUnlimited = false

    const body = (await req.json()) as GenerateImageBody
    const { model: modelId, prompt, aspectRatio } = body

    if (!modelId || !prompt?.trim() || !aspectRatio) {
      return NextResponse.json({ error: "model, prompt, and aspectRatio are required" }, { status: 400 })
    }
    if (prompt.length > 5000) {
      return NextResponse.json({ error: "Prompt cannot exceed 5000 characters" }, { status: 400 })
    }

    const model = getImageModelById(modelId)
    if (!model) {
      return NextResponse.json({ error: "Unknown model" }, { status: 400 })
    }

    if (!isAdmin && !isUltra && !canAccessImageModel(userPlan, modelId)) {
      return NextResponse.json(
        { error: `Your plan (${userPlan}) does not support this model. Please upgrade your plan.` },
        { status: 403 },
      )
    }

    // Per-model image access is already enforced above by canAccessImageModel(userPlan, modelId),
    // which reads each model's `plan` tier from src/lib/image-models.ts (the single image-access
    // source). The hard-coded FREE_IMAGE_MODELS / STARTER_IMAGE_MODELS allow-lists that used to live
    // here were byte-for-byte equivalent to that gate (a redundant second copy that could drift) and
    // have been removed. Admin/Ultra bypass is handled by the same check above.

    // ── Grok Imagine — xAI direct API (synchronous) ──────────────────────────
    if (modelId === "grokimagine") {
      const xaiKey = process.env.XAI_API_KEY
      if (!xaiKey || xaiKey === "your_xai_api_key") {
        return NextResponse.json(
          { error: "Grok Imagine is not yet configured — xAI API key missing." },
          { status: 501 },
        )
      }

      const numImages = Math.min(body.numImages ?? 1, model.maxImages)
      const creditCost = getImageCredits("grokimagine") * numImages

      const admin = createSupabaseAdmin()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminAny = admin as any

      const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin })
      if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

      const { data: generation, error: insertError } = await adminAny
        .from("generations")
        .insert({
          user_id: userId,
          type: "image",
          model: modelId,
          prompt: prompt.trim(),
          status: "pending",
          credits_used: creditCost,
          is_public: false,
          settings: {
            aspect_ratio: aspectRatio,
            num_images: numImages,
            quality: body.quality ?? "standard",
            negative_prompt: body.negativePrompt ?? null,
            watermark: userPlan === "free",
            ...(typeof body.batchId === "string" && body.batchId ? { batch_id: body.batchId } : {}),
          },
        })
        .select("id")
        .single()

      if (insertError || !generation) {
        return NextResponse.json({ error: "Failed to create generation" }, { status: 500 })
      }
      const generationId = (generation as { id: string }).id
      // QLC billing: reserve and charge before the provider is called (no-op in credits mode); settled below once the images are stored.
      const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin })
      if (!charge.ok) {
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
      }

      // grok-2-image has no verified aspect-ratio control (the xAI image API documents no size/aspect param) and the
      // UI now locks Grok to a fixed 1:1, so we always request a square. We KEEP the `size` field rather than removing
      // it because removal is unverified: if xAI does honor `size`, this guarantees the 1:1 the UI advertises; if it
      // ignores it (the likely case), this is a harmless no-op. The value is identical to what was already sent for
      // Grok (aspect was clamped to 1:1 → 1024x1024), so this is a zero-behavioral-change clarification, not a change.
      const xaiSize = "1024x1024"

      try {
        const xaiRes = await fetch("https://api.x.ai/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${xaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "grok-2-image",
            prompt: prompt.trim(),
            n: numImages,
            response_format: "url",
            size: xaiSize,
          }),
        })

        if (!xaiRes.ok) {
          const errText = await xaiRes.text().catch(() => "")
          console.error("[generate/image/grok] xAI error", xaiRes.status, errText)
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider failed" })
          return NextResponse.json({ error: `Grok Imagine API error (${xaiRes.status})` }, { status: 502 })
        }

        const xaiData = await xaiRes.json() as { data?: Array<{ url: string }> }
        const imageUrls = xaiData.data?.map((d) => d.url).filter(Boolean) ?? []

        if (imageUrls.length === 0) {
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider failed" })
          return NextResponse.json({ error: "Grok Imagine returned no images" }, { status: 502 })
        }

        const permanentUrls = await Promise.all(
          imageUrls.map((url, i) => uploadToStorage(url, userId, `${generationId}-${i}`))
        )

        await adminAny
          .from("generations")
          .update({ status: "completed", output_url: JSON.stringify(permanentUrls) })
          .eq("id", generationId)

        // Charge exactly once, after the images are stored (credits: generations.credits_deducted compare-and-set;
        // QLC: settles the on-chain charge). Admin/unlimited generations are not charged.
        await settleGenerationCharge({
          user: authUser, generationId, credits: creditCost, description: `Image generation: ${generationId}`, exempt: isAdmin || isUnlimited, once: "generation-row",
        })

        return NextResponse.json({ jobId: generationId })
      } catch (err) {
        console.error("[generate/image/grok]", err)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        await releaseGenerationCharge({ generationId, reason: "provider failed" })
        return NextResponse.json({ error: "xAI API request failed" }, { status: 502 })
      }
    }

    // ── GPT Image 2 — OpenAI direct Images API (synchronous) ─────────────────────────────────────────────
    // REAL gpt-image-2 (NOT DALL·E). Returns b64_json → decoded and uploaded to the existing `generations` storage
    // bucket. Quality tier (low/medium/high) drives credits + payload. No reference/edit workflow, NO DALL·E, NO fallback.
    if (modelId === "gptimage2") {
      const openaiKey = process.env.OPENAI_API_KEY
      if (!openaiKey || openaiKey === "your_openai_api_key") {
        return NextResponse.json(
          { error: "GPT Image 2 is not yet configured — OPENAI_API_KEY missing." },
          { status: 501 },
        )
      }

      // GPT Image 2 Edit (v1.2 Priority 3): when ≥1 valid https reference is attached, switch from text-to-image
      // (/v1/images/generations, JSON) to image edit (/v1/images/edits, multipart). GPT is NOT fal-descriptor routing —
      // there is NO reference.endpoint; this branch downloads refs server-side → binary image[] parts. NO image_urls[]
      // or URLs are ever sent to OpenAI. First rollout caps references at maxReferences (2); no mask.
      const gptRefUrls = [
        ...(Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls : []),
        ...(typeof body.referenceImageUrl === "string" ? [body.referenceImageUrl] : []),
      ].filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, model.maxReferences ?? 2)
      const useGptEdit = gptRefUrls.length > 0

      const numImages = Math.min(body.numImages ?? 1, model.maxImages)
      const quality = (["low", "medium", "high"].includes(body.quality ?? "") ? body.quality : model.defaultQuality) as string
      const creditCost = getImageQualityCredits(model, quality) * numImages
      // Boost the PROVIDER prompt on the edit path only; the row still stores the user's original prompt (prompt.trim()).
      const gptProviderPrompt = useGptEdit ? `${prompt.trim()}\n\nReference instruction:\n${REFERENCE_BOOST}` : prompt.trim()

      const admin = createSupabaseAdmin()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminAny = admin as any

      const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin || isUnlimited })
      if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

      const { data: generation, error: insertError } = await adminAny
        .from("generations")
        .insert({
          user_id: userId,
          type: "image",
          model: modelId,
          prompt: prompt.trim(),
          status: "pending",
          credits_used: creditCost,
          is_public: false,
          settings: {
            aspect_ratio: aspectRatio,
            num_images: numImages,
            quality,
            watermark: userPlan === "free",
            openai_endpoint: useGptEdit ? "edits" : "generations",
            ...(useGptEdit ? { reference_count: gptRefUrls.length, reference_prompt_boost: true } : {}),
            ...(typeof body.batchId === "string" && body.batchId ? { batch_id: body.batchId } : {}),
          },
        })
        .select("id")
        .single()

      if (insertError || !generation) {
        return NextResponse.json({ error: "Failed to create generation" }, { status: 500 })
      }
      const generationId = (generation as { id: string }).id
      // QLC billing: reserve and charge before the provider is called (no-op in credits mode); settled below once the images are stored.
      const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin || isUnlimited })
      if (!charge.ok) {
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
      }

      try {
        let openaiRes: Response
        if (useGptEdit) {
          // Edit path: download each reference server-side, validate, append as multipart image[] file parts.
          // Public URLs are NEVER forwarded to OpenAI — only the decoded bytes are. The API key lives solely in the
          // Authorization header (never logged, never in the body).
          const form = new FormData()
          form.append("model", "gpt-image-2")
          form.append("prompt", gptProviderPrompt)
          form.append("n", String(numImages))
          form.append("size", gptImageSize(aspectRatio))
          form.append("quality", quality)
          for (let i = 0; i < gptRefUrls.length; i++) {
            let refRes: Response
            try {
              refRes = await fetch(gptRefUrls[i])
            } catch {
              await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
              await releaseGenerationCharge({ generationId, reason: "provider failed" })
              return NextResponse.json({ error: `Reference image ${i + 1} could not be downloaded.` }, { status: 502 })
            }
            if (!refRes.ok) {
              await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
              await releaseGenerationCharge({ generationId, reason: "provider failed" })
              return NextResponse.json({ error: `Reference image ${i + 1} download failed (${refRes.status}).` }, { status: 502 })
            }
            const ctype = (refRes.headers.get("content-type") || "").toLowerCase()
            if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].some((t) => ctype.includes(t))) {
              await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
              await releaseGenerationCharge({ generationId, reason: "provider failed" })
              return NextResponse.json({ error: `Reference image ${i + 1} must be PNG, JPG, or WEBP.` }, { status: 400 })
            }
            const refBuf = await refRes.arrayBuffer()
            if (refBuf.byteLength > 50 * 1024 * 1024) {
              await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
              await releaseGenerationCharge({ generationId, reason: "provider failed" })
              return NextResponse.json({ error: `Reference image ${i + 1} exceeds the 50MB limit.` }, { status: 400 })
            }
            const ext = ctype.includes("png") ? "png" : ctype.includes("webp") ? "webp" : "jpg"
            form.append("image[]", new Blob([refBuf], { type: ctype }), `reference-${i}.${ext}`)
          }
          openaiRes = await fetch("https://api.openai.com/v1/images/edits", {
            method: "POST",
            headers: { Authorization: `Bearer ${openaiKey}` }, // no Content-Type — fetch sets the multipart boundary
            body: form,
          })
        } else {
          openaiRes = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${openaiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-image-2",
              prompt: prompt.trim(),
              n: numImages,
              size: gptImageSize(aspectRatio),
              quality,
            }),
          })
        }

        if (!openaiRes.ok) {
          const errText = await openaiRes.text().catch(() => "")
          // Surface OpenAI's own error message (its 400 body says exactly which field/value was rejected) without
          // leaking secrets — errText is the RESPONSE body; the API key lives only in the request header, never here.
          let oaiMsg = ""
          try { oaiMsg = (JSON.parse(errText) as { error?: { message?: string } })?.error?.message ?? "" } catch { /* non-JSON body */ }
          console.error("[generate/image/gptimage2] OpenAI error", openaiRes.status, oaiMsg || errText.slice(0, 400))
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider failed" })
          return NextResponse.json(
            { error: oaiMsg ? `GPT Image 2 API error: ${oaiMsg}` : `GPT Image 2 API error (${openaiRes.status})` },
            { status: 502 },
          )
        }

        const openaiData = await openaiRes.json() as { data?: Array<{ b64_json?: string }>; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { image_tokens?: number; text_tokens?: number } } }
        // Smoke-test logging (Part 8) — no secrets: the API key is only in the request header, never in this response.
        if (openaiData.usage) {
        } else {
        }
        const b64s = openaiData.data?.map((d) => d.b64_json).filter((b): b is string => !!b) ?? []
        if (b64s.length === 0) {
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider failed" })
          return NextResponse.json({ error: "GPT Image 2 returned no images" }, { status: 502 })
        }

        // b64 → bytes → existing `generations` storage bucket → permanent public URL(s)
        const uploaded = await Promise.all(
          b64s.map((b64, i) => uploadBufferToStorage(Buffer.from(b64, "base64"), userId, `${generationId}-${i}`)),
        )
        const permanentUrls = uploaded.filter((u): u is string => !!u)
        if (permanentUrls.length === 0) {
          await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
          await releaseGenerationCharge({ generationId, reason: "provider failed" })
          return NextResponse.json({ error: "GPT Image 2 storage upload failed" }, { status: 502 })
        }

        await adminAny
          .from("generations")
          .update({ status: "completed", output_url: JSON.stringify(permanentUrls) })
          .eq("id", generationId)

        // Charge exactly once, after the images are stored (credits: generations.credits_deducted compare-and-set;
        // QLC: settles the on-chain charge). Admin/unlimited generations are not charged.
        await settleGenerationCharge({
          user: authUser, generationId, credits: creditCost, description: `Image generation: ${generationId}`, exempt: isAdmin || isUnlimited, once: "generation-row",
        })

        return NextResponse.json({ jobId: generationId })
      } catch (err) {
        console.error("[generate/image/gptimage2]", err)
        await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
        await releaseGenerationCharge({ generationId, reason: "provider failed" })
        return NextResponse.json({ error: "OpenAI API request failed" }, { status: 502 })
      }
    }

    if (!model.falEndpoint) {
      return NextResponse.json(
        { error: `Model '${model.label}' is not yet available via API.` },
        { status: 501 },
      )
    }

    // ── First reference/edit pilot (Seedream 4.5 Edit) ──
    // When the model declares a reference edit endpoint AND ≥1 valid reference URL is attached, submit to the edit
    // endpoint (image_urls[] required) instead of text-to-image. No refs → unchanged t2i path. Other models have no
    // reference.endpoint, so this is a no-op for them.
    const refUrlsIn = [
      ...(Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls : []),
      ...(typeof body.referenceImageUrl === "string" ? [body.referenceImageUrl] : []),
    ].filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    const useEditEndpoint = !!(model.reference?.endpoint && refUrlsIn.length > 0)
    const selectedFalEndpoint = useEditEndpoint ? (model.reference!.endpoint as string) : model.falEndpoint

    // Provider cap: inputs + outputs must be ≤ 15 (Seedream edit). With maxRefs 4 + maxImages 4 this never binds; defensive.
    const numImages = Math.min(body.numImages ?? 1, model.maxImages, useEditEndpoint ? Math.max(1, 15 - refUrlsIn.length) : Infinity)

    // Reference prompt boost (edit/reference path ONLY): providers can underuse attached references when the user's
    // prompt doesn't explicitly ask to. Append the shared REFERENCE_BOOST (module scope — also used by the GPT edit
    // branch) to the PROVIDER prompt only; the user's ORIGINAL prompt is still what's stored on the row (prompt.trim()).
    const providerPrompt = useEditEndpoint ? `${prompt.trim()}\n\nReference instruction:\n${REFERENCE_BOOST}` : prompt.trim()
    const creditCost = (model.speedTiers ? getImageSpeedCredits(model, body.renderingSpeed) : model.resolutionTiers ? getImageResolutionCredits(model, body.resolution) : getImageCredits(modelId as ImageModel)) * numImages // rendering-speed-tiered (Ideogram) / resolution-tiered (Nano Banana) charges per tier; else flat

    const admin = createSupabaseAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any

    // Provjeri unlimited period
    if (!isAdmin && ['pro', 'business', 'ultra'].includes(userPlan)) {
      const now = new Date().toISOString()
      const { data: unlimitedPeriod } = await adminAny
        .from('unlimited_periods')
        .select('id, limit_count, used_count')
        .eq('user_id', userId)
        .eq('model_id', modelId)
        .eq('is_active', true)
        .gt('expires_at', now)
        .single()

      if (unlimitedPeriod) {
        const up = unlimitedPeriod as { id: string; limit_count: number | null; used_count: number }
        if (up.limit_count === null) {
          isUnlimited = true
        } else if (up.used_count < up.limit_count) {
          isUnlimited = true
          await adminAny
            .from('unlimited_periods')
            .update({ used_count: up.used_count + 1 })
            .eq('id', up.id)
        }
      }
    }

    const funds = await checkGenerationFunds({ user: authUser, credits: creditCost, exempt: isAdmin || isUnlimited })
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status })

    const { data: generation, error: insertError } = await adminAny
      .from("generations")
      .insert({
        user_id: userId,
        type: "image",
        model: modelId,
        prompt: prompt.trim(),
        status: "pending",
        credits_used: creditCost,
        is_public: false,
        settings: {
          aspect_ratio: aspectRatio,
          num_images: numImages,
          quality: body.quality ?? "standard",
          negative_prompt: body.negativePrompt ?? null,
          fal_endpoint: selectedFalEndpoint,
          fal_request_id: null,
          watermark: userPlan === "free",
          ...(typeof body.batchId === "string" && body.batchId ? { batch_id: body.batchId } : {}),
        },
      })
      .select("id")
      .single()

    if (insertError || !generation) {
      console.error("[generate/image] insert error", insertError)
      return NextResponse.json({ error: "Could not create generation" }, { status: 500 })
    }

    const generationId = (generation as { id: string }).id
    // QLC billing: reserve and charge before the provider is called (no-op in credits mode); the status route settles it on success.
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: creditCost, exempt: isAdmin || isUnlimited })
    if (!charge.ok) {
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status })
    }
    const effectiveFalEndpoint = selectedFalEndpoint
    const falInput = buildFalInput(effectiveFalEndpoint, { ...body, prompt: providerPrompt, numImages }, model.reference)

    let requestId = ""
    try {
      const queued = await fal.queue.submit(effectiveFalEndpoint, { input: falInput })
      requestId = queued.request_id
    } catch (falErr) {
      // NO silent fallback (removed 2026-06-07): the user must receive EXACTLY the model they selected — never a
      // fal-ai/flux-pro substitute (the prior retry mis-attributed cost/output to the chosen model). On submit
      // failure → mark the generation failed + return a clean error. No substitute job; NO deduction (credits are
      // charged only by the status route AFTER the SELECTED model actually succeeds).
      const e = falErr as { status?: number; body?: { detail?: unknown }; message?: string }
      const detail = e?.body?.detail ?? e?.body ?? e?.message
      console.error("[generate/image] fal.queue.submit failed (no fallback):", JSON.stringify({
        model: model.id, endpoint: effectiveFalEndpoint, status: e?.status, detail: JSON.stringify(detail).slice(0, 500),
      }))
      await adminAny.from("generations").update({ status: "failed" }).eq("id", generationId)
      await releaseGenerationCharge({ generationId, reason: "provider failed" })
      return NextResponse.json({ error: `${model.label} could not start. Please try again.` }, { status: 502 })
    }

    await adminAny
      .from("generations")
      .update({
        settings: {
          aspect_ratio: aspectRatio,
          num_images: numImages,
          quality: body.quality ?? "standard",
          negative_prompt: body.negativePrompt ?? null,
          fal_endpoint: effectiveFalEndpoint,
          fal_request_id: requestId,
          ...(useEditEndpoint ? { reference_prompt_boost: true } : {}),
          ...(typeof body.batchId === "string" && body.batchId ? { batch_id: body.batchId } : {}),
        },
      })
      .eq("id", generationId)

    return NextResponse.json({ jobId: generationId })
  } catch (err) {
    console.error("[generate/image]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
