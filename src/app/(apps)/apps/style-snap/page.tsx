"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { RefreshCw } from "lucide-react"

const PRICE_CREDITS = 8
const ACCENT = "#3BE7FF"
// Real existing preview asset — shown as the default right-panel state before generation.
const EXAMPLE_VIDEO = "/apps/previews/style-snap.mp4"

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

// ── Compact upload slot (one image) ─────────────────────────────────────────────────────────────
function UploadSlot({ label, hint, url, busy, onFile, onClear }: {
  label: string
  hint: string
  url: string | null
  busy: boolean
  onFile: (f: File | undefined) => void
  onClear: () => void
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  const [drag, setDrag] = useState(false)
  return (
    <div className="flex flex-col min-w-0 h-full">
      <span className="text-white/40 text-[10px] font-semibold uppercase tracking-widest mb-1.5">{label}</span>
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      <div
        onClick={() => !busy && ref.current?.click()}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) onFile(e.dataTransfer.files?.[0]) }}
        className="relative flex-1 min-h-0 rounded-xl overflow-hidden flex flex-col items-center justify-center text-center px-3 transition-colors"
        style={{
          cursor: busy ? "default" : "pointer",
          background: drag ? "rgba(59,231,255,0.06)" : "rgba(255,255,255,0.015)",
          border: `1px dashed ${drag ? ACCENT : "rgba(255,255,255,0.14)"}`,
        }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="absolute inset-0 w-full h-full object-contain p-2 select-none pointer-events-none" draggable={false} />
        ) : (
          <>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-base mb-2"
              style={{ background: "rgba(59,231,255,0.10)", border: `1px solid ${ACCENT}44`, color: ACCENT }}>↑</div>
            <p className="text-white/75 text-[12px] font-medium">Upload {label.toLowerCase()}</p>
            <p className="text-white/30 text-[10px] mt-1">{hint}</p>
          </>
        )}
      </div>
      {url && !busy && (
        <button onClick={onClear} className="mt-1.5 text-[10px] text-white/40 hover:text-white/70 transition-colors self-start">
          Clear
        </button>
      )}
    </div>
  )
}

export default function StyleSnapPage() {
  const [modelFile, setModelFile] = useState<File | null>(null)
  const [modelUrl, setModelUrl] = useState<string | null>(null)
  const [garmentFile, setGarmentFile] = useState<File | null>(null)
  const [garmentUrl, setGarmentUrl] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  const busy = phase === "uploading" || phase === "processing"
  const canGenerate = Boolean(modelFile) && Boolean(garmentFile) && !busy

  function pickImage(setF: (f: File | null) => void, setU: (u: string | null) => void) {
    return (f: File | undefined) => {
      if (!f || !f.type.startsWith("image/")) { setError("Please choose an image (PNG, JPG, WebP)."); return }
      setError(null); setResultUrl(null); setPhase("idle"); setProgress(0)
      setF(f)
      setU(URL.createObjectURL(f))
    }
  }

  function reset() {
    if (modelUrl) URL.revokeObjectURL(modelUrl)
    if (garmentUrl) URL.revokeObjectURL(garmentUrl)
    setModelFile(null); setModelUrl(null); setGarmentFile(null); setGarmentUrl(null)
    setResultUrl(null); setPhase("idle"); setError(null); setProgress(0)
  }

  async function pollStatus(jobId: string): Promise<string> {
    // ~4 min backstop. A failed job returns status:"failed" quickly, so this only guards a true hang.
    for (let i = 0; i < 120; i++) {
      await sleep(2000)
      const r = await fetch(`/api/apps/style-snap/status/${jobId}`)
      const d = await r.json().catch(() => ({}))
      if (typeof d.progress === "number") setProgress(d.progress)
      if (d.status === "completed" && d.output_url) return d.output_url as string
      if (d.status === "failed") throw new Error(d.error_message || "Outfit change failed")
    }
    throw new Error("Outfit change did not finish. Please try again.")
  }

  function onGenerateClick(event: React.MouseEvent) {
    if (busy) { event.preventDefault(); return }
    if (!modelFile) { event.preventDefault(); setError("Upload a model image first."); return }
    if (!garmentFile) { event.preventDefault(); setError("Upload a garment image first."); return }
    handleGenerate()
  }

  async function handleGenerate() {
    if (!modelFile || !garmentFile || busy) return
    setError(null); setResultUrl(null); setProgress(0)
    try {
      setPhase("uploading")
      const [model_image_url, garment_image_url] = await Promise.all([
        signedUpload(modelFile),
        signedUpload(garmentFile),
      ])
      setPhase("processing"); setProgress(8)
      const res = await fetch("/api/apps/style-snap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_image_url, garment_image_url }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not start outfit change.")
      const out = await pollStatus(data.jobId as string)
      setResultUrl(out); setProgress(100); setPhase("done")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong."); setPhase("error")
    }
  }

  async function download() {
    if (!resultUrl) return
    try {
      const blob = await fetch(resultUrl).then((r) => r.blob())
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = "qelarix-style-snap.png"; a.click()
      URL.revokeObjectURL(url)
    } catch { window.open(resultUrl, "_blank") }
  }

  return (
    <div className="min-h-screen" style={{ background: "#050507" }}>
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{
        background: "radial-gradient(120% 60% at 12% -8%, rgba(123,97,255,0.10), transparent 58%), radial-gradient(120% 55% at 95% -2%, rgba(59,231,255,0.07), transparent 58%)",
      }} />

      <div className="relative max-w-[1240px] mx-auto px-6 lg:px-10 pt-14 lg:pt-12 pb-20">
        {/* Header */}
        <Link href="/apps" className="text-xs text-white/40 hover:text-white/70 transition-colors">← Apps</Link>
        <h1 className="text-2xl lg:text-3xl font-bold text-white tracking-tight mt-3">Style Snap</h1>
        <p className="text-white/45 text-sm mt-2 max-w-xl">
          Swap outfits from a style reference while keeping the person, pose, and composition clean.
        </p>

        <div className="flex flex-col lg:flex-row gap-6 mt-8 items-start">
          {/* ── LEFT = INPUT: model + garment uploads + Generate button ── */}
          <div className="w-full lg:w-[638px] lg:h-[638px] flex flex-col gap-4">
            <div className="w-full flex-1 min-h-[360px] flex flex-col rounded-2xl p-5"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="grid grid-cols-2 gap-3 flex-1 min-h-0">
                <UploadSlot label="Model" hint="Clear model photo" url={modelUrl} busy={busy}
                  onFile={pickImage(setModelFile, setModelUrl)}
                  onClear={() => { if (modelUrl) URL.revokeObjectURL(modelUrl); setModelFile(null); setModelUrl(null); setResultUrl(null) }} />
                <UploadSlot label="Garment" hint="Single garment image" url={garmentUrl} busy={busy}
                  onFile={pickImage(setGarmentFile, setGarmentUrl)}
                  onClear={() => { if (garmentUrl) URL.revokeObjectURL(garmentUrl); setGarmentFile(null); setGarmentUrl(null); setResultUrl(null) }} />
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-white/30 text-[11px]">Upload a model photo and one garment image.</span>
                {(modelFile || garmentFile) && !busy && (
                  <button onClick={reset} className="text-xs text-white/40 hover:text-white/70 transition-colors flex-shrink-0">
                    Clear all
                  </button>
                )}
              </div>
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

          {/* ── RIGHT = OUTPUT: placeholder → loading → result + download ── */}
          <div className="w-full lg:w-[638px] aspect-square lg:aspect-auto lg:h-[638px] rounded-2xl overflow-hidden flex flex-col"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden" style={{ background: "#0c0d12" }}>
              {/* Default preview — before generation only (real preview video, no overlay/labels) */}
              {!resultUrl && !busy && (
                <video src={EXAMPLE_VIDEO} autoPlay muted loop playsInline preload="auto"
                  className="absolute inset-0 w-full h-full object-cover object-center" />
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
                  <p className="text-white/70 text-xs mt-3">Styling outfit… {progress}%</p>
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
