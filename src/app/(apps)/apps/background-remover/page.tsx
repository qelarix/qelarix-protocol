"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { RefreshCw } from "lucide-react"

const PRICE_CREDITS = 4
const ACCENT = "#3BE7FF"
// Real user-provided example image. Path is all-lowercase to match the committed asset — required
// because case-sensitive production hosting 404s on any uppercase variant.
const EXAMPLE_IMAGE = "/apps/previews/images/background-remover-preview.png"

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

// Bright, clean transparency checkerboard — used only behind the transparent PNG result so the cut-out
// reads clearly. The default example never uses it.
const CHECKER: React.CSSProperties = {
  backgroundColor: "#eaedf2",
  backgroundImage:
    "linear-gradient(45deg, #c8d0dc 25%, transparent 25%), linear-gradient(-45deg, #c8d0dc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c8d0dc 75%), linear-gradient(-45deg, transparent 75%, #c8d0dc 75%)",
  backgroundSize: "24px 24px",
  backgroundPosition: "0 0, 0 12px, 12px -12px, -12px 0px",
}

// Qelarix Apps generate button — copied 1:1 from the Cinema "Generate scene" button (StudioInspector.tsx):
// violet gradient + glossy inset/glow shadow. opacity:1 + filter:none are inline so no className can dim it;
// it stays bright in all states (no-image is blocked via the canGenerate guard, not native disabled).
const generateButtonStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #A38CFF 0%, #7C5CF0 46%, #5E3FD6 100%)",
  boxShadow:
    "inset 0 1.5px 0 rgba(255,255,255,0.4), inset 0 -10px 16px -8px rgba(28,12,68,0.55), 0 3px 4px rgba(0,0,0,0.34), 0 16px 30px -8px rgba(94,63,214,0.55)",
  color: "#FFFFFF",
  opacity: 1,
  filter: "none",
}

export default function BackgroundRemoverPage() {
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
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

  async function pollStatus(jobId: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      await sleep(2000)
      const r = await fetch(`/api/apps/background-remover/status/${jobId}`)
      const d = await r.json().catch(() => ({}))
      if (typeof d.progress === "number") setProgress(d.progress)
      if (d.status === "completed" && d.output_url) return d.output_url as string
      if (d.status === "failed") throw new Error(d.error_message || "Background removal failed")
    }
    throw new Error("Timed out — please try again.")
  }

  async function handleGenerate() {
    if (!file || busy) return
    setError(null); setResultUrl(null); setProgress(0)
    try {
      setPhase("uploading")
      const imageUrl = await signedUpload(file)
      setPhase("processing"); setProgress(8)
      const res = await fetch("/api/apps/background-remover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: imageUrl }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not start background removal.")
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
      a.href = url; a.download = "qelarix-background-removed.png"; a.click()
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
        <h1 className="text-2xl lg:text-3xl font-bold text-white tracking-tight mt-3">Background Remover</h1>
        <p className="text-white/45 text-sm mt-2 max-w-xl">
          Remove image backgrounds with a clean, pixel-precise cutout — ideal for product, creator, and marketing assets.
        </p>

        <div className="flex flex-col lg:flex-row gap-6 mt-8 items-start">
          {/* ── LEFT = INPUT: upload / original preview + Generate button ── */}
          <div className="w-full lg:w-[638px] lg:h-[638px] flex flex-col gap-4">
            {/* Input card — dropzone, or the uploaded original preview once a file is chosen */}
            <div className="w-full flex-1 min-h-[260px] flex flex-col rounded-2xl p-5"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <input ref={inputRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])} />

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
                  // Uploaded / original image — shown on the LEFT (input side)
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={originalUrl} alt="original" className="absolute inset-0 w-full h-full object-contain p-3" />
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl mb-3"
                      style={{ background: "rgba(59,231,255,0.10)", border: `1px solid ${ACCENT}44`, color: ACCENT }}>↑</div>
                    <p className="text-white/80 text-sm font-medium px-2 break-all">Drop an image or click to upload</p>
                    <p className="text-white/35 text-[11px] mt-1.5">PNG · JPG · WebP</p>
                  </>
                )}
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
                <p className="mt-3 text-xs leading-relaxed" style={{ color: "#E06464" }}>{error}</p>
              )}
            </div>

            {/* Generate — stays on the LEFT, under the input panel (Cinema/Qelarix purple glossy). */}
            <button
              type="button"
              aria-disabled={!canGenerate}
              onClick={(event) => { if (!canGenerate) { event.preventDefault(); return } handleGenerate() }}
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
            <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
              style={resultUrl ? CHECKER : { background: "#0c0d12" }}>
              {/* Default example — before generation only (object-cover, no checkerboard, no overlay) */}
              {showExample && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={EXAMPLE_IMAGE} alt="Background removal example" className="absolute inset-0 w-full h-full object-cover object-center" />
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
                  <p className="text-white/70 text-xs mt-3">Removing background… {progress}%</p>
                </div>
              )}
            </div>

            {/* Download — after result */}
            {resultUrl && !busy && (
              <div className="flex items-center justify-end px-5 py-3.5" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                <button onClick={download}
                  className="text-xs font-semibold px-4 py-1.5 rounded-lg transition-all"
                  style={{ background: "linear-gradient(135deg, #7B61FF 0%, #3BE7FF 100%)", color: "#fff", boxShadow: "0 0 18px rgba(123,97,255,0.35)" }}>
                  Download PNG
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
