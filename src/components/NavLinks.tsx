"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ImagePlus, Camera, UserRound, Sun, Maximize2, Eraser, Expand, RemoveFormatting,
  Clapperboard, Smartphone, ArrowUp, FastForward, Megaphone, AudioLines,
  Music, Mic, Waves, type LucideIcon,
} from "lucide-react";

// ─── Dropdown data ─────────────────────────────────────────────────────────────
// Feature rows use professional monochrome Lucide icons (no emoji). Model rows use real
// provider logos from /public (rendered white/monochrome) with an initials fallback when a
// logo asset is intentionally not mapped. Routing/hrefs are unchanged — this is UI polish only.

type FeatureItem = { icon: LucideIcon; label: string; desc: string; href: string; badge: string | null };
type ModelItem = { label: string; desc: string; href: string; badge: string | null; logo: string | null };
type DropdownData = { features: FeatureItem[]; models: ModelItem[] };

const IMAGE_DROPDOWN: DropdownData = {
  features: [
    { icon: ImagePlus, label: "Create Image", desc: "Generate AI images", href: "/image", badge: null },
    { icon: Camera, label: "Cinematic Cameras", desc: "Image generation with camera controls", href: "/image?tool=cinematic", badge: "TOP" },
    { icon: UserRound, label: "Character Generator", desc: "Create consistent characters", href: "/character", badge: null },
    { icon: Sun, label: "Relight", desc: "Adjust lighting, position and color", href: "/edit?tool=relight", badge: null },
    { icon: Maximize2, label: "Image Upscale", desc: "Enhance image quality", href: "/edit?tool=upscale", badge: null },
    { icon: Eraser, label: "Background Remove", desc: "Remove background instantly", href: "/apps/background-remover", badge: null },
    { icon: Expand, label: "Image Extension", desc: "Reframe images into a new aspect ratio", href: "/apps/image-extension", badge: null },
    { icon: RemoveFormatting, label: "Text Remover", desc: "Remove unwanted text from images", href: "/apps/text-remover", badge: null },
  ],
  // Model entries deep-link into Create Image (/image?model=<catalog id from src/lib/models.ts>).
  models: [
    { label: "GPT Image 2", desc: "4K images with near-perfect text rendering", href: "/image?model=gpt_image2", badge: "NEW", logo: "/qelarix-image-model-logos/openai.png" },
    { label: "Seedream 5.0", desc: "Intelligent visual reasoning", href: "/image?model=seedream45", badge: "NEW", logo: "/qelarix-image-model-logos/seedream-bytedance.png" },
    { label: "Nano Banana Pro", desc: "Best 4K image model", href: "/image?model=nano_banana_pro", badge: null, logo: "/qelarix-image-model-logos/google-gemini-alt.png" },
    { label: "FLUX 2 Pro", desc: "Photorealism #1", href: "/image?model=flux2_pro", badge: null, logo: "/qelarix-image-model-logos/flux.png" },
    { label: "Grok Imagine", desc: "Cinematic AI portraits by xAI", href: "/image?model=grok_imagine", badge: "TOP", logo: "/qelarix-image-model-logos/grok.png" },
    { label: "FLUX 2 Max", desc: "Highest FLUX quality", href: "/image?model=flux2_max", badge: null, logo: "/qelarix-image-model-logos/flux.png" },
    { label: "Ideogram V3", desc: "Typography #1", href: "/image?model=ideogram3", badge: null, logo: "/qelarix-image-model-logos/ideogram.png" },
    { label: "Recraft V4", desc: "SVG/vector output", href: "/image?model=recraft_v4", badge: null, logo: "/qelarix-image-model-logos/recraft.png" },
  ],
};

const VIDEO_DROPDOWN: DropdownData = {
  features: [
    { icon: Clapperboard, label: "Create Video", desc: "Generate AI videos", href: "/video", badge: null },
    { icon: Smartphone, label: "Shorts Generator", desc: "TikTok & Reels in minutes", href: "/apps/shorts-generator", badge: "NEW" },
    { icon: ArrowUp, label: "Video Upscale", desc: "Enhance video quality", href: "/apps/video-tools?tool=upscale", badge: null },
    { icon: FastForward, label: "Video Extend", desc: "Extend existing videos", href: "/apps/video-tools?tool=extend", badge: null },
    { icon: Megaphone, label: "Click to Ad", desc: "Turn URLs into video ads", href: "/marketing", badge: null },
    { icon: AudioLines, label: "Lip Sync Studio", desc: "Create talking clips", href: "/apps/lip-sync", badge: null },
  ],
  // Model entries deep-link into Create Video (/video?model=<id>); ids the workspace hides
  // (comingSoon: happy_horse, wan26) are ignored safely and the default model stays.
  models: [
    { label: "Seedance 2.0", desc: "Native audio + video generation", href: "/video?model=seedance2", badge: "TOP", logo: "/qelarix-video-model-logos/seedance-bytedance.png" },
    { label: "Kling 3.0", desc: "Best price/quality ratio", href: "/video?model=kling3", badge: "TOP", logo: "/qelarix-video-model-logos/kling.png" },
    { label: "Kling 3.0 Pro", desc: "Professional cinematic control", href: "/video?model=kling3_pro", badge: null, logo: "/qelarix-video-model-logos/kling.png" },
    // Happy Horse: dropdown id `happy_horse` maps to provider "Happy Horse" / Haiper in models.ts (NOT confirmed
    // MiniMax/Hailuo), so per the "do not guess" rule we use the initials fallback rather than hailuo-mono.png.
    { label: "Happy Horse 1.0", desc: "#1 ranked video + audio", href: "/video?model=happy_horse", badge: "NEW", logo: null },
    // Veo row: keeps the current label + deep-link (model=veo4). NOTE: catalog `veo4` is actually "Veo 2" and a real
    // `veo3` ("Veo 3", NEW) exists separately — switching this row to Veo 3 is a model/config + routing decision, out
    // of scope for this UI polish task (see report). Logo uses the Google Veo mark.
    { label: "Veo 4", desc: "Native 4K + integrated audio", href: "/video?model=veo4", badge: null, logo: "/qelarix-video-model-logos/veo-google.png" },
    { label: "Grok Video", desc: "Cinematic clips with audio", href: "/video?model=grok_video", badge: null, logo: "/qelarix-video-model-logos/grok.png" },
    { label: "Luma Ray 3", desc: "Atmospheric effects", href: "/video?model=luma_ray3", badge: null, logo: "/qelarix-video-model-logos/luma.png" },
    { label: "Wan 2.6", desc: "Best budget video model", href: "/video?model=wan26", badge: null, logo: "/qelarix-video-model-logos/wan_logo_icon_only.png" },
    { label: "LTX 2.0", desc: "Open-source 1080p", href: "/video?model=ltx2", badge: null, logo: "/qelarix-video-model-logos/ltx.png" },
    { label: "Pika 2.5", desc: "Social media effects", href: "/video?model=pika25", badge: null, logo: "/qelarix-video-model-logos/pika.png" },
  ],
};

const AUDIO_DROPDOWN: DropdownData = {
  features: [
    { icon: Music, label: "Generate Music", desc: "AI music and audio", href: "/audio", badge: null },
    { icon: Mic, label: "Voice Over", desc: "Text to speech", href: "/audio?tool=tts", badge: null },
    { icon: Waves, label: "Sound FX", desc: "Generate sound effects", href: "/audio?tool=sfx", badge: null },
  ],
  models: [
    { label: "Stability Audio 30sec", desc: "Music loops, stems", href: "/audio?model=stability_audio", badge: null, logo: "/qelarix-image-model-logos/stability.png" },
    { label: "Stability Audio 2min", desc: "Full tracks", href: "/audio?model=stability_2min", badge: null, logo: "/qelarix-image-model-logos/stability.png" },
  ],
};

type DropdownKey = "image" | "video" | "audio";

const DROPDOWN_MAP: Record<DropdownKey, DropdownData> = {
  image: IMAGE_DROPDOWN,
  video: VIDEO_DROPDOWN,
  audio: AUDIO_DROPDOWN,
};

const NAV_ITEMS = [
  { label: "Community", href: "/community", dropdown: null },
  { label: "Image", href: "/image", dropdown: "image" as DropdownKey },
  { label: "Video", href: "/video", dropdown: "video" as DropdownKey },
  { label: "Audio", href: "/audio", dropdown: "audio" as DropdownKey },
  { label: "Playground", href: "/playground", dropdown: null, badge: "New" },
  { label: "Storyboard", href: "/storyboard", dropdown: null },
  { label: "Viral Mode", href: "/marketing", dropdown: null },
  { label: "Influencer", href: "/ai-influencer", dropdown: null },
  { label: "Cinema Studio", href: "/cinema-studio-new", dropdown: null },
  { label: "Apps", href: "/apps", dropdown: null },
  { label: "API", href: "/developers", dropdown: null },
  { label: "MCP", href: "/mcp", dropdown: null },
];

// First-letter initials fallback for a model with no mapped logo (e.g. "Happy Horse 1.0" → "HH").
const initials = (label: string) =>
  label.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

// ─── Badge chip ─────────────────────────────────────────────────────────────────

function BadgeChip({ text, variant }: { text: string; variant: "top" | "new" | "nav" }) {
  if (variant === "nav") {
    // Top-nav badge (e.g. Playground "New") — unchanged purple pill.
    return (
      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: "rgba(123,97,255,0.25)", color: "#A78BFA", border: "1px solid rgba(123,97,255,0.4)" }}>
        {text}
      </span>
    );
  }
  // Dropdown item badge — Playground-style compact rectangular neon (lime). TOP and NEW share this look.
  return (
    <span
      className="flex-shrink-0 uppercase"
      style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: 0.5, padding: "2px 6px", borderRadius: 3, background: "#CBF24E", color: "#1A2208", lineHeight: 1 }}
    >
      {text}
    </span>
  );
}

// ─── Mega dropdown panel ────────────────────────────────────────────────────────

function DropdownPanel({ data }: { data: DropdownData }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="absolute top-full left-0 mt-1 z-50"
      style={{
        width: 720,
        background: "#101018",
        border: "1px solid rgba(167,139,250,0.16)",
        borderRadius: 16,
        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
      }}
    >
      <div className="grid grid-cols-2 p-4 gap-2">
        <div>
          <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider px-2 mb-2">Features</p>
          {data.features.map((item) => {
            const FeatureIcon = item.icon;
            return (
              <Link key={item.href} href={item.href} className="flex items-center gap-3 px-2 py-2 rounded-lg transition-all duration-150"
                onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(123,97,255,0.08)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; }}
              >
                <div className="flex-shrink-0 flex items-center justify-center" style={{ width: 36, height: 36, background: "#1A1F2A", borderRadius: 10, border: "1px solid #2A2F3A" }}>
                  <FeatureIcon size={17} strokeWidth={1.7} color="rgba(255,255,255,0.82)" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-white text-xs font-medium">{item.label}</span>
                    {item.badge && <BadgeChip text={item.badge} variant={item.badge === "TOP" ? "top" : "new"} />}
                  </div>
                  <p className="text-white/40 text-[11px] mt-0.5 truncate">{item.desc}</p>
                </div>
              </Link>
            );
          })}
        </div>
        <div>
          <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider px-2 mb-2">Models</p>
          {data.models.map((item) => (
            <Link key={item.href} href={item.href} className="flex items-center gap-3 px-2 py-2 rounded-lg transition-all duration-150"
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(123,97,255,0.08)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; }}
            >
              <div className="flex-shrink-0 flex items-center justify-center" style={{ width: 36, height: 36, background: "linear-gradient(135deg, #1A1F2A, #0d0d14)", borderRadius: 10, border: "1px solid #2A2F3A" }}>
                {item.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.logo} alt="" style={{ width: 20, height: 20, objectFit: "contain", filter: "brightness(0) invert(1)", opacity: 0.92 }} />
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.72)", letterSpacing: 0.3 }}>{initials(item.label)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-white text-xs font-medium">{item.label}</span>
                  {item.badge && <BadgeChip text={item.badge} variant={item.badge === "TOP" ? "top" : "new"} />}
                </div>
                <p className="text-white/40 text-[11px] mt-0.5 truncate">{item.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── NavLinks — desktop nav with active state ────────────────────────────────────

export function NavLinks() {
  const pathname = usePathname();
  const [activeDropdown, setActiveDropdown] = useState<DropdownKey | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const clearTimers = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (switchTimer.current) clearTimeout(switchTimer.current);
  };
  // Opening from closed is instant. Switching from one open menu to another waits briefly, so a cursor that
  // crosses Video/Audio on its way down into the Image panel does not swap the menu under it.
  const openDropdown = (key: DropdownKey) => {
    clearTimers();
    if (activeDropdown === null || activeDropdown === key) {
      setActiveDropdown(key);
      return;
    }
    switchTimer.current = setTimeout(() => setActiveDropdown(key), 220);
  };
  // Keep the open menu while the cursor is anywhere on it (cancels a pending close or switch).
  const holdDropdown = () => clearTimers();
  const scheduleClose = () => {
    if (switchTimer.current) clearTimeout(switchTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setActiveDropdown(null), 400); // generous delay so a curved path from label to panel never closes it
  };

  return (
    <div className="hidden md:flex items-center gap-1 flex-1 overflow-visible">
      {NAV_ITEMS.map((item) => {
        // Same label styling for both the link items and the hover-trigger items (no layout shift).
        const navClass = "qxh-nav-link relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] transition-colors duration-200 whitespace-nowrap";
        const navStyle = { color: isActive(item.href) ? "#3BE7FF" : "rgba(255,255,255,0.66)" };
        const navBadge = item.badge; // read on the un-narrowed item (only the Playground link carries a nav badge)
        return (
          <div
            key={item.href}
            className="relative flex-shrink-0"
            onMouseEnter={() => item.dropdown ? openDropdown(item.dropdown as DropdownKey) : scheduleClose()}
            onMouseLeave={() => item.dropdown ? scheduleClose() : undefined}
          >
            {item.dropdown ? (
              // Image / Video / Audio — HOVER-ONLY dropdown trigger: a real <button> (not a route link) so it never
              // navigates on click; the dropdown opens/closes purely via the wrapper's onMouseEnter/onMouseLeave.
              // Chevron removed per design. Active text color is preserved from the route (no visual shift).
              <button type="button" className={`${navClass} bg-transparent border-0 cursor-pointer`} style={navStyle} aria-haspopup="menu" aria-expanded={activeDropdown === item.dropdown}>
                {item.label}
                {navBadge && <BadgeChip text={navBadge} variant="nav" />}
              </button>
            ) : (
              <Link href={item.href} className={navClass} style={navStyle}>
                {item.label}
                {navBadge && <BadgeChip text={navBadge} variant="nav" />}
              </Link>
            )}
            {item.dropdown && activeDropdown === item.dropdown && (
              <div onMouseEnter={holdDropdown} onMouseLeave={() => scheduleClose()}>
                {/* Transparent hover bridge over the label→panel gap, as wide as the panel, so moving the cursor
                    from the trigger into any part of the dropdown never crosses a dead zone. Decorative only. */}
                <div className="absolute top-full left-0" style={{ height: 14, width: 720 }} aria-hidden />
                <AnimatePresence>
                  <DropdownPanel data={DROPDOWN_MAP[item.dropdown as DropdownKey]} />
                </AnimatePresence>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── PricingLink — separate so Header can Suspense-wrap it ───────────────────────

export function PricingLink() {
  const pathname = usePathname();
  const isActive = pathname === "/pricing";
  return (
    <Link
      href="/pricing"
      className="text-sm font-medium transition-colors duration-200"
      style={{ color: isActive ? "#3BE7FF" : "rgba(255,255,255,0.6)", fontWeight: isActive ? 600 : 500 }}
    >
      Pricing
    </Link>
  );
}

// ─── MobileNavLinks — mobile drawer nav with active state ────────────────────────

export function MobileNavLinks({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="flex items-center gap-2 text-sm font-medium transition-colors py-2.5 px-3 rounded-lg hover:bg-white/5"
          style={{ color: isActive(item.href) ? "#3BE7FF" : "rgba(255,255,255,0.7)" }}
          onClick={onClose}
        >
          {item.label}
          {item.badge && <BadgeChip text={item.badge} variant="nav" />}
        </Link>
      ))}
      <Link href="/pricing" className="text-white/70 hover:text-white text-sm font-medium py-2.5 px-3 rounded-lg hover:bg-white/5 transition-colors" onClick={onClose}
        style={{ color: isActive("/pricing") ? "#3BE7FF" : undefined }}
      >
        Pricing
      </Link>
    </>
  );
}
