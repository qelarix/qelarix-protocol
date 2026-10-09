"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { RefreshCw, Download, Check, AlertCircle, ChevronRight, Upload, Video, X, Lock, Play, Pause, Type, Trash2 } from "lucide-react"
import { meetsPlan, type PlanId } from "@/lib/plans"
import "./lip-sync-premium.css"

// ──────────────────────────────────────────────────────────────────────────────
// REAL model config + flow — preserved VERBATIM. The UI is the UI Lab creat_video
// shell (.qx-* classes). Rail order matches the reference: tabs → hero → face →
// audio → model (side picker) → sync intensity → generate. Backend, payload,
// model IDs, credits, plan gating, signed upload, TTS and status polling unchanged.
// ──────────────────────────────────────────────────────────────────────────────

// Create Video / Create Image routes — sourced from the global nav (NavLinks.tsx): Create Video -> /video,
// Create Image -> /image (both pages exist). Used by the face-input "generate it" link.
const CREATE_VIDEO_ROUTE = "/video"
const CREATE_IMAGE_ROUTE = "/image"

interface LipSyncModel {
  id: string
  label: string
  description: string
  credits: number
  minPlan: string
  badge?: string
  chips: string[]
  previewColor: string
  estimatedSeconds: number
  inputType: "image" | "video" | "both"
  maxSeconds?: number
}

// Row copy: short purpose `description` + small technical `chips`. The picker GROUP header already
// states Image/Video to Video, so chips never repeat the group label. Old models carry only verified
// chips (Audio / Avatar) — no invented resolution/duration; new models carry their verified specs.
const LIP_SYNC_MODELS: LipSyncModel[] = [
  { id: "latentsync", label: "LatentSync", description: "Fast reliable sync for face videos.", credits: 20, minPlan: "starter", badge: "Recommended", chips: ["Audio"], previewColor: "linear-gradient(135deg, #1e3a5f 0%, #2d6a9f 100%)", estimatedSeconds: 35, inputType: "video" },
  { id: "wav2lip-hd", label: "Wav2Lip HD", description: "Classic HD lip sync for face input.", credits: 25, minPlan: "starter", chips: ["Audio"], previewColor: "linear-gradient(135deg, #1a2a4a 0%, #3b1e6b 100%)", estimatedSeconds: 50, inputType: "both" },
  { id: "musetalk", label: "MuseTalk", description: "Natural mouth movement for quick sync.", credits: 30, minPlan: "starter", badge: "Fastest", chips: ["Audio"], previewColor: "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)", estimatedSeconds: 25, inputType: "video" },
  { id: "ditto", label: "Ditto", description: "Natural talking-head animation with expression.", credits: 30, minPlan: "pro", badge: "PRO", chips: ["Avatar", "Audio"], previewColor: "linear-gradient(135deg, #1a1a4e 0%, #2d1b69 100%)", estimatedSeconds: 65, inputType: "image" },
  { id: "hedra", label: "Hedra", description: "Expressive character performance from image + audio.", credits: 35, minPlan: "pro", badge: "PRO", chips: ["Avatar", "Audio"], previewColor: "linear-gradient(135deg, #2d1b00 0%, #78350f 100%)", estimatedSeconds: 90, inputType: "image" },
  { id: "infinite-talk", label: "Infinite Talk", description: "Realistic long-form talking avatar.", credits: 30, minPlan: "pro", badge: "PREMIUM", chips: ["Avatar", "Audio"], previewColor: "linear-gradient(135deg, #1a0500 0%, #92400e 50%, #b45309 100%)", estimatedSeconds: 60, inputType: "image" },
  { id: "ltx-lipsync", label: "LTX Lip Sync", description: "Lightweight fast sync for video workflows.", credits: 25, minPlan: "starter", chips: ["Audio"], previewColor: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)", estimatedSeconds: 50, inputType: "video" },
  { id: "video-retalking", label: "Video ReTalking", description: "Speech restoration and lip correction.", credits: 25, minPlan: "starter", chips: ["Audio"], previewColor: "linear-gradient(135deg, #0a1628 0%, #1e3a8a 100%)", estimatedSeconds: 50, inputType: "video" },
  { id: "sadtalker", label: "SadTalker", description: "Classic portrait animation for simple talking-heads.", credits: 20, minPlan: "starter", chips: ["Avatar", "Audio"], previewColor: "linear-gradient(135deg, #1a3a2a 0%, #065f46 100%)", estimatedSeconds: 35, inputType: "image" },
  // ── Phase 1 expansion (fal.ai; verified payload keys; per-second pricing → duration caps). ──
  { id: "kling-lipsync", label: "Kling Lipsync", description: "Fast expressive sync for existing clips.", credits: 12, minPlan: "starter", badge: "NEW", chips: ["1080p", "Audio", "10s"], previewColor: "linear-gradient(135deg, #14331f 0%, #1f6b3f 100%)", estimatedSeconds: 45, inputType: "video", maxSeconds: 10 },
  { id: "kling-avatar-v2-standard", label: "Kling Avatar v2 Standard", description: "Create a talking avatar from image + audio.", credits: 30, minPlan: "pro", badge: "NEW", chips: ["1080p", "Audio", "8s"], previewColor: "linear-gradient(135deg, #1a2e4e 0%, #2d4b8f 100%)", estimatedSeconds: 60, inputType: "image", maxSeconds: 8 },
  { id: "kling-avatar-v2-pro", label: "Kling Avatar v2 Pro", description: "Premium talking avatar with stronger motion realism.", credits: 50, minPlan: "pro", badge: "PREMIUM", chips: ["1080p", "Audio", "8s"], previewColor: "linear-gradient(135deg, #2a1a4e 0%, #5b2da0 100%)", estimatedSeconds: 70, inputType: "image", maxSeconds: 8 },
  { id: "sync-lipsync-2-pro", label: "Sync Lipsync 2 Pro", description: "Professional sync for existing video footage.", credits: 40, minPlan: "pro", badge: "PREMIUM", chips: ["4K", "Audio", "8s", "Pro sync"], previewColor: "linear-gradient(135deg, #3a1a2e 0%, #8f2d5b 100%)", estimatedSeconds: 60, inputType: "video", maxSeconds: 8 },
]

// Visible picker groups (exactly 3). Featured = curated shortcuts; the full list lives in the type
// groups, so a model may appear in Featured AND in its Image/Video group.
const PICKER_GROUPS: { title: string; ids: string[] }[] = [
  { title: "Featured", ids: ["latentsync", "kling-avatar-v2-pro", "sync-lipsync-2-pro"] },
  { title: "Image to Video", ids: ["kling-avatar-v2-standard", "kling-avatar-v2-pro", "hedra", "ditto", "infinite-talk", "sadtalker"] },
  { title: "Video to Video", ids: ["kling-lipsync", "sync-lipsync-2-pro", "latentsync", "musetalk", "ltx-lipsync", "video-retalking", "wav2lip-hd"] },
]

// Reads media duration from file metadata (no dependency). Resolves 0 if unknown (fail-open).
function getMediaDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file)
      const el = document.createElement(file.type.startsWith("video/") ? "video" : "audio")
      el.preload = "metadata"
      const done = (d: number) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0) }
      el.onloadedmetadata = () => done(el.duration)
      el.onerror = () => done(0)
      el.src = url
    } catch { resolve(0) }
  })
}

type Step = "input" | "uploading" | "generating" | "done"

interface StatusResponse {
  status: "pending" | "processing" | "completed" | "failed"
  progress: number
  estimated_seconds_remaining: number
  output_url: string | null
  error_message: string | null
}

// Session-local history of finished generations (this page session only — no DB, no schema).
interface HistoryItem {
  id: string
  output_url: string
  type: "video" | "image"
  model: string
  modelLabel: string
  createdAt: number
  ttsText?: string
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Compact MODEL row that opens a flyout to the RIGHT of the rail — UI Lab `SidePicker`
// (`.qx-row` trigger + `.qx-flyout`). NOT a downward dropdown, NOT a card grid.
function ModelSidePicker({ models, value, onChange, disabled, isLocked }: {
  models: LipSyncModel[]; value: string; onChange: (id: string) => void; disabled: boolean; isLocked: (m: LipSyncModel) => boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; height: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = models.find((m) => m.id === value) ?? models[0]

  useEffect(() => {
    if (!open) return
    const measure = () => {
      const rail = rootRef.current?.closest(".qx-rail") as HTMLElement | null
      const r = (rail ?? rootRef.current)?.getBoundingClientRect()
      if (!r) return
      const vw = window.innerWidth, vh = window.innerHeight, gap = 12
      const W = Math.min(380, vw - 24)
      let left = r.right + gap, top = r.top, height = r.height
      if (left + W > vw - 12) { left = Math.max(12, (vw - W) / 2); top = Math.min(r.top, 64); height = Math.min(vh - top - 16, 620) }
      setPos({ left, top, height, width: W })
    }
    measure()
    const onResize = () => measure()
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("resize", onResize)
    document.addEventListener("keydown", onEsc)
    return () => { window.removeEventListener("resize", onResize); document.removeEventListener("keydown", onEsc) }
  }, [open])

  return (
    <div className="qx-row" ref={rootRef}>
      <button type="button" className="qx-row__btn" data-open={open} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { if (!disabled) setOpen((v) => !v) }}>
        <span className="qx-row__text">
          <span className="qx-row__label">Model</span>
          <span className="qx-row__val">{current.label} · {current.credits} QLC</span>
        </span>
        <ChevronRight size={17} className="qx-row__chev" />
      </button>
      {open && pos && (
        <>
          <div className="qx-flyout__backdrop" onClick={() => setOpen(false)} />
          <div className="qx-flyout" role="listbox" style={{ position: "fixed", left: pos.left, top: pos.top, height: pos.height, width: pos.width }}>
            <div className="qx-flyout__scroll">
              {PICKER_GROUPS.map((g) => (
                <div key={g.title}>
                  <div className="qx-flyout__head"><Video size={14} /> {g.title}</div>
                  {g.ids.map((id) => {
                    const m = models.find((x) => x.id === id)
                    if (!m) return null
                    return (
                      <button key={`${g.title}:${id}`} role="option" aria-selected={m.id === value} className="qx-mopt" data-active={m.id === value} data-locked={isLocked(m) || undefined}
                        onClick={() => { onChange(m.id); setOpen(false) }}>
                        <span className="qx-mopt__icon" style={{ background: m.previewColor }}><Video size={16} /></span>
                        <span className="qx-mopt__text">
                          <span className="qx-mopt__name">{m.label}{m.badge && <span className="qx-badge">{m.badge}</span>}</span>
                          <span className="qx-mopt__specs">{m.description}</span>
                          <span className="ls-chips">{m.chips.map((c) => <span key={c} className="ls-chip">{c}</span>)}</span>
                        </span>
                        {m.id === value ? <Check size={18} className="qx-mopt__check" /> : isLocked(m) ? <Lock size={15} className="ls-lock" /> : null}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Clean Cinema-style video player — no native browser frame/controls. Custom play + progress + time.
function CleanVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const toggle = () => { const v = ref.current; if (!v) return; if (v.paused) v.play(); else v.pause() }
  const fmt = (s: number) => { if (!isFinite(s) || s < 0) return "0:00"; const m = Math.floor(s / 60); const ss = Math.floor(s % 60); return `${m}:${ss.toString().padStart(2, "0")}` }
  return (
    <div className="ls-player">
      <video ref={ref} src={src} className="ls-player__vid" playsInline autoPlay onClick={toggle}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <div className="ls-player__bar">
        <button type="button" className="ls-player__btn" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <div className="ls-player__track" onClick={(e) => { const v = ref.current; if (!v || !dur) return; const r = e.currentTarget.getBoundingClientRect(); v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur }}>
          <i style={{ width: `${dur ? (t / dur) * 100 : 0}%` }} />
        </div>
        <span className="ls-player__time">{fmt(t)} / {fmt(dur)}</span>
      </div>
    </div>
  )
}

export default function LipSyncPage() {
  const [tab, setTab] = useState<"lipsync" | "ugc">("lipsync")
  const [selectedModel, setSelectedModel] = useState<string>("latentsync")
  const [faceFile, setFaceFile] = useState<File | null>(null)
  const [facePreview, setFacePreview] = useState<string | null>(null)
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [ttsText, setTtsText] = useState("")
  const [audioMode, setAudioMode] = useState<"upload" | "tts">("upload")
  const [intensity, setIntensity] = useState(75)
  const [step, setStep] = useState<Step>("input")
  const [uploadStatus, setUploadStatus] = useState("")
  const [progress, setProgress] = useState(0)
  const [estimatedRemaining, setEstimatedRemaining] = useState(0)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [error, setError] = useState("")
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_jobId, setJobId] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [previewItem, setPreviewItem] = useState<HistoryItem | null>(null)
  const [resultLoadFailed, setResultLoadFailed] = useState(false)
  // Inline delete confirmation (small popover inside the preview modal — not a fullscreen dialog).
  const [delConfirm, setDelConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [delError, setDelError] = useState("")

  const faceInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeJobRef = useRef<string | null>(null)
  const facePreviewRef = useRef<string | null>(null)
  const pendingGenRef = useRef<{ model: string; modelLabel: string; ttsText: string } | null>(null)

  const model = LIP_SYNC_MODELS.find((m) => m.id === selectedModel)!

  const router = useRouter()
  const { data: session } = useAuthSession()
  const userPlan = (session?.user?.plan ?? "free") as PlanId
  const isAdmin = session?.user?.isInternal === true
  // UX-only plan lock. Backend minPlan gating in /api/generate/lip-sync stays the source of truth.
  const isLocked = (m: LipSyncModel) => !isAdmin && !meetsPlan(userPlan, m.minPlan as PlanId)

  useEffect(() => { facePreviewRef.current = facePreview }, [facePreview])

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearTimeout(pollingRef.current)
      if (facePreviewRef.current) URL.revokeObjectURL(facePreviewRef.current)
    }
  }, [])

  // Persistent history — reload the user's completed Lip Sync generations on mount (survives refresh).
  // Reuses /api/generations (auth'd, user-scoped, completed only); filtered client-side to Lip Sync models.
  useEffect(() => {
    let cancelled = false
    const ids = new Set(LIP_SYNC_MODELS.map((m) => m.id))
    ;(async () => {
      try {
        const res = await fetch("/api/generations?type=video&limit=80")
        if (!res.ok) return
        const data = (await res.json()) as { generations?: Array<{ id: string; model: string; type: string; output_url: string | null; created_at: string }> }
        const items: HistoryItem[] = (data.generations ?? [])
          .filter((r) => ids.has(r.model) && !!r.output_url)
          .map((r) => ({
            id: r.id, output_url: r.output_url as string,
            type: (r.type === "image" ? "image" : "video") as "video" | "image",
            model: r.model, modelLabel: LIP_SYNC_MODELS.find((m) => m.id === r.model)?.label ?? r.model,
            createdAt: new Date(r.created_at).getTime(),
          }))
        if (cancelled) return
        setHistory((h) => {
          const seen = new Set(items.map((i) => i.output_url))
          const sessionOnly = h.filter((i) => !seen.has(i.output_url))
          return [...sessionOnly, ...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40)
        })
      } catch { /* history is best-effort */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Reset the inline delete confirmation whenever the previewed item changes or the modal closes.
  useEffect(() => { setDelConfirm(false); setDelError("") }, [previewItem])

  function handleFaceChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFaceFile(file)
    // Local object URL drives the left preview for BOTH images and videos (revoked on replace/clear/unmount).
    setFacePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file) })
  }

  function handleAudioChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) setAudioFile(file)
  }

  // Qelarix standard signed direct-to-storage upload — never through a Next route (no Vercel body cap).
  async function uploadFile(file: File): Promise<string> {
    const signRes = await fetch("/api/upload/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
    })
    const sign = (await signRes.json().catch(() => ({}))) as { signedUrl?: string; publicUrl?: string; error?: string }
    if (!signRes.ok || !sign.signedUrl || !sign.publicUrl) throw new Error(sign.error ?? "Upload failed")
    const putRes = await fetch(sign.signedUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type, "x-upsert": "false" },
      body: file,
    })
    if (!putRes.ok) throw new Error("Upload failed")
    return sign.publicUrl
  }

  const pollStatus = useCallback(async (id: string) => {
    if (activeJobRef.current !== id) return
    try {
      const res = await fetch(`/api/generate/lip-sync/status/${id}`)
      const data = (await res.json()) as StatusResponse
      if (activeJobRef.current !== id) return
      setProgress(data.progress)
      setEstimatedRemaining(data.estimated_seconds_remaining)
      if (data.status === "completed" && data.output_url) {
        const out = data.output_url
        setOutputUrl(out); setStep("done"); activeJobRef.current = null
        const ctx = pendingGenRef.current; pendingGenRef.current = null
        // Prepend to session history (newest top-left); cap to avoid unbounded growth.
        setHistory((h) => [{ id: `${out}#${id}`, output_url: out, type: "video" as const, model: ctx?.model ?? "", modelLabel: ctx?.modelLabel ?? "Lip sync", createdAt: Date.now(), ttsText: ctx?.ttsText || undefined }, ...h.filter((x) => x.output_url !== out)].slice(0, 40))
        return
      }
      if (data.status === "failed") {
        setError(data.error_message ?? "Generation failed"); setStep("input"); activeJobRef.current = null; return
      }
      pollingRef.current = setTimeout(() => pollStatus(id), 3000)
    } catch {
      if (activeJobRef.current === id) pollingRef.current = setTimeout(() => pollStatus(id), 5000)
    }
  }, [])

  async function generate() {
    if (isLocked(model)) { setError(`${model.label} requires the ${cap(model.minPlan)} plan. Please upgrade to use it.`); return }
    if (!faceFile) { setError("Choose a face image or video"); return }
    if (audioMode === "upload" && !audioFile) { setError("Choose an audio file"); return }
    if (audioMode === "tts" && !ttsText.trim()) { setError("Enter text for TTS"); return }

    // Block clearly-wrong input type for the selected model — no paid job, no deduction.
    if (model.inputType === "image" && faceFile.type.startsWith("video/")) { setError("This model needs a face image, not a video."); return }
    if (model.inputType === "video" && faceFile.type.startsWith("image/")) { setError("This model needs a face video, not an image."); return }

    // Duration cap for per-second premium models — checked from uploaded media metadata BEFORE any upload/submit.
    if (model.maxSeconds) {
      const capS = model.maxSeconds
      if (faceFile.type.startsWith("video/")) {
        const dv = await getMediaDuration(faceFile)
        if (dv > capS + 0.5) { setError(`This model supports up to ${capS} seconds. Please upload a shorter video.`); return }
      }
      if (audioMode === "upload" && audioFile) {
        const da = await getMediaDuration(audioFile)
        if (da > capS + 0.5) { setError(`This model supports up to ${capS} seconds. Please upload a shorter audio/video file.`); return }
      }
    }

    if (pollingRef.current) clearTimeout(pollingRef.current)
    activeJobRef.current = null
    setError(""); setOutputUrl(null); setProgress(0); setResultLoadFailed(false); setStep("uploading")

    let faceUrl: string
    let audioUrl: string
    try {
      setUploadStatus("Uploading face image / video…")
      faceUrl = await uploadFile(faceFile)
      if (audioMode === "upload") {
        setUploadStatus("Uploading audio…")
        audioUrl = await uploadFile(audioFile!)
      } else {
        setUploadStatus("Generating TTS audio…")
        const ttsRes = await fetch("/api/generate/lip-sync/tts", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: ttsText }),
        })
        const ttsData = (await ttsRes.json()) as { audio_url?: string; error?: string }
        if (!ttsRes.ok || !ttsData.audio_url) throw new Error(ttsData.error ?? "TTS generation failed")
        audioUrl = ttsData.audio_url
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : ""
      setError(/load failed|failed to fetch|network/i.test(m)
        ? "Upload failed — the file may be too large or the connection dropped. Try a shorter, smaller clip."
        : (m || "Upload failed"))
      setStep("input"); return
    }

    setStep("generating"); setUploadStatus(""); setProgress(2)
    try {
      const res = await fetch("/api/generate/lip-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, face_url: faceUrl, audio_url: audioUrl, intensity }),
      })
      const data = (await res.json()) as { jobId?: string; error?: string }
      if (!res.ok || !data.jobId) throw new Error(data.error ?? "Could not start the generation")
      pendingGenRef.current = { model: selectedModel, modelLabel: model.label, ttsText: audioMode === "tts" ? ttsText.trim() : "" }
      setJobId(data.jobId); activeJobRef.current = data.jobId; pollStatus(data.jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation error"); setStep("input")
    }
  }

  function reset() {
    if (pollingRef.current) clearTimeout(pollingRef.current)
    activeJobRef.current = null
    setStep("input"); setOutputUrl(null); setError(""); setProgress(0); setResultLoadFailed(false); setJobId(null)
  }

  // Reuse a finished output as the face input (fetch → blob → File so the normal upload flow applies).
  // The backend still receives a public upload URL; the local object URL is preview-only.
  async function reuseAsFace(item: HistoryItem) {
    try {
      const blob = await fetch(item.output_url).then((r) => r.blob())
      const ext = item.type === "image" ? "png" : "mp4"
      const file = new File([blob], `history-${item.type}.${ext}`, { type: blob.type || (item.type === "image" ? "image/png" : "video/mp4") })
      setFaceFile(file)
      setFacePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file) })
      setPreviewItem(null)
    } catch {
      setError("Could not reuse this file — download it and upload manually.")
      setPreviewItem(null)
    }
  }

  // Delete the previewed generation: authenticated, app-scoped server delete (own + Lip Sync only),
  // then drop it from local history by output_url (works for both API-loaded and in-session items).
  // Does not touch generation flow, credits, or the example preview.
  async function confirmDelete() {
    const item = previewItem
    if (!item || deleting) return
    setDeleting(true); setDelError("")
    try {
      const res = await fetch("/api/apps/lip-sync/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputUrl: item.output_url }),
      })
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string }
      if (!res.ok || !data.success) throw new Error(data.error ?? "Failed to delete")
      setHistory((h) => h.filter((x) => x.output_url !== item.output_url))
      setDelConfirm(false); setPreviewItem(null)
    } catch (err) {
      setDelError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  const busy = step === "uploading" || step === "generating"
  const showPreview = !outputUrl && !busy && !error
  // State A = no history → the large Example fills the right canvas. State B = history exists → the right
  // canvas is reserved for history/results and a compact Example moves into the left rail under Generate.
  const hasHistory = history.length > 0
  const showLargeExample = showPreview && !hasHistory
  function onGenerateClick() { if (busy) return; generate() }

  const faceHint = model.inputType === "image" ? "JPG · PNG · WebP" : model.inputType === "video" ? "MP4 · MOV · WebM" : "JPG · PNG · MP4 · MOV"
  const faceAccept = model.inputType === "image" ? "image/*" : model.inputType === "video" ? "video/*" : "image/*,video/*"
  const faceLabel = model.inputType === "image" ? "Face image" : model.inputType === "video" ? "Face video" : "Face image or video"
  // Upload-box copy + "generate it" target follow the selected model's input type (Create Image vs Create Video).
  const faceUploadLead = model.inputType === "image" ? "Upload image or" : model.inputType === "video" ? "Upload video or" : "Upload image or video or"
  const generateRoute = model.inputType === "image" ? CREATE_IMAGE_ROUTE : CREATE_VIDEO_ROUTE
  const loadingStatus = step === "uploading" ? (uploadStatus || "Uploading…") : progress < 5 ? "Starting generation…" : progress < 50 ? "Analyzing face…" : "Syncing lips…"

  return (
    <div className="qx-app">
      <main className="qx-workspace">
        {/* ── LEFT RAIL ── */}
        <aside className="qx-rail">
          {/* Top tabs (reference style) */}
          <div className="qx-modetabs">
            <button type="button" className="qx-modetab" data-active={tab === "lipsync"} onClick={() => setTab("lipsync")}>Lip Sync Studio</button>
            <button type="button" className="qx-modetab" data-active={tab === "ugc"} onClick={() => setTab("ugc")}>UGC Factory</button>
          </div>

          {tab === "lipsync" ? (
            <>
              <div className="qx-rail__body">
                <div className="qx-mode">
                  {/* Hero / model preview card */}
                  <div className="qx-hero">
                    <span className="qx-hero__media" style={{ background: model.previewColor }} />
                    <span className="qx-hero__grain" />
                    <span className="qx-hero__scrim" />
                    <h2 className="qx-hero__title">{model.label}</h2>
                    <p className="qx-hero__sub">Lip Sync · {model.credits} QLC</p>
                  </div>

                  {/* FACE VIDEO */}
                  <div className="qx-field">
                    <div className="qx-field__label"><span>{faceLabel}</span><span className="qx-field__hint">{faceHint}</span></div>
                    <input ref={faceInputRef} type="file" accept={faceAccept} onChange={handleFaceChange} className="ls-hidden" disabled={busy} />
                    {faceFile ? (
                      <div className="qx-media">
                        {faceFile.type.startsWith("video/") ? (
                          <video className="ls-vid" src={facePreview ?? undefined} autoPlay muted loop playsInline preload="metadata" />
                        ) : (
                          <span className="qx-media__poster" style={facePreview ? { backgroundImage: `url(${facePreview})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: model.previewColor }} />
                        )}
                        <span className="qx-vframe__grain" />
                        <div className="qx-media__bar">
                          <span className="qx-media__name"><Video size={13} />{faceFile.name}</span>
                          <button className="qx-media__remove" aria-label="Remove"
                            onClick={() => { if (!busy) { setFaceFile(null); setFacePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null }) } }}><X size={14} /></button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="qx-upload" onClick={() => { if (!busy) faceInputRef.current?.click() }}>
                        <span className="qx-upload__icon"><Upload size={20} /></span>
                        <div>
                          <div className="qx-upload__title">
                            {faceUploadLead}{" "}
                            <span
                              className="ls-genlink"
                              role="link"
                              tabIndex={0}
                              onClick={(e) => { e.stopPropagation(); router.push(generateRoute) }}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); router.push(generateRoute) } }}
                            >generate it</span>
                          </div>
                          <div className="qx-upload__sub">{faceHint}</div>
                        </div>
                      </button>
                    )}
                  </div>

                  {/* AUDIO */}
                  <div className="qx-field">
                    <div className="qx-field__label"><span>Audio</span></div>
                    <div className="qx-seg" role="tablist">
                      {(["upload", "tts"] as const).map((mode) => (
                        <button key={mode} role="tab" aria-selected={audioMode === mode} className="qx-seg__item" data-active={audioMode === mode}
                          onClick={() => { if (!busy) setAudioMode(mode) }}>
                          {mode === "upload" ? "Upload" : "Audio text"}
                        </button>
                      ))}
                    </div>
                    {audioMode === "upload" ? (
                      <>
                        <input ref={audioInputRef} type="file" accept="audio/*" onChange={handleAudioChange} className="ls-hidden" disabled={busy} />
                        <button type="button" className="qx-upload" style={{ minHeight: 84 }} onClick={() => { if (!busy) audioInputRef.current?.click() }}>
                          <span className="qx-upload__icon"><Upload size={18} /></span>
                          <div>
                            <div className="qx-upload__title">{audioFile ? audioFile.name : "Add audio"}</div>
                            <div className="qx-upload__sub">{audioFile ? "Tap to replace" : "MP3 · WAV · OGG · M4A"}</div>
                          </div>
                        </button>
                      </>
                    ) : (
                      <div className="qx-prompt">
                        <textarea value={ttsText} onChange={(e) => setTtsText(e.target.value)} maxLength={500} disabled={busy}
                          placeholder="Enter the text to be spoken… (max 500 characters)" />
                        <div className="qx-prompt__foot">
                          <div className="qx-prompt__chips" />
                          <span className="qx-prompt__count" data-warn={ttsText.length > 450 || undefined}>{ttsText.length} / 500</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* MODEL (compact row, opens to the right) */}
                  <ModelSidePicker models={LIP_SYNC_MODELS} value={selectedModel} onChange={setSelectedModel} disabled={busy} isLocked={isLocked} />

                  {/* SYNC INTENSITY */}
                  <div className="qx-slider">
                    <div className="qx-slider__row">
                      <span className="qx-sublabel">Sync intensity</span>
                      <span className="qx-slider__val">{intensity}%</span>
                    </div>
                    <input type="range" min={0} max={100} value={intensity} disabled={busy}
                      onChange={(e) => setIntensity(Number(e.target.value))}
                      style={{ "--_pct": `${intensity}%` } as React.CSSProperties} />
                  </div>
                </div>
              </div>

              {/* Generate (docked) */}
              <div className="qx-rail__dock">
                <button type="button" className="qx-generate" aria-disabled={busy} onClick={onGenerateClick}>
                  {busy ? (
                    <><RefreshCw size={18} className="qx-generate__spin" /> Generating…</>
                  ) : (
                    <>
                      Generate
                      <span className="qx-generate__cost">{model.credits} QLC</span>
                    </>
                  )}
                </button>
                {/* Compact Example — appears under Generate only once history exists (State B);
                    State A keeps the large Example in the right canvas. */}
                {hasHistory && (
                  <div className="ls-rail-example">
                    <video className="ls-vid" src="/apps/previews/lip-sync-preview.mp4" autoPlay muted loop playsInline preload="metadata" />
                    <span className="qx-vframe__badge"><Video size={12} /> Example</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            // UGC Factory — non-functional placeholder tab (no route, doesn't break the page).
            <div className="qx-rail__body">
              <div className="qx-empty" style={{ padding: "52px 20px" }}>
                <span className="qx-empty__orb"><Video size={28} /></span>
                <div className="qx-empty__title">UGC Factory</div>
                <p className="qx-empty__sub">Coming soon — automated UGC ad creation. Stay on Lip Sync Studio for now.</p>
              </div>
            </div>
          )}
        </aside>

        {/* ── RIGHT CANVAS (PreviewShell) ── */}
        <section className="qx-preview qx-stage">
          {/* History label — top line of the output area (muted, not a route). */}
          <div className="ls-stage-head"><span className="ls-history-label">History</span></div>

          {/* Finished generations — newest top-left, 5 per row, wraps with scroll. Not in the left rail. */}
          {history.length > 0 && (
            <div className="ls-history">
              {history.map((it) => (
                <button key={it.id} type="button" className="ls-hist" title={it.modelLabel} onClick={() => setPreviewItem(it)}>
                  {it.type === "video" ? (
                    // #t=0.1 forces the browser to paint the first frame as the card thumbnail (no autoplay).
                    <video src={`${it.output_url}#t=0.1`} muted playsInline preload="metadata" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.output_url} alt={it.modelLabel} />
                  )}
                  <span className="ls-hist__cap"><span className="ls-hist__name">{it.modelLabel}</span></span>
                  <span className="ls-hist__play"><Play size={12} /></span>
                </button>
              ))}
            </div>
          )}

          {/* Canvas = large Example (State A) OR live loading / result / error. With history present and
              idle, the right side is just the history grid above — we don't render an empty canvas. */}
          {(showLargeExample || busy || outputUrl || error) && (
          <div className="qx-canvas">
            <div className="qx-canvas__inner">
              {/* Default large Example — State A (no history) only. */}
              {showLargeExample && (
                <div className="qx-vframe">
                  <video className="ls-vid" src="/apps/previews/lip-sync-preview.mp4" autoPlay muted loop playsInline preload="auto" />
                  <span className="qx-vframe__badge"><Video size={13} /> Example</span>
                </div>
              )}

              {/* Loading (real status-driven) */}
              {busy && (
                <div className="qx-loading">
                  <div className="qx-skel">
                    <div className="qx-skel__center">
                      <span className="qx-ring" />
                      <div className="qx-loading__status">{loadingStatus}</div>
                      <div className="qx-loading__sub">
                        {step === "generating" ? (estimatedRemaining > 0 ? `~${estimatedRemaining}s remaining` : `${progress}%`) : "Preparing your inputs"}
                      </div>
                    </div>
                  </div>
                  <div className="qx-progress"><i style={{ width: `${step === "uploading" ? 30 : Math.max(progress, 5)}%` }} /></div>
                </div>
              )}

              {/* Result */}
              {outputUrl && !busy && (
                <div className="qx-result">
                  <div className="qx-vframe">
                    {resultLoadFailed ? (
                      <div className="ls-vid-fallback">Generated video could not be loaded. Please try downloading it or generate again.</div>
                    ) : (
                      <video className="ls-vid ls-vid--contain" src={outputUrl} controls autoPlay onError={() => setResultLoadFailed(true)} />
                    )}
                    <span className="qx-vframe__badge"><Video size={13} /> {model.label}</span>
                  </div>
                  <div className="qx-result__bar">
                    <div className="qx-result__meta">
                      <span className="qx-meta qx-meta--success"><Check size={13} /> Ready</span>
                      <span className="qx-meta">{model.credits} QLC</span>
                    </div>
                    <div className="qx-result__actions">
                      <a className="qx-btn qx-btn--accent" href={outputUrl} download="lipsync.mp4"><Download size={16} /> Download</a>
                      <button className="qx-btn qx-btn--ghost" onClick={reset}><RefreshCw size={16} /> New</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && !busy && !outputUrl && (
                <div className="qx-error">
                  <span className="qx-error__icon"><AlertCircle size={26} /></span>
                  <div className="qx-error__title">Generation didn’t finish</div>
                  <p className="qx-error__sub">{error}</p>
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    <button className="qx-btn qx-btn--accent" onClick={onGenerateClick}><RefreshCw size={16} /> Retry</button>
                    <button className="qx-btn qx-btn--ghost" onClick={reset}>Dismiss</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          )}
        </section>

        {/* History item — compact enlarged preview + reuse actions (never fakes unsupported actions). */}
        {previewItem && (
          <div className="ls-hbackdrop" onClick={() => setPreviewItem(null)}>
            <div className="ls-hmodal" onClick={(e) => e.stopPropagation()}>
              {previewItem.type === "video" ? (
                <CleanVideo src={previewItem.output_url} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewItem.output_url} alt={previewItem.modelLabel} className="ls-hmodal__img" />
              )}
              <div className="ls-hmodal__bar">
                <span className="ls-hmodal__title">{previewItem.modelLabel}</span>
                <div className="ls-hmodal__actions">
                  <a className="qx-btn qx-btn--accent" href={previewItem.output_url} download={`lipsync.${previewItem.type === "image" ? "png" : "mp4"}`}><Download size={15} /> Download</a>
                  {previewItem.type === "video" && model.inputType !== "image" && (
                    <button className="qx-btn qx-btn--ghost" onClick={() => reuseAsFace(previewItem)}><RefreshCw size={15} /> Reuse video</button>
                  )}
                  {previewItem.type === "image" && model.inputType !== "video" && (
                    <button className="qx-btn qx-btn--ghost" onClick={() => reuseAsFace(previewItem)}><RefreshCw size={15} /> Reuse image</button>
                  )}
                  {previewItem.ttsText && (
                    <button className="qx-btn qx-btn--ghost" onClick={() => { setTtsText(previewItem.ttsText!); setAudioMode("tts"); setPreviewItem(null) }}><Type size={15} /> Reuse text</button>
                  )}
                  <div className="ls-del">
                    <button type="button" className="qx-btn qx-btn--ghost ls-del__btn" onClick={() => setDelConfirm((v) => !v)}><Trash2 size={15} /> Delete</button>
                    {delConfirm && (
                      <div className="ls-confirm" onClick={(e) => e.stopPropagation()}>
                        <div className="ls-confirm__title">Delete this video?</div>
                        <div className="ls-confirm__sub">This cannot be undone.</div>
                        {delError && <div className="ls-confirm__err">{delError}</div>}
                        <div className="ls-confirm__row">
                          <button type="button" className="ls-confirm__cancel" onClick={() => setDelConfirm(false)} disabled={deleting}>Cancel</button>
                          <button type="button" className="ls-confirm__del" onClick={confirmDelete} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button className="qx-btn qx-btn--ghost" onClick={() => setPreviewItem(null)}><X size={15} /> Close</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
