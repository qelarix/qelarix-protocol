"use client"

// Video Tools v1 — Bytedance Video Upscale + PixVerse Video Extend (one shared upload tool, tool tabs).
// Pricing = MASTER Excel (locked 2026-06-12) via CREDITS.videoTools — shown live in the UI and charged
// server-side by /api/generate/video-tools (deduct-on-success). Veo 3.1 Extend and Upscale Pro mode are
// COMING SOON — Pro is shown disabled, Veo is not shown at all. UI pattern mirrors /apps/video-extend.
// Tool select: /apps/video-tools?tool=upscale | ?tool=extend (useSearchParams inside Suspense; the tool
// component is keyed by the query so switching tools from the menu remounts it).

import { useState, useRef, useCallback, useEffect, Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import { CREDITS } from "@/lib/credits"
import QelarixBackdrop from "@/components/ui/QelarixBackdrop"

type Tool = "upscale" | "extend"
type UpscaleResolution = "1080p" | "2k" | "4k"
type ExtendResolution = "720p" | "1080p"
type Fps = 30 | 60
type JobStatus = "idle" | "pending" | "processing" | "completed" | "failed"

const UPSCALE_PER_SEC: Record<UpscaleResolution, number> = {
  "1080p": CREDITS.videoTools.video_upscale_1080p,
  "2k": CREDITS.videoTools.video_upscale_2k,
  "4k": CREDITS.videoTools.video_upscale_4k,
}
const EXTEND_FLAT: Record<ExtendResolution, number> = {
  "720p": CREDITS.videoTools.video_extend_pixverse_720p,
  "1080p": CREDITS.videoTools.video_extend_pixverse_1080p,
}
// Cross-origin files ignore the <a download> attribute, so the browser just opens the video. Supabase
// Storage serves a public object as an attachment when ?download=<name> is added (same pattern as the
// Studio export). Other hosts open in a new tab so the page and its result are never lost.
function downloadHref(url: string, fileName: string): string {
  if (!url.includes("/storage/v1/object/public/")) return url
  return `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(fileName)}`
}

const UPSCALE_RES_LABEL: Record<UpscaleResolution, string> = { "1080p": "1080p", "2k": "2K", "4k": "4K" }

// Each tool is its own page in the menu (?tool=upscale | ?tool=extend) with its own live backdrop and
// one solid accent colour. Graphite and white base; green for Upscale, yellow for Extend.
const TOOL_UI: Record<Tool, { tone: "mint" | "citrus"; accent: string; accentText: string; glow: string; title: string; desc: string }> = {
  upscale: { tone: "mint", accent: "#4ADE80", accentText: "#04140A", glow: "rgba(74,222,128,0.45)", title: "Video Upscale", desc: "Sharpen an existing video to 1080p, 2K or 4K." },
  extend: { tone: "citrus", accent: "#FACC15", accentText: "#1A1503", glow: "rgba(250,204,21,0.45)", title: "Video Extend", desc: "Continue an existing video by 5 seconds with PixVerse." },
}

// The tool comes from ?tool=. Upscale and Extend share this route, so a menu click from one to the other
// only changes the query string and Next.js keeps the page mounted. Keying the tool component by ?tool=
// remounts it with a clean state on every switch.
export default function VideoToolsRoute() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <VideoToolsByQuery />
    </Suspense>
  )
}

function VideoToolsByQuery() {
  const tool: Tool = useSearchParams().get("tool") === "extend" ? "extend" : "upscale"
  return <VideoToolsPage key={tool} tool={tool} />
}

function VideoToolsPage({ tool }: { tool: Tool }) {
  const [videoUrl, setVideoUrl] = useState("")
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  // Source dimensions (from the preview's metadata) — drives the Bytedance 1080p-upscale input rule.
  const [videoDims, setVideoDims] = useState<{ width: number; height: number } | null>(null)
  // upscale controls
  const [resolution, setResolution] = useState<UpscaleResolution>("1080p")
  const [fps, setFps] = useState<Fps>(30)
  // extend controls
  const [extendResolution, setExtendResolution] = useState<ExtendResolution>("720p")
  const [prompt, setPrompt] = useState("")
  // job state
  const [status, setStatus] = useState<JobStatus>("idle")
  const [progress, setProgress] = useState(0)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Source upload: starts IMMEDIATELY on file select/drop (signed direct-to-storage). Generate only
  // ever uses the stored public URL — the file body never goes through a Next API route.
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null)
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "ready" | "failed">("idle")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Signed direct-to-storage upload: tiny JSON request → signed URL → PUT the file straight to
  // Supabase Storage (supabase.co — Vercel never sees the body, so no FUNCTION_PAYLOAD_TOO_LARGE).
  // Runs EAGERLY on file select; the resulting public URL is stored for Generate.
  const startUpload = useCallback(async (file: File): Promise<string | null> => {
    setUploadState("uploading")
    try {
      const signRes = await fetch("/api/upload/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
      })
      const sign = await signRes.json().catch(() => ({}))
      if (!signRes.ok || !sign?.signedUrl || !sign?.publicUrl) throw new Error(sign?.error || "Upload failed")

      // HARD GUARD: the file body must ONLY ever go to Supabase storage — never to our own origin
      // (a same-origin PUT would pass through Vercel and hit FUNCTION_PAYLOAD_TOO_LARGE). If the signed
      // URL is relative or same-origin (e.g. misconfigured NEXT_PUBLIC_SUPABASE_URL), fail fast instead.
      let signedTarget: URL
      try {
        signedTarget = new URL(sign.signedUrl as string)
      } catch {
        throw new Error("Upload misconfigured: signed URL is not absolute (check NEXT_PUBLIC_SUPABASE_URL).")
      }
      if (signedTarget.host === window.location.host) {
        throw new Error("Upload misconfigured: signed URL points at the app origin (check NEXT_PUBLIC_SUPABASE_URL).")
      }

      const putRes = await fetch(sign.signedUrl as string, {
        method: "PUT",
        headers: { "Content-Type": file.type, "x-upsert": "false" },
        body: file,
      })
      if (!putRes.ok) throw new Error("Storage upload failed. Please try again.")

      setUploadedUrl(sign.publicUrl as string)
      setUploadState("ready")
      return sign.publicUrl as string
    } catch (e) {
      setUploadState("failed")
      setError(e instanceof Error && e.message !== "Upload failed" ? e.message : "Video upload failed. Please try again.")
      return null
    }
  }, [])

  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.startsWith("video/")) {
      setError("Please select a video file.")
      return
    }
    setUploadFile(file)
    setPreviewUrl(URL.createObjectURL(file))
    setVideoUrl("")
    setVideoDuration(null); setVideoDims(null)
    setUploadedUrl(null)
    setError(null)
    // Upload immediately — Generate later only consumes the stored public URL.
    void startUpload(file)
  }, [startUpload])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file) handleFileSelect(file)
    },
    [handleFileSelect],
  )

  // Poll until completed / failed / timeout — never leave the UI permanently "stuck".
  const POLL_INTERVAL_MS = 4000
  const POLL_TIMEOUT_MS = 10 * 60 * 1000 // 10 min — long upscales keep running server-side; History shows the result
  const pollStatus = useCallback((id: string) => {
    const startedAt = Date.now()
    let consecutiveErrors = 0
    pollRef.current = setInterval(async () => {
      // Timeout: stop polling with a clear message (the job itself keeps running server-side).
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(pollRef.current!)
        setStatus("idle")
        setError("Generation is still processing. Please check History later.")
        return
      }
      try {
        const res = await fetch(`/api/generate/video-tools/status/${id}`)
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || typeof data.status !== "string") {
          // Status route error — surface the real text after a few consecutive failures.
          consecutiveErrors += 1
          if (consecutiveErrors >= 5) {
            clearInterval(pollRef.current!)
            setStatus("failed")
            setError(data?.error || data?.error_message || "Status check failed. Please check History later.")
          }
          return
        }
        consecutiveErrors = 0
        setProgress(data.progress ?? 0)
        if (data.status === "completed") {
          clearInterval(pollRef.current!)
          setStatus("completed")
          setOutputUrl(data.output_url)
        } else if (data.status === "failed") {
          clearInterval(pollRef.current!)
          setStatus("failed")
          setError(data.error_message ?? "Generation failed.")
        } else {
          setStatus(data.status === "processing" ? "processing" : "pending")
        }
      } catch {
        // network hiccup — keep polling (covered by the timeout above)
      }
    }, POLL_INTERVAL_MS)
  }, [])

  // Credit estimate (UI mirror of the server calculation — server is authoritative).
  const chargedSeconds = videoDuration != null ? Math.min(300, Math.max(1, Math.ceil(videoDuration))) : null
  const upscaleEstimate = chargedSeconds != null ? UPSCALE_PER_SEC[resolution] * (fps === 60 ? 2 : 1) * chargedSeconds : null
  const extendEstimate = EXTEND_FLAT[extendResolution]
  const creditEstimate = tool === "upscale" ? upscaleEstimate : extendEstimate

  const handleGenerate = async () => {
    setError(null)
    setOutputUrl(null)
    setProgress(0)

    if (tool === "upscale" && videoDuration == null) {
      setError("Could not read the video duration yet — wait for the preview to load (the duration drives the credit cost).")
      return
    }
    // Bytedance 1080p-upscale provider rule: the SOURCE must have at least one side below 1080px.
    // Pre-flight here when dimensions are known; otherwise fal's real validation message is surfaced by the status route.
    if (tool === "upscale" && resolution === "1080p" && videoDims && Math.min(videoDims.width, videoDims.height) >= 1080) {
      setError("1080p upscale requires the source video to be below 1080p. Choose 2K or 4K.")
      return
    }

    // Generate consumes a PUBLIC URL only: a manual URL, or the eagerly-uploaded file's stored URL.
    // If the eager upload failed, retry it here (still signed direct-to-storage — never /api/upload).
    let resolvedUrl: string | null = null
    if (uploadFile) {
      resolvedUrl = uploadedUrl ?? (uploadState !== "uploading" ? await startUpload(uploadFile) : null)
    } else if (videoUrl && /^https?:\/\//.test(videoUrl)) {
      resolvedUrl = videoUrl
    }
    if (!resolvedUrl) return

    setStatus("pending")
    try {
      const body =
        tool === "upscale"
          ? { tool, video_url: resolvedUrl, resolution, fps, duration_seconds: videoDuration }
          : { tool, video_url: resolvedUrl, resolution: extendResolution, prompt: prompt.trim() || undefined }
      const res = await fetch("/api/generate/video-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Could not start the generation.")
        setStatus("idle")
        return
      }
      pollStatus(data.jobId)
    } catch {
      setError("Could not send the request.")
      setStatus("idle")
    }
  }

  const handleReset = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    setStatus("idle")
    setProgress(0)
    setOutputUrl(null)
    setError(null)
    setUploadFile(null)
    setPreviewUrl(null)
    setVideoUrl("")
    setVideoDuration(null); setVideoDims(null)
    setUploadedUrl(null)
    setUploadState("idle")
    setPrompt("")
  }

  // Remove the source video entirely — resets every source + job/result/error field to a clean slate.
  const handleRemoveVideo = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    setUploadFile(null)
    setPreviewUrl(null)
    setUploadedUrl(null)
    setUploadState("idle")
    setVideoDuration(null)
    setVideoDims(null)
    setVideoUrl("")
    setError(null)
    setOutputUrl(null)
    setProgress(0)
    setStatus("idle")
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  // Change the source video — clears the current source, then reopens the OS file picker.
  const handleChangeVideo = () => {
    handleRemoveVideo()
    fileInputRef.current?.click()
  }

  const isGenerating = status === "pending" || status === "processing"
  const previewSrc = previewUrl || (videoUrl && /^https?:\/\//.test(videoUrl) ? videoUrl : null)

  const ui = TOOL_UI[tool]
  const chip = (active: boolean) =>
    active
      ? { background: ui.accent, color: ui.accentText, borderColor: ui.accent }
      : { background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.7)", borderColor: "rgba(255,255,255,0.1)" }
  const priceLabel =
    tool === "upscale" ? (creditEstimate != null ? `${creditEstimate} QLC` : "per second") : `${extendEstimate} QLC`

  return (
    <div className="relative min-h-screen text-white">
      <QelarixBackdrop tone={ui.tone} />

      <div className="relative z-10 flex flex-col lg:flex-row gap-6 p-4 lg:p-8 min-h-screen">
        {/* Controls column */}
        <aside className="w-full lg:w-[400px] flex-shrink-0 flex flex-col gap-5">
          {/* Title card */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl p-5 backdrop-blur-xl"
            style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))", border: "1px solid rgba(255,255,255,0.12)" }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em]" style={{ color: ui.accent }}>Video tool</div>
            <h1 className="text-2xl font-bold mt-1.5">{ui.title}</h1>
            <p className="text-white/60 text-sm mt-1">{ui.desc}</p>
          </motion.div>

          {/* Source */}
          <div className="rounded-2xl p-5 backdrop-blur-xl" style={{ background: "rgba(10,10,12,0.55)", border: "1px solid rgba(255,255,255,0.1)" }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-white/55">Source video</span>
              <span className="text-[10px] text-white/35">MP4 · MOV · WebM · 100 MB</span>
            </div>

            {previewSrc ? (
              <div className="flex gap-2">
                <button
                  onClick={handleChangeVideo}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white/80 hover:text-white transition-colors"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)" }}
                >
                  Change video
                </button>
                <button
                  onClick={handleRemoveVideo}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium text-red-300 hover:bg-red-500/10 transition-colors"
                  style={{ border: "1px solid rgba(248,113,113,0.3)" }}
                >
                  Remove video
                </button>
              </div>
            ) : (
              <div
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl py-7 px-4 text-center cursor-pointer transition-colors"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.2)" }}
              >
                <div className="w-11 h-11 mx-auto mb-3 rounded-xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.06)", color: ui.accent }}>
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                </div>
                <p className="text-sm text-white/80">
                  Drop a video or <span style={{ color: ui.accent }}>click to upload</span>
                </p>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFileSelect(f)
              }}
            />

            <div className="relative mt-3">
              <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-white/40 text-xs">
                or URL
              </div>
              <input
                type="url"
                value={videoUrl}
                onChange={(e) => { setVideoUrl(e.target.value); setUploadFile(null); setPreviewUrl(null); setVideoDuration(null); setVideoDims(null); setUploadedUrl(null); setUploadState("idle"); setError(null) }}
                placeholder="https://..."
                className="w-full rounded-lg pl-16 pr-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
            </div>
            <div className="flex items-center gap-3 mt-2 min-h-[16px]">
              {videoDuration != null && <p className="text-white/45 text-xs">Source length: ~{Math.ceil(videoDuration)}s</p>}
              {uploadFile && uploadState === "uploading" && <p className="text-xs text-white/70">Uploading source video...</p>}
              {uploadFile && uploadState === "ready" && <p className="text-xs" style={{ color: ui.accent }}>Source video ready</p>}
              {uploadFile && uploadState === "failed" && <p className="text-red-400 text-xs">Upload failed. Generate retries it, or select the file again.</p>}
            </div>
          </div>

          {/* Settings */}
          <div className="rounded-2xl p-5 backdrop-blur-xl" style={{ background: "rgba(10,10,12,0.55)", border: "1px solid rgba(255,255,255,0.1)" }}>
            {tool === "upscale" ? (
              <>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-white/55 block mb-2.5">Target resolution</span>
                <div className="grid grid-cols-3 gap-2 mb-5">
                  {(["1080p", "2k", "4k"] as UpscaleResolution[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => { setResolution(r); setError(null) }}
                      className="py-2.5 rounded-xl text-sm font-semibold border transition-all"
                      style={chip(resolution === r)}
                    >
                      {UPSCALE_RES_LABEL[r]}
                      <span className="block text-[10px] font-medium opacity-75">{UPSCALE_PER_SEC[r]} QLC/sec</span>
                    </button>
                  ))}
                </div>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-white/55 block mb-2.5">Frame rate</span>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {([30, 60] as Fps[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => { setFps(f); setError(null) }}
                      className="py-2.5 rounded-xl text-sm font-semibold border transition-all"
                      style={chip(fps === f)}
                    >
                      {f} fps{f === 60 ? " · 2x QLC" : ""}
                    </button>
                  ))}
                </div>
                <button
                  disabled
                  title="Pro mode is coming soon"
                  className="w-full py-2.5 rounded-xl text-xs font-medium text-white/35 cursor-not-allowed"
                  style={{ border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  Pro mode · Coming soon
                </button>
              </>
            ) : (
              <>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-white/55 block mb-2.5">Output · adds 5 seconds</span>
                <div className="grid grid-cols-2 gap-2 mb-5">
                  {(["720p", "1080p"] as ExtendResolution[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => { setExtendResolution(r); setError(null) }}
                      className="py-2.5 rounded-xl text-sm font-semibold border transition-all"
                      style={chip(extendResolution === r)}
                    >
                      {r}
                      <span className="block text-[10px] font-medium opacity-75">{EXTEND_FLAT[r]} QLC</span>
                    </button>
                  ))}
                </div>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-white/55 block mb-2.5">
                  Extension prompt <span className="normal-case tracking-normal text-white/35">(optional)</span>
                </span>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe how the video should continue..."
                  rows={3}
                  className="w-full rounded-xl p-3 text-sm text-white placeholder-white/30 focus:outline-none resize-none"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
                />
              </>
            )}
          </div>

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                className="rounded-xl p-4 text-red-300 text-sm"
                style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)" }}
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Generate: one solid accent colour, price on the right */}
          {status === "idle" || status === "failed" ? (
            <button
              onClick={handleGenerate}
              disabled={(!videoUrl && !uploadFile) || uploadState === "uploading"}
              className="w-full py-4 px-5 rounded-2xl font-semibold text-base flex items-center justify-between transition-all hover:brightness-110 active:scale-[0.99] disabled:opacity-45 disabled:cursor-not-allowed"
              style={{ background: ui.accent, color: ui.accentText, boxShadow: `0 12px 36px -12px ${ui.glow}` }}
            >
              <span>{uploadState === "uploading" ? "Uploading source video..." : tool === "upscale" ? "Upscale video" : "Extend video"}</span>
              <span className="text-xs font-semibold opacity-80">{priceLabel}</span>
            </button>
          ) : null}
          {tool === "upscale" && creditEstimate == null && (
            <p className="text-white/40 text-[11px] text-center -mt-2">Load a video to see the exact price.</p>
          )}
        </aside>

        {/* Stage */}
        <main className="flex-1 flex items-center justify-center min-h-[360px]">
          <div
            className="w-full max-w-4xl rounded-3xl overflow-hidden backdrop-blur-md p-4 lg:p-6"
            style={{ background: "rgba(10,10,12,0.45)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: `0 30px 90px -30px ${ui.glow}` }}
          >
            {status === "completed" && outputUrl ? (
              <div>
                <div className="flex items-center gap-2 mb-4 text-sm font-semibold" style={{ color: ui.accent }}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {tool === "upscale" ? "Video upscaled" : "Video extended"}
                </div>
                <video src={outputUrl} controls className="w-full rounded-2xl mb-4 bg-black" />
                <div className="flex gap-3">
                  <a
                    href={downloadHref(outputUrl, `qelarix-${tool === "upscale" ? "upscaled" : "extended"}-${Date.now()}.mp4`)}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-3 rounded-xl text-center font-semibold text-sm transition-all hover:brightness-110"
                    style={{ background: ui.accent, color: ui.accentText }}
                  >
                    Download video
                  </a>
                  <button
                    onClick={handleReset}
                    className="flex-1 py-3 rounded-xl font-medium text-sm text-white/80 hover:text-white transition-colors"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)" }}
                  >
                    New video
                  </button>
                </div>
              </div>
            ) : isGenerating ? (
              <div className="py-16 px-4 text-center">
                <div
                  className="w-20 h-20 mx-auto mb-6 rounded-3xl flex items-center justify-center animate-pulse"
                  style={{ color: ui.accent, border: `1px solid ${ui.accent}`, boxShadow: `0 0 60px -8px ${ui.glow}` }}
                >
                  <svg className="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                </div>
                <div className="flex items-center justify-between max-w-md mx-auto mb-2 text-sm">
                  <span className="text-white/70">{status === "processing" ? "Processing..." : "Queued..."}</span>
                  <span className="font-semibold" style={{ color: ui.accent }}>{progress}%</span>
                </div>
                <div className="h-2 max-w-md mx-auto rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <motion.div className="h-full rounded-full" style={{ background: ui.accent }} animate={{ width: `${progress}%` }} transition={{ duration: 0.5 }} />
                </div>
                <p className="text-white/45 text-xs mt-4">Long videos can take a few minutes. You can leave this page; the result also appears in History.</p>
              </div>
            ) : previewSrc ? (
              <video
                src={previewSrc}
                className="w-full max-h-[70vh] rounded-2xl bg-black"
                controls
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration
                  setVideoDuration(Number.isFinite(d) && d > 0 ? d : null)
                  const w = e.currentTarget.videoWidth
                  const h = e.currentTarget.videoHeight
                  setVideoDims(w > 0 && h > 0 ? { width: w, height: h } : null)
                }}
              />
            ) : (
              <div className="py-20 px-4 text-center">
                <div
                  className="w-20 h-20 mx-auto mb-6 rounded-3xl flex items-center justify-center"
                  style={{ color: ui.accent, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: `0 0 70px -10px ${ui.glow}` }}
                >
                  <svg className="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold">{ui.title}</h2>
                <p className="text-white/55 text-sm mt-2">Add a source video on the left. The preview and the result appear here.</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
