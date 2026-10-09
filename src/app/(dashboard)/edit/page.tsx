"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { toast } from "sonner"
import { CREDITS } from "@/lib/credits"
import QelarixBackdrop from "@/components/ui/QelarixBackdrop"

// ─── Types ───────────────────────────────────────────────────────────────────

type TabId = "inpaint" | "face_swap" | "outfit" | "bg_remove" | "expand" | "upscale" | "relight"

interface TabDef {
  id: TabId
  label: string
  credits: number | string
  icon: React.ReactNode
  desc: string
}

const TABS: TabDef[] = [
  {
    id: "inpaint",
    label: "Inpainting",
    credits: CREDITS.edit.inpaint,
    desc: "Edit part of the image with a prompt",
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" /></svg>,
  },
  {
    id: "face_swap",
    label: "Face Swap",
    credits: CREDITS.edit.face_swap,
    desc: "Swap a face with another person",
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg>,
  },
  {
    id: "outfit",
    label: "Outfit Swap",
    credits: CREDITS.edit.outfit,
    desc: "Change the outfit in a photo",
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" /><path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" /></svg>,
  },
  {
    id: "bg_remove",
    label: "Remove background",
    credits: CREDITS.edit.bg_remove,
    desc: "Automatically remove the image background",
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  },
  {
    id: "expand",
    label: "Expand image",
    credits: CREDITS.edit.expand,
    desc: "Expand the image to a new aspect",
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>,
  },
  {
    id: "upscale",
    label: "Upscaler",
    credits: `${CREDITS.edit.upscale2x} / ${CREDITS.edit.upscale4x}`,
    desc: "Increase resolution 2x or 4x",
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" /></svg>,
  },
  {
    id: "relight",
    label: "Relight",
    credits: CREDITS.edit.relight,
    desc: "Change the image lighting",
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>,
  },
]

// ─── Tool themes ──────────────────────────────────────────────────────────────
// Each tool gets its own live backdrop and one solid accent colour (buttons, highlights, glows).
type ToolTheme = { tone: "violet" | "sunset" | "teal"; accent: string; accentText: string; glow: string }
const DEFAULT_THEME: ToolTheme = { tone: "violet", accent: "#8B5CF6", accentText: "#FFFFFF", glow: "rgba(139,92,246,0.45)" }
const TOOL_THEMES: Partial<Record<TabId, ToolTheme>> = {
  relight: { tone: "sunset", accent: "#FBBF24", accentText: "#1A1204", glow: "rgba(251,191,36,0.5)" },
}
const themeFor = (tab: TabId): ToolTheme => TOOL_THEMES[tab] ?? DEFAULT_THEME

// ─── Deep-link aliases ────────────────────────────────────────────────────────
// /edit?tool=<slug> → tab id. Accepts hub/nav slugs (faceswap, bg-remove, …) and the canonical ids.
const TOOL_ALIASES: Record<string, TabId> = {
  inpaint: "inpaint",
  faceswap: "face_swap",
  "face-swap": "face_swap",
  face_swap: "face_swap",
  outfit: "outfit",
  "bg-remove": "bg_remove",
  bg_remove: "bg_remove",
  expand: "expand",
  upscale: "upscale",
  relight: "relight",
}

// ─── Signed direct-to-storage upload ──────────────────────────────────────────
// Qelarix standard: tiny JSON → signed URL → PUT file straight to Supabase (generations bucket).
// Replaces the old FormData → /api/edit → "media" bucket path (404 + Vercel body cap). Returns publicUrl.
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

// ─── Image Upload Box ─────────────────────────────────────────────────────────

function ImageUpload({
  label,
  preview,
  onFile,
  onClear,
  disabled,
  hint,
}: {
  label: string
  preview: string | null
  onFile: (file: File) => void
  onClear: () => void
  disabled?: boolean
  hint?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith("image/")) { toast.error("Please select an image"); return }
    if (file.size > 10 * 1024 * 1024) { toast.error("Image must not exceed 10 MB"); return }
    onFile(file)
    e.target.value = ""
  }

  return (
    <div>
      <div className="text-white/40 text-[10px] font-semibold uppercase tracking-widest mb-1.5">{label}</div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleChange} />
      {preview ? (
        <div className="relative rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={label} className="w-full max-h-64 object-contain" style={{ background: "#000" }} />
          {!disabled && (
            <button
              onClick={onClear}
              className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-red-500/80 transition-colors text-lg leading-none"
            >
              ×
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="w-full h-36 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-all disabled:opacity-40"
          style={{ borderColor: "rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.02)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(123,97,255,0.5)" }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.12)" }}
        >
          <svg className="w-6 h-6 text-white/25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <span className="text-white/30 text-xs">Click to upload</span>
          {hint && <span className="text-white/20 text-[10px]">{hint}</span>}
        </button>
      )}
    </div>
  )
}

// ─── Canvas Mask Editor ───────────────────────────────────────────────────────

function MaskCanvas({
  imageUrl,
  onMaskReady,
}: {
  imageUrl: string
  onMaskReady: (maskDataUrl: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const isDrawing = useRef(false)
  const [brushSize, setBrushSize] = useState(24)
  const [maskActive, setMaskActive] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageUrl) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const img = new window.Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      imgRef.current = img
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      setMaskActive(false)
    }
    img.src = imageUrl
  }, [imageUrl])

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    if ("touches" in e) {
      const t = e.touches[0]
      return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY }
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  const drawBrush = (x: number, y: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.globalCompositeOperation = "source-over"
    ctx.fillStyle = "rgba(255,255,255,1)"
    ctx.beginPath()
    ctx.arc(x, y, (brushSize / 2) * (canvas.width / canvasRef.current!.getBoundingClientRect().width), 0, Math.PI * 2)
    ctx.fill()
  }

  const start = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    isDrawing.current = true
    setMaskActive(true)
    const pos = getPos(e)
    drawBrush(pos.x, pos.y)
  }

  const move = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return
    const pos = getPos(e)
    drawBrush(pos.x, pos.y)
  }

  const stop = () => {
    isDrawing.current = false
    // Export mask
    const canvas = canvasRef.current
    if (!canvas) return
    onMaskReady(canvas.toDataURL("image/png"))
  }

  const clearMask = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setMaskActive(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-white/40 text-[10px] font-semibold uppercase tracking-widest">
          Draw mask
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-white/30 text-[10px]">Brush: {brushSize}px</span>
            <input
              type="range" min="8" max="80" step="4"
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-20 accent-violet-500"
            />
          </div>
          {maskActive && (
            <button
              onClick={clearMask}
              className="text-white/40 hover:text-red-400 text-[10px] transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="relative rounded-xl overflow-hidden cursor-crosshair" style={{ border: "1px solid rgba(123,97,255,0.3)" }}>
        {/* Background image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="Inpaint base" className="w-full pointer-events-none select-none" draggable={false} />
        {/* Mask canvas overlay */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ mixBlendMode: "screen", opacity: 0.6, cursor: "crosshair" }}
          onMouseDown={start}
          onMouseMove={move}
          onMouseUp={stop}
          onMouseLeave={stop}
          onTouchStart={start}
          onTouchMove={move}
          onTouchEnd={stop}
        />
      </div>
      <p className="text-white/20 text-[10px] mt-1">White = area to change. Black = keep.</p>
    </div>
  )
}

// ─── Relight Wheel ────────────────────────────────────────────────────────────

const LIGHT_DIRECTIONS = [
  { id: "top-left", label: "Top left", angle: -135, cx: 50, cy: 20 },
  { id: "top", label: "Top", angle: -90, cx: 100, cy: 10 },
  { id: "top-right", label: "Top right", angle: -45, cx: 150, cy: 20 },
  { id: "left", label: "Left", angle: 180, cx: 10, cy: 75 },
  { id: "right", label: "Right", angle: 0, cx: 190, cy: 75 },
  { id: "bottom-left", label: "Bottom left", angle: 135, cx: 50, cy: 130 },
  { id: "bottom", label: "Bottom", angle: 90, cx: 100, cy: 140 },
  { id: "bottom-right", label: "Bottom right", angle: 45, cx: 150, cy: 130 },
]

function RelightWheel({
  direction,
  onSelect,
  accent,
  glow,
}: {
  direction: string
  onSelect: (d: string) => void
  accent: string
  glow: string
}) {
  return (
    <div>
      <div className="text-white/40 text-[10px] font-semibold uppercase tracking-widest mb-3">
        Light direction
      </div>
      <div
        className="relative mx-auto"
        style={{ width: 200, height: 150 }}
      >
        {/* Background dome */}
        <svg width="200" height="150" viewBox="0 0 200 150">
          <defs>
            <radialGradient id="dome" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={accent} stopOpacity="0.28" />
              <stop offset="100%" stopColor="#050505" stopOpacity="0.55" />
            </radialGradient>
          </defs>
          <ellipse cx="100" cy="75" rx="90" ry="70" fill="url(#dome)" stroke={accent} strokeOpacity="0.35" strokeWidth="1" />
          {/* Grid lines */}
          <line x1="10" y1="75" x2="190" y2="75" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
          <line x1="100" y1="5" x2="100" y2="145" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        </svg>

        {/* Direction buttons */}
        {LIGHT_DIRECTIONS.map((d) => {
          const isActive = direction === d.id
          return (
            <button
              key={d.id}
              onClick={() => onSelect(d.id)}
              className="absolute w-6 h-6 rounded-full flex items-center justify-center transition-all hover:scale-110"
              style={{
                left: d.cx - 12,
                top: d.cy - 12,
                background: isActive ? accent : "rgba(255,255,255,0.08)",
                border: isActive ? "2px solid rgba(255,255,255,0.85)" : "1px solid rgba(255,255,255,0.22)",
                boxShadow: isActive ? `0 0 18px ${glow}` : "none",
              }}
              title={d.label}
            >
              {isActive && (
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="6" />
                </svg>
              )}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] font-medium text-center mt-1" style={{ color: accent }}>
        {LIGHT_DIRECTIONS.find((d) => d.id === direction)?.label ?? "Choose direction"}
      </p>
    </div>
  )
}

// ─── Result Viewer ────────────────────────────────────────────────────────────

function ResultViewer({ url, onNew, theme }: { url: string; onNew: () => void; theme: ToolTheme }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="text-xs font-semibold flex items-center gap-1.5" style={{ color: theme.accent }}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Done
      </div>
      <div className="relative rounded-2xl overflow-hidden max-w-lg w-full" style={{ border: "1px solid rgba(255,255,255,0.14)", boxShadow: `0 24px 80px -20px ${theme.glow}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Result" className="w-full" />
      </div>
      <div className="flex gap-2">
        <a
          href={url}
          download={`edit-${Date.now()}.png`}
          className="px-5 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
          style={{ background: theme.accent, color: theme.accentText }}
        >
          Download
        </a>
        <button
          onClick={onNew}
          className="px-5 py-2 rounded-xl text-sm text-white/70 hover:text-white transition-colors backdrop-blur-md"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)" }}
        >
          New operation
        </button>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function EditPage() {
  const { data: session, update: updateSession } = useAuthSession()
  const userCredits = session?.user?.credits ?? 0

  const [activeTab, setActiveTab] = useState<TabId>("inpaint")
  const [isProcessing, setIsProcessing] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  // Shared state per tab
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [targetFile, setTargetFile] = useState<File | null>(null)
  const [targetPreview, setTargetPreview] = useState<string | null>(null)
  const [personFile, setPersonFile] = useState<File | null>(null)
  const [personPreview, setPersonPreview] = useState<string | null>(null)
  const [garmentFile, setGarmentFile] = useState<File | null>(null)
  const [garmentPreview, setGarmentPreview] = useState<string | null>(null)
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [expandRatio, setExpandRatio] = useState("16:9")
  const [upscaleFactor, setUpscaleFactor] = useState<"2" | "4">("2")
  const [lightDirection, setLightDirection] = useState("top-left")
  const [colorTemp, setColorTemp] = useState("5500")

  // Deep-link preselect from ?tool= (mount-only; invalid values keep the default inpaint tab).
  // window.location (not useSearchParams) keeps this page out of a Suspense boundary.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tool")
    if (t && TOOL_ALIASES[t]) setActiveTab(TOOL_ALIASES[t])
  }, [])

  // Reset result when tab changes
  useEffect(() => {
    setResultUrl(null)
  }, [activeTab])

  const clearFiles = () => {
    setImageFile(null); setImagePreview(null)
    setSourceFile(null); setSourcePreview(null)
    setTargetFile(null); setTargetPreview(null)
    setPersonFile(null); setPersonPreview(null)
    setGarmentFile(null); setGarmentPreview(null)
    setMaskDataUrl(null); setPrompt("")
    setResultUrl(null)
  }

  const handleFileSet = useCallback((file: File, setFile: (f: File | null) => void, setPreview: (s: string | null) => void) => {
    setFile(file)
    const reader = new FileReader()
    reader.onload = (e) => setPreview(e.target?.result as string)
    reader.readAsDataURL(file)
  }, [])

  const getOperationKey = (): string => {
    if (activeTab === "upscale") return upscaleFactor === "4" ? "upscale4x" : "upscale2x"
    return activeTab
  }

  const getCreditCost = (): number => {
    const op = getOperationKey()
    return CREDITS.edit[op as keyof typeof CREDITS.edit] ?? 0
  }

  const handleProcess = async () => {
    if (!session?.user?.id) { toast.error("You must be signed in"); return }

    const cost = getCreditCost()
    if (userCredits < cost) {
      toast.error(`Not enough QLC. You need ${cost}, you have ${userCredits}.`)
      return
    }

    // Validate inputs per tab
    if (activeTab === "inpaint" && (!imageFile || !maskDataUrl)) {
      toast.error("Upload an image and draw a mask"); return
    }
    if (activeTab === "face_swap" && (!sourceFile || !targetFile)) {
      toast.error("Upload both images for face swap"); return
    }
    if (activeTab === "outfit" && (!personFile || !garmentFile)) {
      toast.error("Upload the person and garment images"); return
    }
    if ((activeTab === "bg_remove" || activeTab === "expand" || activeTab === "upscale" || activeTab === "relight") && !imageFile) {
      toast.error("Upload an image"); return
    }

    setIsProcessing(true)
    setResultUrl(null)

    try {
      // Upload every input File via signed direct-to-storage, then send public URLs (+ settings) as JSON.
      const urls: Record<string, string> = {}
      const settings: Record<string, string> = {}

      if (activeTab === "inpaint") {
        urls.image = await signedUpload(imageFile!)
        // Mask is drawn client-side as a PNG data URL → File → signed upload (same flow as inputs).
        const maskBlob = await fetch(maskDataUrl!).then((r) => r.blob())
        const maskFile = new File([maskBlob], "mask.png", { type: "image/png" })
        urls.mask = await signedUpload(maskFile)
        settings.prompt = prompt
      } else if (activeTab === "face_swap") {
        urls.source = await signedUpload(sourceFile!)
        urls.target = await signedUpload(targetFile!)
      } else if (activeTab === "outfit") {
        urls.person = await signedUpload(personFile!)
        urls.garment = await signedUpload(garmentFile!)
      } else if (activeTab === "bg_remove" || activeTab === "upscale") {
        urls.image = await signedUpload(imageFile!)
      } else if (activeTab === "expand") {
        urls.image = await signedUpload(imageFile!)
        settings.ratio = expandRatio
        if (prompt) settings.prompt = prompt
      } else if (activeTab === "relight") {
        urls.image = await signedUpload(imageFile!)
        settings.light_direction = lightDirection
        settings.color_temp = colorTemp
      }

      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: getOperationKey(), urls, settings }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Operation failed")

      setResultUrl(data.resultUrl)
      toast.success("Done!")
      await updateSession()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error"
      toast.error(msg)
    } finally {
      setIsProcessing(false)
    }
  }

  const creditCost = getCreditCost()
  const hasEnoughCredits = userCredits >= creditCost
  const theme = themeFor(activeTab)
  const activeDef = TABS.find((t) => t.id === activeTab)

  // ── Tab Content ──

  const TabContent = () => {
    switch (activeTab) {
      case "inpaint":
        return (
          <div className="space-y-4">
            <ImageUpload
              label="Original image"
              preview={imagePreview}
              onFile={(f) => handleFileSet(f, setImageFile, setImagePreview)}
              onClear={() => { setImageFile(null); setImagePreview(null); setMaskDataUrl(null) }}
              disabled={isProcessing}
            />
            {imagePreview && (
              <MaskCanvas imageUrl={imagePreview} onMaskReady={setMaskDataUrl} />
            )}
            <div>
              <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
                Edit prompt
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                placeholder="e.g. red jacket, cloudy sky..."
                disabled={isProcessing}
                className="w-full rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 resize-none disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
            </div>
          </div>
        )

      case "face_swap":
        return (
          <div className="space-y-4">
            <ImageUpload label="Source (original face)" preview={sourcePreview}
              onFile={(f) => handleFileSet(f, setSourceFile, setSourcePreview)}
              onClear={() => { setSourceFile(null); setSourcePreview(null) }}
              disabled={isProcessing} hint="Face to replace" />
            <ImageUpload label="Target (new face)" preview={targetPreview}
              onFile={(f) => handleFileSet(f, setTargetFile, setTargetPreview)}
              onClear={() => { setTargetFile(null); setTargetPreview(null) }}
              disabled={isProcessing} hint="New face" />
          </div>
        )

      case "outfit":
        return (
          <div className="space-y-4">
            <ImageUpload label="Person image" preview={personPreview}
              onFile={(f) => handleFileSet(f, setPersonFile, setPersonPreview)}
              onClear={() => { setPersonFile(null); setPersonPreview(null) }}
              disabled={isProcessing} hint="Full body of the person" />
            <ImageUpload label="Odjevni predmet" preview={garmentPreview}
              onFile={(f) => handleFileSet(f, setGarmentFile, setGarmentPreview)}
              onClear={() => { setGarmentFile(null); setGarmentPreview(null) }}
              disabled={isProcessing} hint="Garment on a white background" />
          </div>
        )

      case "bg_remove":
        return (
          <ImageUpload label="Image" preview={imagePreview}
            onFile={(f) => handleFileSet(f, setImageFile, setImagePreview)}
            onClear={() => { setImageFile(null); setImagePreview(null) }}
            disabled={isProcessing} hint="PNG, JPG, WebP" />
        )

      case "expand":
        return (
          <div className="space-y-4">
            <ImageUpload label="Image" preview={imagePreview}
              onFile={(f) => handleFileSet(f, setImageFile, setImagePreview)}
              onClear={() => { setImageFile(null); setImagePreview(null) }}
              disabled={isProcessing} />
            <div>
              <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
                New aspect ratio
              </label>
              <div className="flex gap-2 flex-wrap">
                {["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].map((r) => (
                  <button
                    key={r}
                    onClick={() => setExpandRatio(r)}
                    disabled={isProcessing}
                    className={[
                      "px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40",
                      expandRatio === r ? "text-white" : "text-white/40 hover:text-white",
                    ].join(" ")}
                    style={{
                      background: expandRatio === r ? "rgba(123,97,255,0.2)" : "rgba(255,255,255,0.04)",
                      border: expandRatio === r ? "1px solid rgba(123,97,255,0.5)" : "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
                Hint prompt (optional)
              </label>
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. blue sky, forest..."
                disabled={isProcessing}
                className="w-full rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
            </div>
          </div>
        )

      case "upscale":
        return (
          <div className="space-y-4">
            <ImageUpload label="Image to upscale" preview={imagePreview}
              onFile={(f) => handleFileSet(f, setImageFile, setImagePreview)}
              onClear={() => { setImageFile(null); setImagePreview(null) }}
              disabled={isProcessing} />
            <div>
              <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
                Upscale factor
              </label>
              <div className="flex gap-2">
                {(["2", "4"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setUpscaleFactor(f)}
                    disabled={isProcessing}
                    className={[
                      "flex-1 py-3 rounded-xl text-sm font-bold transition-all disabled:opacity-40",
                      upscaleFactor === f ? "text-white" : "text-white/40 hover:text-white",
                    ].join(" ")}
                    style={{
                      background: upscaleFactor === f ? "rgba(123,97,255,0.2)" : "rgba(255,255,255,0.04)",
                      border: upscaleFactor === f ? "1px solid rgba(123,97,255,0.5)" : "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    {f}x
                    <span className="block text-[10px] font-normal text-white/40 mt-0.5">
                      {f === "2" ? `${CREDITS.edit.upscale2x} QLC` : `${CREDITS.edit.upscale4x} QLC`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )

      case "relight":
        return (
          <div className="space-y-4">
            <ImageUpload label="Image" preview={imagePreview}
              onFile={(f) => handleFileSet(f, setImageFile, setImagePreview)}
              onClear={() => { setImageFile(null); setImagePreview(null) }}
              disabled={isProcessing} />
            <RelightWheel direction={lightDirection} onSelect={setLightDirection} accent={theme.accent} glow={theme.glow} />
            <div>
              <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-2">
                Color temperature ({colorTemp}K)
              </label>
              <input
                type="range" min="2000" max="10000" step="100"
                value={colorTemp}
                onChange={(e) => setColorTemp(e.target.value)}
                disabled={isProcessing}
                className="w-full"
                style={{ accentColor: theme.accent }}
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>Warm 2000K</span>
                <span className="text-white/50" style={{ color: Number(colorTemp) < 4000 ? "#f97316" : Number(colorTemp) > 7000 ? "#93c5fd" : "#e9d5ff" }}>
                  {Number(colorTemp) < 4000 ? "Warm" : Number(colorTemp) > 7000 ? "Cool" : "Neutral"}
                </span>
                <span>Cool 10000K</span>
              </div>
            </div>
          </div>
        )
    }
  }

  return (
    <div className="relative flex flex-col h-full min-h-screen">
      <QelarixBackdrop tone={theme.tone} />

      <div className="relative z-10 flex flex-col lg:flex-row flex-1 min-h-0">
        {/* Controls */}
        <aside
          className="flex flex-col w-full lg:w-[380px] flex-shrink-0 overflow-y-auto backdrop-blur-xl"
          style={{ background: "rgba(8,8,12,0.55)", borderRight: "1px solid rgba(255,255,255,0.08)" }}
        >
          <div className="p-6 space-y-6">
            {/* Tool header */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em]" style={{ color: theme.accent }}>
                Image tool
              </div>
              <h1 className="text-2xl font-bold text-white mt-1.5">{activeDef?.label}</h1>
              <p className="text-white/55 text-sm mt-1">{activeDef?.desc}</p>
            </div>

            <TabContent />

            {/* Price */}
            <div
              className="rounded-xl p-3.5"
              style={{
                background: hasEnoughCredits ? "rgba(255,255,255,0.04)" : "rgba(239,68,68,0.08)",
                border: `1px solid ${hasEnoughCredits ? "rgba(255,255,255,0.1)" : "rgba(239,68,68,0.3)"}`,
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-white/60 text-xs">Operation price</span>
                <span className="text-sm font-bold" style={{ color: hasEnoughCredits ? theme.accent : "#F87171" }}>
                  {creditCost} QLC
                </span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-white/35 text-[11px]">Your QLC</span>
                <span className={`text-xs ${hasEnoughCredits ? "text-white/60" : "text-red-400"}`}>
                  {userCredits.toLocaleString()}
                </span>
              </div>
            </div>

            {/* Process button: one solid accent colour */}
            <button
              onClick={handleProcess}
              disabled={isProcessing || !hasEnoughCredits}
              className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-45 disabled:cursor-not-allowed hover:brightness-110 active:scale-[0.98]"
              style={{ background: theme.accent, color: theme.accentText, boxShadow: isProcessing ? "none" : `0 10px 32px -10px ${theme.glow}` }}
            >
              {isProcessing ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Processing...
                </span>
              ) : (
                `Apply ${activeDef?.label ?? ""}`
              )}
            </button>

            {resultUrl && (
              <button
                onClick={clearFiles}
                className="w-full py-2.5 rounded-xl text-xs text-white/60 hover:text-white transition-colors"
                style={{ border: "1px solid rgba(255,255,255,0.12)" }}
              >
                New operation
              </button>
            )}

            <p className="text-white/35 text-[11px] text-center">
              QLC is charged only if the operation succeeds
            </p>
          </div>
        </aside>

        {/* Result area */}
        <main className="flex-1 flex items-center justify-center p-6 lg:p-10 overflow-y-auto">
          {isProcessing ? (
            <div className="text-center">
              <div
                className="w-24 h-24 rounded-3xl mx-auto mb-6 flex items-center justify-center animate-pulse backdrop-blur-md"
                style={{ color: theme.accent, background: "rgba(255,255,255,0.05)", border: `1px solid ${theme.accent}`, boxShadow: `0 0 60px -6px ${theme.glow}` }}
              >
                <span className="[&>svg]:w-10 [&>svg]:h-10">{activeDef?.icon}</span>
              </div>
              <h3 className="text-white font-semibold text-lg mb-2">Processing your image</h3>
              <p className="text-white/55 text-sm">This usually takes a few seconds</p>
            </div>
          ) : resultUrl ? (
            <ResultViewer url={resultUrl} onNew={clearFiles} theme={theme} />
          ) : (
            <div className="text-center max-w-sm">
              <div
                className="w-24 h-24 rounded-3xl mx-auto mb-6 flex items-center justify-center backdrop-blur-md"
                style={{ color: theme.accent, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: `0 0 70px -10px ${theme.glow}` }}
              >
                <span className="[&>svg]:w-10 [&>svg]:h-10">{activeDef?.icon}</span>
              </div>
              <h2 className="text-white font-semibold text-xl">{activeDef?.label}</h2>
              <p className="text-white/55 text-sm mt-2">Upload an image on the left, set the options and apply.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
