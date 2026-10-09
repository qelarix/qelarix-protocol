"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthSession } from "@/components/providers/AuthSessionProvider";
import { toast } from "sonner";
import { IMAGE_MODELS } from "@/lib/image-models";
import { VIDEO_MODELS, calculateVideoCost } from "@/lib/video-models";
import type { AspectRatio as ImageAspectRatio, ImageModelConfig } from "@/lib/image-models";
import type { ImageModel } from "@/lib/credits";
import type { VideoModelConfig } from "@/lib/video-models";
import { canAccessVideo } from "@/lib/plans";
import type { PlanId } from "@/lib/plans";
import Logo from "@/components/Logo";
import { NavLinks, PricingLink } from "@/components/NavLinks";
import GenerationViewer from "@/components/GenerationViewer";
import GenerationGallery from "@/components/GenerationGallery";
import GenerationDetailModal from "@/components/GenerationDetailModal";
import { useGenerationGallery } from "@/hooks/useGenerationGallery";
import type { GalleryItem } from "@/types/gallery";

// ─── Types ────────────────────────────────────────────────────────────────────────

type Mode = "image" | "video";

interface HistoryItem {
  id: string;
  prompt: string;
  output_url: string;
  model: string;
  type?: "video" | "image";
  settings: { aspect_ratio?: string; duration?: number; credits_used?: number };
  created_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────────

const IMAGE_ASPECT_RATIOS: ImageAspectRatio[] = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const VIDEO_ASPECT_OPTIONS = ["16:9", "9:16", "1:1"] as const;
const VIDEO_DURATION_OPTIONS = [5, 8, 10];

const SLUG_TO_IMAGE: Record<string, ImageModel> = {
  "sd35": "sd35", "flux2-pro": "flux2pro", "flux2-max": "flux2max",
  "ideogram-v3": "ideogram", "recraft-v4": "recraft", "seedream-5": "seedream5",
  "gpt-image-2": "gptimage2", "grok-imagine": "grokimagine",
  "nano-banana": "nanobanana2", "nano-banana-pro": "nanobanana_pro",
  "imagen4fast": "imagen4fast",
};

const SLUG_TO_VIDEO: Record<string, string> = {
  "seedance-2": "seedance20", "seedance-v1": "seedance2", "seedance-2-lite": "seedance2lite",
  "kling-3": "kling3", "kling-3-pro": "kling3pro", "happy-horse": "happyhorse",
  "happy-horse-10": "happyhorse10", "veo4": "veo4", "veo4-standard": "veo4_standard",
  "veo31": "veo31_standard", "grok-video": "grokvideo", "luma-ray3": "luma3",
  "wan26": "wan26", "ltx2": "ltx2", "pika25": "pika25",
};

const ASPECT_ICONS: Record<string, string> = {
  "1:1": "▪", "16:9": "▬", "9:16": "▮", "4:3": "▭", "3:4": "▯",
};

const PLAN_COLORS: Record<string, string> = {
  free: "#555", starter: "#7B61FF", pro: "#3BE7FF", business: "#f59e0b", ultra: "#ef4444",
};
const PLAN_SHORT: Record<string, string> = {
  free: "Free", starter: "STR", pro: "PRO", business: "BIZ", ultra: "ULT",
};

function parseOutputUrl(raw: string): string {
  try { const u = JSON.parse(raw); return Array.isArray(u) ? u[0] : raw; } catch { return raw; }
}

function dbToGallery(item: HistoryItem): GalleryItem {
  return {
    id: item.id,
    type: item.type ?? "video",
    url: parseOutputUrl(item.output_url),
    prompt: item.prompt,
    model: item.model,
    credits: 0,
    aspectRatio: item.settings.aspect_ratio,
    duration: item.settings.duration,
    isPublic: false,
    createdAt: new Date(item.created_at).getTime(),
  };
}

// ─── Image Model Selector Modal ───────────────────────────────────────────────────

function ImageModelModal({ models, selectedId, userPlan, onSelect, onClose }: { models: ImageModelConfig[]; selectedId: ImageModel; userPlan: string; onSelect: (id: ImageModel) => void; onClose: () => void }) {
  const PLAN_ORDER = ["free", "starter", "pro", "ultra", "business"];
  const groups: Record<string, ImageModelConfig[]> = {};
  for (const m of models) { if (!groups[m.plan]) groups[m.plan] = []; groups[m.plan].push(m); }
  const planLabel: Record<string, string> = { free: "Free", starter: "Starter+", pro: "Pro+", ultra: "Ultra+", business: "Business" };
  const userPlanIdx = PLAN_ORDER.indexOf(userPlan);
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-2xl overflow-hidden" style={{ background: "#111318", border: "1px solid #2A2F3A", maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2A2F3A]"><h3 className="text-white font-semibold text-sm">Select Image Model</h3><button onClick={onClose} className="text-white/40 hover:text-white text-lg">✕</button></div>
        <div className="overflow-y-auto" style={{ maxHeight: "calc(80vh - 60px)" }}>
          {PLAN_ORDER.filter((p) => groups[p]).map((planKey) => (
            <div key={planKey} className="px-3 py-3">
              <p className="text-white/30 text-[10px] font-bold uppercase tracking-wider px-2 mb-2">{planLabel[planKey]}</p>
              {groups[planKey].map((m) => {
                const locked = PLAN_ORDER.indexOf(m.plan) > userPlanIdx;
                const active = m.id === selectedId;
                return (
                  <button key={m.id} onClick={() => { if (!locked) { onSelect(m.id); onClose(); } }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
                    style={{ background: active ? "rgba(123,97,255,0.15)" : "transparent", border: active ? "1px solid rgba(123,97,255,0.4)" : "1px solid transparent", opacity: locked ? 0.45 : 1, cursor: locked ? "not-allowed" : "pointer" }}>
                    <span className="text-xl">{m.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2"><span className="text-white text-xs font-medium">{m.label}</span>{locked && <span className="text-[9px] text-white/30">🔒</span>}</div>
                      <p className="text-white/40 text-[11px] mt-0.5">{m.provider} · {m.credits} QLC</p>
                    </div>
                    {active && <span className="text-[#7B61FF] text-xs">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Video Model Selector Modal ───────────────────────────────────────────────────

function VideoModelModal({ models, selectedId, userPlan, duration, withAudio, onSelect, onClose }: { models: VideoModelConfig[]; selectedId: string; userPlan: PlanId; duration: number; withAudio: boolean; onSelect: (id: string) => void; onClose: () => void }) {
  const starter = models.filter((m) => ["ltx2", "wan26", "luma3", "pika25"].includes(m.id));
  const pro = models.filter((m) => !starter.includes(m));
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-2xl overflow-hidden" style={{ background: "#111318", border: "1px solid #2A2F3A", maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2A2F3A]"><h3 className="text-white font-semibold text-sm">Select Video Model</h3><button onClick={onClose} className="text-white/40 hover:text-white text-lg">✕</button></div>
        <div className="overflow-y-auto" style={{ maxHeight: "calc(80vh - 60px)" }}>
          {[{ label: "Budget (Starter+)", items: starter }, { label: "Premium (Pro+)", items: pro }].map((group) => (
            <div key={group.label} className="px-3 py-3">
              <p className="text-white/30 text-[10px] font-bold uppercase tracking-wider px-2 mb-2">{group.label}</p>
              {group.items.map((m) => {
                const hasAccess = canAccessVideo(userPlan, m.id);
                const active = m.id === selectedId;
                const cost = calculateVideoCost(m.id, duration, withAudio);
                return (
                  <button key={m.id} onClick={() => { if (hasAccess) { onSelect(m.id); onClose(); } }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
                    style={{ background: active ? "rgba(123,97,255,0.15)" : "transparent", border: active ? "1px solid rgba(123,97,255,0.4)" : "1px solid transparent", opacity: hasAccess ? 1 : 0.45, cursor: hasAccess ? "pointer" : "not-allowed" }}>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0" style={{ background: "linear-gradient(135deg,#1A1F2A,#0d0d14)", border: "1px solid #2A2F3A", color: "#7B61FF" }}>✦</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2"><span className="text-white text-xs font-medium">{m.label}</span>{!hasAccess && <span className="text-[9px] text-white/30">🔒 Pro+</span>}</div>
                      <p className="text-white/40 text-[11px] mt-0.5">{m.description} · {cost} QLC</p>
                    </div>
                    {active && <span className="text-[#7B61FF] text-xs">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── User Avatar Menu ─────────────────────────────────────────────────────────────

function UserAvatarMenu({ name, email, image, plan }: { name?: string | null; email?: string | null; image?: string | null; plan: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const planColor = PLAN_COLORS[plan] ?? "#555";
  const planShort = PLAN_SHORT[plan] ?? plan.slice(0, 3).toUpperCase();

  return (
    <div className="relative flex-shrink-0">
      <button onClick={() => setOpen((v) => !v)} className="relative block" style={{ width: 36, height: 36 }} aria-label="Account menu">
        <div style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid rgba(123,97,255,0.45)", overflow: "hidden", background: "#1A1F2A", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={name ?? "avatar"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ color: "#7B61FF", fontWeight: 700, fontSize: 15, lineHeight: 1 }}>{(name || email || "?")[0].toUpperCase()}</span>
          )}
        </div>
        <span style={{ position: "absolute", bottom: -2, right: -4, background: planColor, color: "#fff", fontSize: 7, fontWeight: 800, padding: "1px 4px", borderRadius: 4, lineHeight: 1.4, letterSpacing: "0.02em", whiteSpace: "nowrap", border: "1.5px solid #050505" }}>
          {planShort}
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[68]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-[69] rounded-2xl overflow-hidden" style={{ width: 220, background: "#111318", border: "1px solid #2A2F3A", boxShadow: "0 12px 40px rgba(0,0,0,0.7)" }}>
            <div className="px-4 py-3" style={{ borderBottom: "1px solid #1A1F2A" }}>
              <div className="flex items-center gap-3">
                <div style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid rgba(123,97,255,0.3)", overflow: "hidden", background: "#1A1F2A", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt={name ?? "avatar"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ color: "#7B61FF", fontWeight: 700, fontSize: 14 }}>{(name || email || "?")[0].toUpperCase()}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{name || "User"}</p>
                  <p className="text-white/40 text-[11px] truncate">{email}</p>
                </div>
              </div>
              <div className="mt-2.5">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: `${planColor}22`, color: planColor, border: `1px solid ${planColor}55` }}>
                  {plan.charAt(0).toUpperCase() + plan.slice(1)} Plan
                </span>
              </div>
            </div>
            <div className="py-1">
              <button onClick={() => { setOpen(false); router.push("/settings"); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors text-left">
                <span className="text-base">⚙️</span><span>Account Settings</span>
              </button>
              <button onClick={() => { setOpen(false); router.push("/dashboard"); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors text-left">
                <span className="text-base">📊</span><span>Dashboard</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── StudioInner ──────────────────────────────────────────────────────────────────

function StudioInner({ defaultMode }: { defaultMode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useAuthSession();

  const [mode] = useState<Mode>(defaultMode);

  // Image state
  const urlImageModel = SLUG_TO_IMAGE[searchParams.get("model") ?? ""] ?? "sd35";
  const [selectedImageModel, setSelectedImageModel] = useState<ImageModel>(urlImageModel);
  const [imageAspect, setImageAspect] = useState<ImageAspectRatio>("1:1");
  const [imageQuality, setImageQuality] = useState<"standard" | "hd">("standard");
  const [imageCount, setImageCount] = useState(1);

  // Video state
  const urlVideoModel = SLUG_TO_VIDEO[searchParams.get("model") ?? ""] ?? "wan26";
  const [selectedVideoModel, setSelectedVideoModel] = useState(urlVideoModel);
  const [videoDuration, setVideoDuration] = useState(5);
  const [videoAspect, setVideoAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [withAudio, setWithAudio] = useState(true);

  // Shared
  const [prompt, setPrompt] = useState("");
  const [showImageModelModal, setShowImageModelModal] = useState(false);
  const [showVideoModelModal, setShowVideoModelModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Generation viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerStatus, setViewerStatus] = useState<"generating" | "completed" | "failed">("generating");
  const [viewerUrl, setViewerUrl] = useState("");
  const [pendingItem, setPendingItem] = useState<Omit<GalleryItem, "url"> | null>(null);

  // Gallery (localStorage)
  const storageKey = `qelarix_gallery_${mode}`;
  const { items: galleryItems, addItem, deleteItem, updateItem, setItems: setGalleryItems } = useGenerationGallery(storageKey);

  // Detail modal
  const [detailItem, setDetailItem] = useState<GalleryItem | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isGeneratingRef = useRef(false);

  const imgModel = IMAGE_MODELS.find((m) => m.id === selectedImageModel) ?? IMAGE_MODELS[0];
  const vidModel = VIDEO_MODELS.find((m) => m.id === selectedVideoModel && !m.comingSoon) ?? VIDEO_MODELS[0];

  const userPlan = (session?.user?.plan ?? "free") as PlanId;
  const userCredits = session?.user?.credits ?? 0;

  const credits = mode === "image" ? imgModel.credits * imageCount : calculateVideoCost(selectedVideoModel, videoDuration, withAudio);

  const switchMode = (m: Mode) => { if (m !== mode) router.push(m === "image" ? "/image" : "/video"); };

  // Sync DB history into localStorage gallery (on load + after generation)
  const syncFromDB = useCallback(async () => {
    if (!session?.user) return;
    try {
      const [vRes, iRes] = await Promise.all([
        fetch("/api/generate/video/history?limit=50"),
        fetch("/api/generate/image/status/history?limit=50"),
      ]);
      const videos = vRes.ok ? (await vRes.json() as HistoryItem[]) : [];
      const images = iRes.ok ? (await iRes.json() as HistoryItem[]) : [];
      const dbItems: GalleryItem[] = [...videos, ...images]
        .map(dbToGallery)
        .sort((a, b) => b.createdAt - a.createdAt);
      // Merge: DB items take precedence, then localStorage-only items
      setGalleryItems((prev) => {
        const dbIds = new Set(dbItems.map((i) => i.id));
        const localOnly = prev.filter((i) => !dbIds.has(i.id));
        return [...dbItems, ...localOnly].sort((a, b) => b.createdAt - a.createdAt);
      });
    } catch { /* silent */ }
  }, [session, setGalleryItems]);

  useEffect(() => { if (session?.user) syncFromDB(); }, [session, syncFromDB]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const handleDeleteHistory = useCallback(async (id: string) => {
    try {
      await fetch(`/api/generations/${id}`, { method: "DELETE" });
      deleteItem(id);
      setDetailItem((prev) => prev?.id === id ? null : prev);
    } catch { /* silent */ }
  }, [deleteItem]);

  const handleViewerClose = () => {
    setViewerOpen(false);
    if (viewerStatus === "completed" && viewerUrl && pendingItem) {
      addItem({ ...pendingItem, url: viewerUrl });
    }
    setPendingItem(null);
    if (viewerStatus === "completed") syncFromDB();
  };

  const handlePublish = (id: string) => updateItem(id, { isPublic: true });

  const handleGenerate = async () => {
    if (status === "unauthenticated") { router.push(`/login?redirect=/${mode}`); return; }
    if (!prompt.trim()) { toast.error("Please enter a prompt."); return; }
    if (userCredits < credits) { toast.error(`Not enough QLC. Need ${credits} QLC, have ${userCredits} QLC.`); return; }
    if (isGeneratingRef.current) return;
    if (pollRef.current) clearInterval(pollRef.current);

    const itemId = Date.now().toString();
    isGeneratingRef.current = true;
    setViewerStatus("generating");
    setViewerUrl("");
    setViewerOpen(true);

    if (mode === "image") {
      setPendingItem({
        id: itemId,
        type: "image",
        prompt: prompt.trim(),
        model: imgModel.label,
        credits,
        aspectRatio: imageAspect,
        createdAt: Date.now(),
      });
      try {
        const res = await fetch("/api/generate/image", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: selectedImageModel, prompt: prompt.trim(), aspectRatio: imageAspect, numImages: imageCount, quality: imageQuality }),
        });
        if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? "Failed"); }
        const data = await res.json() as { jobId?: string };
        if (!data.jobId) throw new Error("No job ID returned");
        toast.info("Generating image...");
        pollRef.current = setInterval(async () => {
          try {
            const sr = await fetch(`/api/generate/image/status/${data.jobId}`);
            if (!sr.ok) return;
            const sd = await sr.json() as { status: string; output_urls?: string[]; error?: string };
            if (sd.status === "completed" && sd.output_urls?.length) {
              clearInterval(pollRef.current!);
              isGeneratingRef.current = false;
              // Update pending item ID to real jobId
              setPendingItem((prev) => prev ? { ...prev, id: data.jobId! } : null);
              setViewerUrl(sd.output_urls![0]);
              setViewerStatus("completed");
              toast.success("Image generated!");
            } else if (sd.status === "failed") {
              clearInterval(pollRef.current!);
              isGeneratingRef.current = false;
              setViewerStatus("failed");
              toast.error(sd.error ?? "Generation failed");
            }
          } catch { /* continue */ }
        }, 2000);
        setTimeout(() => { if (isGeneratingRef.current) { clearInterval(pollRef.current!); isGeneratingRef.current = false; setViewerStatus("failed"); } }, 300000);
      } catch (err) {
        isGeneratingRef.current = false;
        setViewerStatus("failed");
        toast.error(err instanceof Error ? err.message : "Generation failed");
      }
    } else {
      setPendingItem({
        id: itemId,
        type: "video",
        prompt: prompt.trim(),
        model: vidModel.label,
        credits,
        aspectRatio: videoAspect,
        duration: videoDuration,
        createdAt: Date.now(),
      });
      toast.info(`Generating video... (~${vidModel.estimatedSeconds}s)`);
      try {
        const res = await fetch("/api/generate/video", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: vidModel.id, prompt: prompt.trim(), aspectRatio: videoAspect, duration: videoDuration, withAudio }),
        });
        if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? "Failed"); }
        const data = await res.json() as { jobId?: string };
        if (!data.jobId) throw new Error("No job ID returned");
        const videoPoll = async () => {
          if (!isGeneratingRef.current) return;
          try {
            const sr = await fetch(`/api/generate/video/status/${data.jobId}`);
            if (!sr.ok) { pollRef.current = setTimeout(videoPoll, 3000) as unknown as ReturnType<typeof setInterval>; return; }
            const sd = await sr.json() as { status: string; output_url?: string | null; error_message?: string | null };
            if (sd.status === "completed" && sd.output_url) {
              isGeneratingRef.current = false;
              setPendingItem((prev) => prev ? { ...prev, id: data.jobId! } : null);
              setViewerUrl(sd.output_url);
              setViewerStatus("completed");
              toast.success("Video is ready!");
            } else if (sd.status === "failed" || sd.status === "error") {
              isGeneratingRef.current = false;
              setViewerStatus("failed");
              toast.error(sd.error_message ?? "Generation failed");
            } else {
              pollRef.current = setTimeout(videoPoll, 3000) as unknown as ReturnType<typeof setInterval>;
            }
          } catch { pollRef.current = setTimeout(videoPoll, 3000) as unknown as ReturnType<typeof setInterval>; }
        };
        pollRef.current = setTimeout(videoPoll, 3000) as unknown as ReturnType<typeof setInterval>;
        setTimeout(() => { if (isGeneratingRef.current) { clearTimeout(pollRef.current!); isGeneratingRef.current = false; setViewerStatus("failed"); } }, 600000);
      } catch (err) {
        isGeneratingRef.current = false;
        setViewerStatus("failed");
        toast.error(err instanceof Error ? err.message : "Generation failed");
      }
    }
  };

  const isGenerating = viewerOpen && viewerStatus === "generating";
  const promptPlaceholder = mode === "image" ? "Describe the image you want to create..." : "Describe your scene in detail...";

  return (
    <div className="fixed inset-0 z-[51] flex flex-col" style={{ background: "#050505" }}>

      {/* ── Header (same as global site header) ─────────────────────────────── */}
      <div className="flex-shrink-0 h-14" style={{ borderBottom: "1px solid #2A2F3A", background: "rgba(5,5,5,0.97)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 flex items-center h-full">
          <Link href="/" className="flex-shrink-0 mr-6"><Logo size="sm" /></Link>
          <Suspense fallback={<div className="flex-1" />}><NavLinks /></Suspense>
          <div className="hidden md:flex items-center gap-3 flex-shrink-0 ml-4">
            <Suspense fallback={null}><PricingLink /></Suspense>
            {session?.user ? (
              <UserAvatarMenu name={session.user.name} email={session.user.email} image={session.user.image} plan={userPlan} />
            ) : (
              <>
                <Link href="/login" className="text-white/70 hover:text-white text-sm font-medium transition-colors px-3 py-1.5">Login</Link>
                <Link href="/signup" className="text-white text-sm font-semibold px-4 py-1.5 rounded-lg" style={{ background: "#7B61FF" }}>Sign up</Link>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Gallery Area ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto" style={{ background: "#080810" }}>
        {galleryItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-6 px-8 text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl" style={{ background: "linear-gradient(135deg,rgba(123,97,255,0.2),rgba(59,231,255,0.2))", border: "1px solid rgba(123,97,255,0.3)" }}>
              {mode === "image" ? "🖼️" : "🎬"}
            </div>
            <div>
              <p className="text-white font-semibold text-lg">{mode === "image" ? imgModel.label : vidModel.label}</p>
              <p className="text-white/40 text-sm mt-1">{mode === "image" ? imgModel.description : vidModel.description}</p>
            </div>
            <p className="text-white/25 text-xs max-w-xs">Generate your first {mode === "image" ? "image" : "video"} to see it here</p>
          </div>
        ) : (
          <GenerationGallery
            items={galleryItems}
            onDelete={(id) => setDeleteConfirm(id)}
            onItemClick={(item) => setDetailItem(item)}
          />
        )}
      </div>

      {/* ── Bottom Bar ───────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 pt-3 pb-4" style={{ background: "#0D0D12", borderTop: "1px solid #2A2F3A" }}>
        <div className="flex items-end gap-3 mb-3">
          <button className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-white/40 hover:text-white hover:bg-white/5 transition-all" style={{ border: "1px solid #2A2F3A" }}>+</button>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
            placeholder={promptPlaceholder}
            rows={1}
            className="flex-1 resize-none bg-transparent text-white text-sm placeholder-white/30 outline-none leading-6"
            style={{ maxHeight: 120, overflowY: "auto" }}
            onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }}
          />
          <button onClick={handleGenerate} disabled={isGenerating}
            className="flex-shrink-0 flex items-center gap-2 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: isGenerating ? "rgba(123,97,255,0.5)" : "#7B61FF" }}>
            {isGenerating
              ? <><span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Generating...</>
              : <>Generate · <span style={{ color: "#3BE7FF" }}>{credits} QLC</span></>}
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Mode Toggle */}
          <div className="flex items-center rounded-lg overflow-hidden flex-shrink-0" style={{ border: "1px solid #2A2F3A" }}>
            <button onClick={() => switchMode("image")} className="px-3 py-1.5 text-xs font-semibold transition-all"
              style={{ background: mode === "image" ? "#7B61FF" : "#111318", color: mode === "image" ? "#fff" : "rgba(255,255,255,0.4)" }}>🖼 Images</button>
            <button onClick={() => switchMode("video")} className="px-3 py-1.5 text-xs font-semibold transition-all"
              style={{ background: mode === "video" ? "#7B61FF" : "#111318", color: mode === "video" ? "#fff" : "rgba(255,255,255,0.4)" }}>🎬 Videos</button>
          </div>

          {/* Model selector */}
          <button onClick={() => mode === "image" ? setShowImageModelModal(true) : setShowVideoModelModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:border-[#7B61FF]/60"
            style={{ background: "#111318", border: "1px solid #2A2F3A", color: "rgba(255,255,255,0.8)" }}>
            {mode === "image" ? <span>{imgModel.icon}</span> : <span>✦</span>}
            <span>{mode === "image" ? imgModel.label : vidModel.label}</span>
            <svg className="w-3 h-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>

          {/* Image controls */}
          {mode === "image" && (
            <>
              <div className="flex items-center gap-1">
                {IMAGE_ASPECT_RATIOS.map((ar) => (
                  <button key={ar} onClick={() => setImageAspect(ar)} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                    style={{ background: imageAspect === ar ? "rgba(123,97,255,0.2)" : "#111318", border: imageAspect === ar ? "1px solid rgba(123,97,255,0.5)" : "1px solid #2A2F3A", color: imageAspect === ar ? "#A78BFA" : "rgba(255,255,255,0.5)" }}>
                    <span style={{ fontSize: 8 }}>{ASPECT_ICONS[ar]}</span><span>{ar}</span>
                  </button>
                ))}
              </div>
              {imgModel.supportsQuality && (
                <div className="flex items-center gap-1">
                  {(["standard", "hd"] as const).map((q) => (
                    <button key={q} onClick={() => setImageQuality(q)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                      style={{ background: imageQuality === q ? "rgba(59,231,255,0.15)" : "#111318", border: imageQuality === q ? "1px solid rgba(59,231,255,0.4)" : "1px solid #2A2F3A", color: imageQuality === q ? "#3BE7FF" : "rgba(255,255,255,0.5)" }}>
                      {q === "hd" ? "HD" : "Standard"}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1 ml-auto">
                <span className="text-white/30 text-[11px]">Images:</span>
                {[1, 2, 4].map((n) => (
                  <button key={n} onClick={() => setImageCount(n)} className="w-7 h-7 rounded-lg text-[11px] font-medium transition-all"
                    style={{ background: imageCount === n ? "rgba(123,97,255,0.2)" : "#111318", border: imageCount === n ? "1px solid rgba(123,97,255,0.5)" : "1px solid #2A2F3A", color: imageCount === n ? "#A78BFA" : "rgba(255,255,255,0.5)" }}>{n}</button>
                ))}
              </div>
            </>
          )}

          {/* Video controls */}
          {mode === "video" && (
            <>
              <div className="flex items-center gap-1">
                {VIDEO_DURATION_OPTIONS.filter((d) => vidModel.durations.includes(d)).map((d) => (
                  <button key={d} onClick={() => setVideoDuration(d)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                    style={{ background: videoDuration === d ? "#7B61FF" : "#111318", border: videoDuration === d ? "none" : "1px solid #2A2F3A", color: videoDuration === d ? "#fff" : "rgba(255,255,255,0.5)" }}>{d}s</button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                {VIDEO_ASPECT_OPTIONS.map((ar) => (
                  <button key={ar} onClick={() => setVideoAspect(ar)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                    style={{ background: videoAspect === ar ? "rgba(123,97,255,0.2)" : "#111318", border: videoAspect === ar ? "1px solid rgba(123,97,255,0.5)" : "1px solid #2A2F3A", color: videoAspect === ar ? "#A78BFA" : "rgba(255,255,255,0.5)" }}>{ar}</button>
                ))}
              </div>
              {vidModel.hasAudio && (
                <button onClick={() => setWithAudio((v) => !v)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all"
                  style={{ background: withAudio ? "rgba(52,211,153,0.1)" : "#111318", border: withAudio ? "1px solid rgba(52,211,153,0.3)" : "1px solid #2A2F3A", color: withAudio ? "#34d399" : "rgba(255,255,255,0.5)" }}>
                  🎵 {withAudio ? "Audio ON" : "Audio OFF"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Model Modals ─────────────────────────────────────────────────────── */}
      {showImageModelModal && <ImageModelModal models={IMAGE_MODELS} selectedId={selectedImageModel} userPlan={userPlan} onSelect={(id) => { setSelectedImageModel(id); const slug = Object.entries(SLUG_TO_IMAGE).find(([, v]) => v === id)?.[0] ?? id; router.replace(`/image?model=${slug}`, { scroll: false }); }} onClose={() => setShowImageModelModal(false)} />}
      {showVideoModelModal && <VideoModelModal models={VIDEO_MODELS.filter((m) => !m.comingSoon)} selectedId={selectedVideoModel} userPlan={userPlan} duration={videoDuration} withAudio={withAudio} onSelect={(id) => { setSelectedVideoModel(id); const slug = Object.entries(SLUG_TO_VIDEO).find(([, v]) => v === id)?.[0] ?? id; router.replace(`/video?model=${slug}`, { scroll: false }); }} onClose={() => setShowVideoModelModal(false)} />}

      {/* ── Delete Confirm ───────────────────────────────────────────────────── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div className="rounded-2xl p-6 w-80 mx-4" style={{ background: "#1A1D24", border: "1px solid #2A2F3A" }}>
            <h3 className="text-white font-semibold text-base mb-2">Delete Item</h3>
            <p className="text-white/60 text-sm mb-6">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirm(null)} className="flex-1 py-2 rounded-xl text-sm font-medium" style={{ border: "1px solid #2A2F3A", color: "rgba(255,255,255,0.6)" }}>Cancel</button>
              <button onClick={() => { handleDeleteHistory(deleteConfirm); setDeleteConfirm(null); }} className="flex-1 py-2 rounded-xl text-sm font-medium text-white" style={{ background: "#EF4444" }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── GenerationViewer (overlay during and after generation) ──────────────── */}
      <GenerationViewer
        isOpen={viewerOpen}
        status={viewerStatus}
        url={viewerUrl || undefined}
        type={mode}
        modelName={mode === "image" ? imgModel.label : vidModel.label}
        prompt={pendingItem?.prompt ?? prompt}
        credits={pendingItem?.credits ?? credits}
        onClose={handleViewerClose}
      />

      {/* ── GenerationDetailModal (klik na gallery item) ──────────────────────── */}
      <GenerationDetailModal
        item={detailItem}
        isOpen={!!detailItem}
        onClose={() => setDetailItem(null)}
        onDelete={handleDeleteHistory}
        onPublish={handlePublish}
      />
    </div>
  );
}

export function StudioPage({ defaultMode }: { defaultMode: Mode }) {
  return (
    <Suspense fallback={<div className="fixed inset-0 bg-[#050505]" />}>
      <StudioInner defaultMode={defaultMode} />
    </Suspense>
  );
}
