"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { RefreshCw } from "lucide-react"

const PRICE_CREDITS = 8
const ACCENT = "#3BE7FF"
// Real existing preview asset — default right-panel state before generation.
const EXAMPLE_VIDEO = "/apps/previews/image-extension-preview.mp4"
// Provider-valid target ratios (fal-ai/ideogram/v3/reframe). Each maps server-side to a concrete
// image_size (5 native presets + 5 explicit canvases). No "Auto" — the model always needs a target.
const RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9"] as const

// Qelarix standard signed direct-to-storage upload → returns a public URL (no Vercel body cap).
async function signedUpload(file: File): Promise<string> {
  const signRes = await fetch("/api/upload/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
  })
  const sign = await signRes.json().catch(() => ({}))
  if (!signRes.ok || !sign?.signedUrl || !sign?.publicUrl) throw new Error(sign?.error || "Upload failed")
  const putRes = await fetch(sign.signedUrl as string, {
    method: "PUT",
    headers: { "Content-Type": file.type, "x-upsert": "false" },
    body: file,
  })
  if (!putRes.ok) throw new Error("Upload failed")
  return sign.publicUrl as string
}

type Phase = "idle" | "uploading" | "processing" | "done" | "error"

// Qelarix Apps generate button — copied 1:1 from the Cinema "Generate scene" button (StudioInspector.tsx).
const generateButtonStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #A38CFF 0%, #7C5CF0 46%, #5E3FD6 100%)",
  boxShadow:
    "inset 0 1.5px 0 rgba(255,255,255,0.4), inset 0 -10px 16px -8px rgba(28,12,68,0.55), 0 3px 4px rgba(0,0,0,0.34), 0 16px 30px -8px rgba(94,63,214,0.55)",
  color: "#FFFFFF",
  opacity: 1,
  filter: "none",
}

export default function ImageExtensionPage() {
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [aspect, setAspect] = useState<string>("16:9")
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const busy = phase === "uploading" || phase === "processing"
  const canGenerate = Boolean(file) && !busy

  function onFile(f: File | undefined) {
    if (!f || !f.type.startsWith("image/")) { setError("Please choose an image (PNG, JPG, WebP)."); return }
    setError(null); setResultUrl(null); setPhase("idle"); setProgress(0)
    setFile(f)
    setOriginalUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f) })
  }

  function reset() {
    setOriginalUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null })
    setFile(null); setResultUrl(null); setPhase("idle"); setError(null); setProgress(0)
  }

  function onGenerateClick(event: React.MouseEvent) {
    if (busy) { event.preventDefault(); return }
    if (!file) { event.preventDefault(); setError("Upload an image first."); return }
    handleGenerate()
  }

  async function handleGenerate() {
    if (!file || busy) return
    setError(null); setResultUrl(null); setProgress(0)
    // The reframe call is synchronous (one POST resolves with the result) — animate a creeping bar
    // while we wait, since there are no incremental progress events.
    let creep: ReturnType<typeof setInterval> | null = null
    try {
      setPhase("uploading")
      const image_url = await signedUpload(file)
      setPhase("processing"); setProgress(10)
      creep = setInterval(() => setProgress((p) => (p < 92 ? p + 2 : p)), 700)
      const res = await fetch("/api/apps/image-extension", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url, ratio: aspect }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not extend image.")
      if (!data.resultUrl) throw new Error("No output image returned.")
      if (creep) { clearInterval(creep); creep = null }
      setResultUrl(data.resultUrl as string); setProgress(100); setPhase("done")
    } catch (e) {
      if (creep) clearInterval(creep)
      setError(e instanceof Error ? e.message : "Something went wrong."); setPhase("error")
    }
  }

  async function download() {
    if (!resultUrl) return
    try {
      const blob = await fetch(resultUrl).then((r) => r.blob())
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = "qelarix-image-extended.png"; a.click()
      URL.revokeObjectURL(url)
    } catch { window.open(resultUrl, "_blank") }
  }

  // RIGHT = output only: default example until Generate is clicked, then loading, then result.
  const showExample = !resultUrl && !busy

  return (
    <div className="min-h-screen" style={{ background: "#050507" }}>
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{
        background: "radial-gradient(120% 60% at 12% -8%, rgba(123,97,255,0.10), transparent 58%), radial-gradient(120% 55% at 95% -2%, rgba(59,231,255,0.07), transparent 58%)",
      }} />

      <div className="relative max-w-[1400px] mx-auto px-6 lg:px-10 pt-14 lg:pt-12 pb-20">
        {/* Header */}
        <Link href="/apps" className="text-xs text-white/40 hover:text-white/70 transition-colors">← Apps</Link>
        <h1 className="text-2xl lg:text-3xl font-bold text-white tracking-tight mt-3">Image Extension</h1>
        <p className="text-white/45 text-sm mt-2 max-w-xl">
          Reframe and extend images into a new aspect ratio with clean generative fill.
        </p>

        <div className="flex flex-col lg:flex-row gap-6 mt-8 items-start">
          {/* ── LEFT = INPUT: upload + aspect ratio + Generate ── */}
          <div className="w-full lg:w-[638px] lg:h-[638px] flex flex-col gap-4">
            <div className="w-full flex-1 min-h-[360px] flex flex-col rounded-2xl p-5"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <input ref={inputRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])} />

              {/* Image — dropzone, or the uploaded original once chosen */}
              <div
                onClick={() => !busy && inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) onFile(e.dataTransfer.files?.[0]) }}
                className="relative flex-1 min-h-0 flex flex-col items-center justify-center text-center rounded-xl px-4 overflow-hidden transition-colors"
                style={{
                  cursor: busy ? "default" : "pointer",
                  background: dragging ? "rgba(59,231,255,0.06)" : "rgba(255,255,255,0.015)",
                  border: `1px dashed ${dragging ? ACCENT : "rgba(255,255,255,0.14)"}`,
                }}
              >
                {originalUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={originalUrl} alt="original" className="absolute inset-0 w-full h-full object-contain p-3 select-none pointer-events-none" draggable={false} />
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl mb-3"
                      style={{ background: "rgba(59,231,255,0.10)", border: `1px solid ${ACCENT}44`, color: ACCENT }}>↑</div>
                    <p className="text-white/80 text-sm font-medium px-2 break-all">Drop an image or click to upload</p>
                    <p className="text-white/35 text-[11px] mt-1.5">PNG · JPG · WebP</p>
                  </>
                )}
              </div>

              {/* Aspect ratio selector */}
              <div className="mt-4">
                <span className="text-white/40 text-[10px] font-semibold uppercase tracking-widest">Target aspect ratio</span>
                <div className="flex flex-wrap gap-2 mt-2">
                  {RATIOS.map((r) => {
                    const active = aspect === r
                    return (
                      <button key={r} type="button" disabled={busy}
                        onClick={() => setAspect(r)}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                        style={active
                          ? { background: "rgba(123,97,255,0.22)", border: "1px solid rgba(123,97,255,0.6)", color: "#fff" }
                          : { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.6)" }}>
                        {r}
                      </button>
                    )
                  })}
                </div>
              </div>

              {file && !busy && (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-white/55 text-xs truncate">{file.name}</span>
                  <button onClick={reset} className="text-xs text-white/40 hover:text-white/70 transition-colors flex-shrink-0">
                    Clear image
                  </button>
                </div>
              )}
              {error && (
                <p className="mt-2 text-xs leading-relaxed" style={{ color: "#E06464" }}>{error}</p>
              )}
            </div>

            {/* Generate — stays on the LEFT, under the inputs (Cinema/Qelarix purple glossy). */}
            <button
              type="button"
              aria-disabled={!canGenerate}
              onClick={onGenerateClick}
              className="w-full"
              style={{
                ...generateButtonStyle,
                border: "none",
                minHeight: 50,
                padding: "13px 18px",
                borderRadius: 14,
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: "-0.2px",
                cursor: canGenerate ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              {busy ? (
                <><RefreshCw size={15} className="animate-spin" /> Generating…</>
              ) : (
                <>
                  <span>Generate</span>
                  <span style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{PRICE_CREDITS} QLC</span>
                </>
              )}
            </button>
          </div>

          {/* ── RIGHT = OUTPUT: example → loading → result + download ── */}
          <div className="w-full lg:w-[638px] aspect-square lg:aspect-auto lg:h-[638px] rounded-2xl overflow-hidden flex flex-col"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden" style={{ background: "#0c0d12" }}>
              {/* Default example — before generation only (real preview video, no overlay) */}
              {showExample && (
                <>
                  <video src={EXAMPLE_VIDEO} autoPlay muted loop playsInline preload="auto"
                    className="absolute inset-0 w-full h-full object-cover object-center" />
                  <span className="absolute top-3 left-3 text-[10px] font-medium px-2.5 py-1 rounded-full"
                    style={{ background: "rgba(8,10,16,0.78)", color: "rgba(255,255,255,0.85)", border: "1px solid rgba(255,255,255,0.12)" }}>
                    Example
                  </span>
                </>
              )}

              {/* Final result — after success */}
              {resultUrl && !busy && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={resultUrl} alt="result" className="max-w-full max-h-full object-contain" />
              )}

              {/* Loading — during generation */}
              {busy && (
                <div className="flex flex-col items-center justify-center">
                  <div className="w-44 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.1)" }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: `linear-gradient(90deg,#7B61FF,${ACCENT})` }} />
                  </div>
                  <p className="text-white/70 text-xs mt-3">Extending image… {progress}%</p>
                </div>
              )}
            </div>

            {/* Download — after result */}
            {resultUrl && !busy && (
              <div className="flex items-center justify-end px-5 py-3.5" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                <button onClick={download}
                  className="text-xs font-semibold px-4 py-1.5 rounded-lg transition-all"
                  style={{ background: "linear-gradient(135deg, #7B61FF 0%, #3BE7FF 100%)", color: "#fff", boxShadow: "0 0 18px rgba(123,97,255,0.35)" }}>
                  Download Image
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
