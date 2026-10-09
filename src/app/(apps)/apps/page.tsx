"use client"

import { useState, useMemo } from "react"
import { motion } from "framer-motion"
import Link from "next/link"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { hasPageAccess } from "@/lib/plans"
import type { PlanId } from "@/lib/plans"
import UpgradeModal from "@/components/UpgradeModal"
import QIcon from "@/components/ui/QIcon"

// ── Public badge language only (no internal roadmap labels, no "Agents"). ─────
// PRO  = working / premium / live / flagship (clickable)
// NEW  = beta rollout / newly surfaced / partial-but-usable (clickable)
// SOON = planned / not implemented yet (non-clickable, no fake links)
type ToolBadge = "PRO" | "NEW" | "SOON"
const BADGE_META: Record<ToolBadge, { bg: string; text: string }> = {
  PRO:  { bg: "#13D17A", text: "#04241a" }, // strong vivid green
  NEW:  { bg: "#FFB02A", text: "#2a1a02" }, // strong vivid amber/yellow
  SOON: { bg: "#8344F0", text: "#ffffff" }, // strong vivid violet
}

// Native, user-facing product categories.
type ToolCategory = "professional" | "video" | "image" | "face" | "trending" | "extras"
type VisualKind = "film" | "wave" | "split" | "frame" | "mesh" | "panels"

const CATEGORIES: { id: ToolCategory; label: string; subtitle: string }[] = [
  { id: "professional", label: "Professional",   subtitle: "High-value commercial and productivity tools." },
  { id: "video",        label: "Video Editing",  subtitle: "Upscale, extend, edit, and produce video." },
  { id: "image",        label: "Image Editing",  subtitle: "Clean up, edit, and reframe images." },
  { id: "face",         label: "Face & Identity", subtitle: "People, avatars, portraits, and identity." },
  { id: "trending",     label: "Trending",       subtitle: "Viral, social, and culture-ready templates." },
  { id: "extras",       label: "Extras",         subtitle: "Broad entry points and secondary tools." },
]

// Preview-ready card. Working cards have `href` (clickable); planned cards have NONE (never "#").
// Real previews later drop into /apps/previews/<id>-preview.webp (set previewSrc); until then a
// per-category CSS scene motif renders (no emoji-only blocks).
interface ToolCard {
  id: string
  name: string
  description: string
  category: ToolCategory
  badge: ToolBadge
  visualKind: VisualKind
  href?: string
  meta?: string
  icon: string
  accent: string
  preview: string
  previewType?: "image" | "video" | "gradient"
  previewSrc?: string
  previewAlt?: string
}

// Reusable premium gradient bases (cyan / blue / indigo / violet / purple / template).
const G_CYAN   = "linear-gradient(150deg,#08131f 0%,#0e3a52 60%,#0b6781 100%)"
const G_BLUE   = "linear-gradient(150deg,#0a1226 0%,#16275e 60%,#274694 100%)"
const G_INDIGO = "linear-gradient(150deg,#0e0f29 0%,#23246b 60%,#3a3da8 100%)"
const G_VIOLET = "linear-gradient(150deg,#140d29 0%,#2f1d59 60%,#4f2da0 100%)"
const G_PURPLE = "linear-gradient(150deg,#16092b 0%,#3a1d6b 60%,#6a2db0 100%)"
const G_TPL    = "linear-gradient(150deg,#120c26 0%,#2c1c54 60%,#5223a0 100%)"

// One deduplicated tool list — each tool has exactly one primary category + one badge.
const TOOLS: ToolCard[] = [
  // ── Professional ────────────────────────────────────────────────────────────
  { id: "product-photos", name: "Product Photos", category: "professional", badge: "PRO", visualKind: "frame", href: "/apps/product-photos",
    description: "Create product-style visuals and commercial shots.", meta: "Product · Commerce",
    icon: "🛍️", accent: "#06b6d4", preview: G_CYAN, previewType: "video", previewSrc: "/apps/previews/product-photos-preview.mp4", previewAlt: "Premium product photography preview" },
  { id: "startup-architect", name: "Startup Idea Architect", category: "professional", badge: "SOON", visualKind: "panels",
    description: "Shape startup ideas into pitch-ready concepts.", meta: "Pitch",
    icon: "🚀", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/startup-idea-architect-preview.mp4", previewAlt: "Startup idea planning preview" },
  { id: "yt-thumbnail", name: "YouTube Thumbnail Pro", category: "professional", badge: "SOON", visualKind: "frame",
    description: "Plan thumbnail concepts, hooks, and title angles.", meta: "Thumbnail",
    icon: "🖼️", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/yt-thumbnail-preview.mp4", previewAlt: "YouTube thumbnail creation preview" },
  { id: "podcast-forge", name: "Podcast Forge", category: "professional", badge: "SOON", visualKind: "wave",
    description: "Build episode concepts, outlines, and promo assets.", meta: "Audio",
    icon: "🎙️", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/podcast-forge-preview.mp4", previewAlt: "Podcast production studio preview" },
  { id: "tshirt-designer", name: "T-Shirt Designer", category: "professional", badge: "SOON", visualKind: "frame",
    description: "Generate product concepts for merch and apparel.", meta: "Merch",
    icon: "👕", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/t-shirt-designer-preview.mp4", previewAlt: "T-shirt design generation preview" },

  // ── Video Editing ─────────────────────────────────────────────────────────
  { id: "video-tools", name: "Video Tools", category: "video", badge: "PRO", visualKind: "film", href: "/apps/video-tools",
    description: "Upscale, extend, and enhance videos with production-ready workflows.", meta: "Upscale · Extend",
    icon: "🎬", accent: "#3BE7FF", preview: G_CYAN, previewType: "video", previewSrc: "/apps/previews/video-tools-preview.mp4", previewAlt: "Video enhancement and upscale preview" },
  { id: "video-upscale", name: "Video Upscale", category: "video", badge: "PRO", visualKind: "film", href: "/apps/video-tools?tool=upscale",
    description: "Improve video quality and resolution.", meta: "Video",
    icon: "📺", accent: "#3BE7FF", preview: G_CYAN, previewType: "video", previewSrc: "/apps/previews/video-upscale-preview.mp4", previewAlt: "Video upscale enhancement preview" },
  { id: "video-extend", name: "Video Extend", category: "video", badge: "PRO", visualKind: "film", href: "/apps/video-tools?tool=extend",
    description: "Extend video clips through the canonical Video Tools workflow.", meta: "Video",
    icon: "⏭️", accent: "#3BE7FF", preview: G_CYAN, previewType: "video", previewSrc: "/apps/previews/video-extend-preview.mp4", previewAlt: "Video extension preview" },
  { id: "shorts-generator", name: "Shorts Generator", category: "video", badge: "NEW", visualKind: "film", href: "/apps/shorts-generator",
    description: "Script and voiceover now. Full video assembly coming later.", meta: "Script · Voiceover",
    icon: "🎞️", accent: "#8b5cf6", preview: G_VIOLET, previewType: "video", previewSrc: "/apps/previews/shorts-generator-preview.mp4", previewAlt: "Short-form content generation preview" },
  { id: "reddit-story", name: "Reddit Story Video Maker", category: "video", badge: "SOON", visualKind: "film",
    description: "Package story-style scripts for viral video formats.", meta: "Story · Video",
    icon: "👽", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/reddit-story-video-maker-preview.mp4", previewAlt: "Story video generation preview" },

  // ── Image Editing ─────────────────────────────────────────────────────────
  { id: "background-remover", name: "Background Remover", category: "image", badge: "PRO", visualKind: "split", href: "/apps/background-remover",
    description: "Remove backgrounds for product, creator, and marketing assets.", meta: "Cleanup · Remove",
    icon: "✂️", accent: "#06b6d4", preview: G_CYAN, previewType: "video", previewSrc: "/apps/previews/background-remover-preview.mp4", previewAlt: "Background removal product cutout preview" },
  { id: "object-eraser", name: "Object Eraser", category: "image", badge: "PRO", visualKind: "split", href: "/apps/object-eraser",
    description: "Erase unwanted objects and clean up visuals.", meta: "Cleanup · Mask",
    icon: "🧹", accent: "#3b82f6", preview: G_BLUE, previewType: "video", previewSrc: "/apps/previews/object-eraser-preview.mp4", previewAlt: "Object eraser cleanup preview" },
  { id: "image-extension", name: "Image Extension", category: "image", badge: "PRO", visualKind: "frame", href: "/apps/image-extension",
    description: "Reframe and extend images into a new aspect ratio.", meta: "Expand · Reframe",
    icon: "↔️", accent: "#6366f1", preview: G_INDIGO, previewType: "video", previewSrc: "/apps/previews/image-extension-preview.mp4", previewAlt: "Image extension outpainting preview" },
  { id: "text-remover", name: "Text Remover", category: "image", badge: "PRO", visualKind: "split", href: "/apps/text-remover",
    description: "Remove unwanted text from images with AI cleanup.", meta: "Text cleanup",
    icon: "✨", accent: "#06b6d4", preview: G_CYAN, previewType: "video", previewSrc: "/apps/previews/text-remover-preview.mp4", previewAlt: "Text removal cleanup preview" },
  { id: "image-edit", name: "Image Edit Tools", category: "image", badge: "PRO", visualKind: "frame", href: "/edit",
    description: "Inpaint, relight, face swap, background remove, expand, and upscale images.", meta: "Edit · Retouch",
    icon: "🎨", accent: "#6366f1", preview: G_INDIGO, previewType: "gradient", previewAlt: "Image editing preview" },

  // ── Face & Identity ─────────────────────────────────────────────────────────
  { id: "lip-sync", name: "Lip Sync", category: "face", badge: "PRO", visualKind: "wave", href: "/apps/lip-sync",
    description: "Sync voice and face movement for avatars, characters, and video scenes.", meta: "Voice · Avatar",
    icon: "💬", accent: "#3b82f6", preview: G_BLUE, previewType: "video", previewSrc: "/apps/previews/lip-sync-preview.mp4", previewAlt: "Lip sync avatar voice preview" },
  { id: "skin-enhancer", name: "Skin Enhancer", category: "face", badge: "PRO", visualKind: "frame", href: "/apps/skin-enhancer",
    description: "Refine portraits and creator visuals with subtle enhancement.", meta: "Portrait",
    icon: "💆", accent: "#8b5cf6", preview: G_VIOLET, previewType: "video", previewSrc: "/apps/previews/skin-enhancer-preview.mp4", previewAlt: "Portrait skin enhancement preview" },
  { id: "style-snap", name: "Style Snap", category: "face", badge: "PRO", visualKind: "frame", href: "/apps/style-snap",
    description: "Swap outfits from a style reference while keeping the person, pose, and composition clean.", meta: "Outfit · Try-on",
    icon: "👗", accent: "#8b5cf6", preview: G_VIOLET, previewType: "video", previewSrc: "/apps/previews/style-snap-preview.mp4", previewAlt: "Style Snap outfit change preview" },
  { id: "celebrity-selfie", name: "Celebrity Selfie Studio", category: "face", badge: "SOON", visualKind: "frame",
    description: "Create stylized selfie-style content concepts.", meta: "Social",
    icon: "🤳", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/celebrity-selfie-studio-preview.mp4", previewAlt: "Luxury selfie studio preview" },

  // ── Trending ────────────────────────────────────────────────────────────────
  { id: "captioncrafter", name: "CaptionCrafter Pro", category: "trending", badge: "SOON", visualKind: "panels",
    description: "Create captions and hooks for short-form content.", meta: "Social",
    icon: "📝", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/captioncrafter-pro-preview.mp4", previewAlt: "Caption and short-form hook generation preview" },
  { id: "memesmith", name: "MemeSmith AI", category: "trending", badge: "SOON", visualKind: "panels",
    description: "Generate meme concepts and punchy visual ideas.", meta: "Meme",
    icon: "😂", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/memesmith-preview.mp4", previewAlt: "Meme and viral content ideation preview" },
  { id: "reality-expectations", name: "Reality vs Expectations", category: "trending", badge: "SOON", visualKind: "panels",
    description: "Generate contrast-based social concepts.", meta: "Social",
    icon: "⚖️", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/reality-vs-expectations-preview.mp4", previewAlt: "Reality versus expectations content preview" },
  { id: "comic-strip", name: "Comic Strip Crafter", category: "trending", badge: "SOON", visualKind: "panels",
    description: "Turn ideas into comic-style scene concepts.", meta: "Comic",
    icon: "💥", accent: "#8b5cf6", preview: G_TPL, previewType: "video", previewSrc: "/apps/previews/comic-strip-crafter-preview.mp4", previewAlt: "Comic strip generation preview" },

  // ── Extras ────────────────────────────────────────────────────────────────
  { id: "audio-studio", name: "Audio Studio", category: "extras", badge: "PRO", visualKind: "wave", href: "/audio",
    description: "Generate music, voiceovers, and sound effects in one audio workspace.", meta: "Music · Voice · SFX",
    icon: "🎵", accent: "#a855f7", preview: G_PURPLE, previewType: "video", previewSrc: "/apps/previews/audio-studio-preview.mp4", previewAlt: "Audio studio waveform and microphone preview" },
  { id: "image-to-3d", name: "Image to 3D", category: "extras", badge: "SOON", visualKind: "mesh",
    description: "Turn visual references into 3D-ready creative assets.", meta: "3D",
    icon: "🧊", accent: "#a855f7", preview: G_PURPLE, previewType: "video", previewSrc: "/apps/previews/image-to-3d-preview.mp4", previewAlt: "Image to 3D object transformation preview" },
]

// Per-category CSS scene motif (no emoji as the main preview). Abstract + premium.
function PreviewMotif({ kind, accent }: { kind: VisualKind; accent: string }) {
  const line = `${accent}40`
  const soft = `${accent}16`
  if (kind === "film") return (
    <>
      <div className="absolute left-0 right-0 top-5 h-2.5" style={{ backgroundImage: `repeating-linear-gradient(90deg, ${line} 0 7px, transparent 7px 19px)`, opacity: 0.5 }} />
      <div className="absolute left-0 right-0 bottom-5 h-2.5" style={{ backgroundImage: `repeating-linear-gradient(90deg, ${line} 0 7px, transparent 7px 19px)`, opacity: 0.5 }} />
      <div className="absolute inset-x-8 top-12 bottom-12 rounded-lg" style={{ border: `1px solid ${line}`, background: soft }} />
      <div className="absolute left-8 right-8 bottom-[42px] h-px" style={{ background: line }} />
      <div className="absolute bottom-[38px] left-1/3 w-1.5 h-1.5 rounded-full" style={{ background: accent, boxShadow: `0 0 10px ${accent}` }} />
    </>
  )
  if (kind === "wave") return (
    <>
      <div className="absolute left-1/2 top-10 -translate-x-1/2 w-16 h-16 rounded-full" style={{ border: `1px solid ${line}`, background: soft }} />
      <div className="absolute inset-x-8 bottom-10 flex items-center justify-between gap-1 h-12">
        {[8,16,26,12,22,32,14,24,10,20,30,13,18].map((h, i) => (
          <span key={i} className="flex-1 rounded-full" style={{ height: h, background: accent, opacity: 0.5 }} />
        ))}
      </div>
    </>
  )
  if (kind === "split") return (
    <>
      <div className="absolute inset-y-8 left-8 right-1/2 mr-1.5 rounded-md" style={{ background: soft }} />
      <div className="absolute inset-y-8 left-1/2 w-px" style={{ background: `${accent}80` }} />
      <div className="absolute inset-y-12 left-1/2 right-8 ml-1.5 rounded-md" style={{ border: `1px dashed ${line}` }} />
    </>
  )
  if (kind === "frame") return (
    <>
      <div className="absolute inset-9 rounded-lg" style={{ border: `1px solid ${line}` }} />
      <div className="absolute inset-[52px] rounded-md" style={{ border: `1px solid ${accent}26`, background: soft }} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-9 h-9 rotate-45" style={{ border: `1px solid ${line}` }} />
    </>
  )
  if (kind === "mesh") return (
    <>
      <div className="absolute inset-0" style={{
        backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
        backgroundSize: "24px 24px", opacity: 0.45,
        WebkitMaskImage: "radial-gradient(circle at 50% 52%, black, transparent 72%)",
        maskImage: "radial-gradient(circle at 50% 52%, black, transparent 72%)",
      }} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-14 h-14 rotate-45" style={{ border: `1px solid ${accent}88`, background: soft }} />
    </>
  )
  // panels
  return (
    <div className="absolute inset-9 grid grid-cols-2 grid-rows-2 gap-2.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-md" style={{ border: `1px solid ${line}`, background: i % 3 === 0 ? soft : "transparent" }} />
      ))}
    </div>
  )
}

function Badge({ badge }: { badge: ToolBadge }) {
  const m = BADGE_META[badge]
  return (
    // Premium label (PRO/NEW spirit): solid vivid fill, high-contrast bold text, compact, subtle edge.
    <span
      className="inline-flex items-center text-[10px] font-extrabold uppercase rounded px-2 py-0.5 whitespace-nowrap"
      style={{
        background: m.bg,
        color: m.text,
        letterSpacing: "0.04em",
        border: "1px solid rgba(255,255,255,0.22)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
      }}
    >
      {badge}
    </span>
  )
}

function GalleryCard({ tool, hovered, onHover, onLeave, index }: {
  tool: ToolCard; hovered: boolean; onHover: (id: string) => void; onLeave: () => void; index: number
}) {
  const clickable = !!tool.href

  const inner = (
    <div
      className="rounded-2xl overflow-hidden h-full flex flex-col"
      style={{
        background: "rgba(255,255,255,0.02)",
        // Border integrates with the dark background. Hover = thin subtle outline brightens slightly.
        // No lift, no scale, no glow cloud behind the card.
        border: clickable && hovered ? "1px solid rgba(255,255,255,0.22)" : "1px solid rgba(255,255,255,0.05)",
        boxShadow: "0 1px 8px rgba(0,0,0,0.25)",
        // Full opacity so video previews stay clean/visible; planned (SOON) cards are signalled by their badge, not by dimming.
        opacity: 1,
        transition: "border-color 0.18s ease",
      }}
    >
      {/* Preview slot (tall, scene-led) */}
      <div className="relative overflow-hidden" style={{ height: 268, background: tool.preview }}>
        {tool.previewSrc && tool.previewType !== "video" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tool.previewSrc} alt={tool.previewAlt ?? tool.name} className="absolute inset-0 w-full h-full object-cover" loading="lazy" decoding="async" />
        )}
        {tool.previewSrc && tool.previewType === "video" && (
          // Mixed 4:3 / 16:9 previews handled by object-cover + center crop (no black bars). Ambient autoplay.
          <video className="absolute inset-0 w-full h-full object-cover object-center" src={tool.previewSrc} autoPlay muted loop playsInline preload="metadata" style={{ filter: "brightness(1.08) contrast(1.04) saturate(1.04)" }} />
        )}
        {!tool.previewSrc && <PreviewMotif kind={tool.visualKind} accent={tool.accent} />}

        {/* premium badge (own solid fill + shadow → legible over the clean video, no scrim needed) */}
        <div className="absolute top-3.5 left-3.5"><Badge badge={tool.badge} /></div>
      </div>

      {/* Body — compact, no CTA button */}
      <div className="flex flex-col flex-1 px-4 py-4">
        <h3 className="text-white font-semibold text-[15px] leading-tight mb-1.5">{tool.name}</h3>
        <p className="text-white/45 text-xs leading-relaxed mb-3">{tool.description}</p>
        {tool.meta && <span className="mt-auto text-[11px] tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>{tool.meta}</span>}
      </div>
    </div>
  )

  if (!clickable) return <div className="cursor-default h-full" aria-disabled="true">{inner}</div>
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.03, 0.35) }}
      onMouseEnter={() => onHover(tool.id)} onMouseLeave={onLeave}
      className="h-full"
    >
      <Link href={tool.href!} className="block h-full">{inner}</Link>
    </motion.div>
  )
}

export default function AppsPage() {
  const { data: session } = useAuthSession()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userPlan = ((session?.user as any)?.plan ?? "free") as PlanId
  const [showUpgrade, setShowUpgrade] = useState(false)
  const hasAccess = hasPageAccess(userPlan, "apps")
  const [hovered, setHovered] = useState<string | null>(null)
  const [cat, setCat] = useState<ToolCategory>("professional") // default: Professional (never "All")
  const [search, setSearch] = useState("")

  const q = search.trim().toLowerCase()
  const activeCat = CATEGORIES.find((c) => c.id === cat)!
  const visibleTools = useMemo(() => TOOLS.filter((t) =>
    t.category === cat &&
    (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.meta ?? "").toLowerCase().includes(q))
  ), [cat, q])

  if (!hasAccess) return (
    <>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16, textAlign: "center" }}>
        <QIcon name="lock" size={40} strokeWidth={1.3} style={{ opacity: 0.6 }} />
        <h2 style={{ color: "#F4F7FB", fontSize: 22, fontWeight: 800 }}>This feature requires a higher plan</h2>
        <p style={{ color: "#AAB2BF", fontSize: 14 }}>Upgrade your plan to unlock this feature.</p>
        <button onClick={() => setShowUpgrade(true)} style={{ background: "#7B61FF", color: "white", border: "none", borderRadius: 10, padding: "12px 28px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
          Upgrade Now →
        </button>
      </div>
      <UpgradeModal isOpen={showUpgrade} onClose={() => setShowUpgrade(false)} requiredPlan="pro" featureName="Apps" />
    </>
  )

  return (
    <div className="min-h-screen" style={{ background: "#050507" }}>
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{
        background: "radial-gradient(120% 60% at 10% -8%, rgba(123,97,255,0.10), transparent 58%), radial-gradient(120% 55% at 98% -2%, rgba(59,231,255,0.06), transparent 58%)",
      }} />

      {/* Hero */}
      <div className="relative px-6 lg:px-12 pt-16 lg:pt-12 pb-2">
        <div className="max-w-[1440px] mx-auto">
          <h1 className="text-3xl lg:text-[40px] font-bold text-white tracking-tight leading-none">Qelarix Apps</h1>
          <p className="text-white/40 text-sm lg:text-base mt-3 max-w-2xl">
            Creative tools, templates, and workflow apps for faster production.
          </p>

          {/* One composed control row — search + category rail on the same horizontal system */}
          <div className="mt-8 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-5">
            {/* subtle premium search */}
            <div className="relative w-full lg:w-72 flex-shrink-0 rounded-md border border-white/[0.07] bg-white/[0.02] focus-within:border-white/20 transition-colors">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tools, templates, studios..."
                className="w-full bg-transparent rounded-md pl-9 pr-8 py-2 text-sm text-white placeholder-white/30 focus:outline-none"
              />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors" aria-label="Clear search">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            {/* subtle bordered category rail (almost-invisible borders; selected is clearer but restrained) */}
            <div className="flex gap-2 overflow-x-auto scrollbar-hide -mx-6 lg:mx-0 px-6 lg:px-0">
              {CATEGORIES.map((c) => {
                const active = cat === c.id
                return (
                  <button
                    key={c.id} onClick={() => setCat(c.id)}
                    className={`whitespace-nowrap flex-shrink-0 rounded-md px-3 py-1.5 text-sm font-medium border transition-colors ${
                      active
                        ? "text-white border-white/20 bg-white/[0.05]"
                        : "text-white/45 border-white/[0.06] hover:text-white/80 hover:border-white/[0.14]"
                    }`}
                  >
                    {c.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-7 h-px w-full" style={{ background: "rgba(255,255,255,0.05)" }} />
        </div>
      </div>

      {/* Gallery */}
      <div className="relative px-6 lg:px-12 py-8 pb-24">
        <div className="max-w-[1440px] mx-auto">
          <div className="mb-6">
            <h2 className="text-white text-2xl font-bold tracking-tight">{activeCat.label}</h2>
            <p className="text-white/40 text-sm mt-1.5">{activeCat.subtitle}</p>
          </div>

          {visibleTools.length === 0 ? (
            <div className="py-24 text-center">
              <p className="text-white/55 font-medium mb-1">No results</p>
              <p className="text-white/30 text-sm">Try a different search or category.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {visibleTools.map((t, i) => (
                <GalleryCard key={t.id} tool={t} index={i}
                  hovered={hovered === t.id} onHover={setHovered} onLeave={() => setHovered(null)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
