import { CREDITS, VIDEO_PRICES } from "@/lib/credits"

// What a QLC amount buys, from the same price list the billing layer charges (1 credit = 1 QLC).
// Reference generations: Nano Banana 2 image (1K) and Kling 3.0 video (5 s, no audio).
const IMAGE_QLC = CREDITS.image.nanobanana2
const VIDEO_QLC = VIDEO_PRICES.kling3_standard[5].no

/** e.g. "≈ 125 images or 20 videos" for a QLC amount in base units (2 decimals). */
export function qlcPackEstimate(qlcBaseUnits: string): string {
  const qlc = Number(BigInt(qlcBaseUnits) / BigInt(100))
  const images = Math.floor(qlc / IMAGE_QLC)
  const videos = Math.floor(qlc / VIDEO_QLC)
  return `≈ ${images.toLocaleString("en-US")} images or ${videos.toLocaleString("en-US")} videos`
}
