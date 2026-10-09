"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { toast } from "sonner"
import Konva from "konva"
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Text as KonvaText,
  Rect,
  Transformer,
} from "react-konva"
import useImage from "use-image"
import jsPDF from "jspdf"

// ─── Types ────────────────────────────────────────────────────────────────────

type Tool = "select" | "text" | "shape" | "sticky"

interface CanvasItem {
  id: string
  type: "image" | "text" | "rect" | "sticky"
  x: number
  y: number
  width?: number
  height?: number
  src?: string
  text?: string
  fill?: string
  fontSize?: number
  rotation?: number
  scaleX?: number
  scaleY?: number
  draggable: boolean
  zIndex?: number
}

type MoodboardTemplate = {
  id: string
  name: string
  emoji: string
  items: Omit<CanvasItem, "id">[]
}

// ─── Moodboard Templates ──────────────────────────────────────────────────────

const TEMPLATES: MoodboardTemplate[] = [
  {
    id: "minimal",
    name: "Minimalist",
    emoji: "⬜",
    items: [
      { type: "rect", x: 80, y: 80, width: 300, height: 200, fill: "#1a1a2e", draggable: true },
      { type: "rect", x: 420, y: 80, width: 200, height: 200, fill: "#16213e", draggable: true },
      { type: "text", x: 80, y: 320, text: "MINIMALIST MOODBOARD", fontSize: 24, fill: "#ffffff", draggable: true },
      { type: "sticky", x: 420, y: 320, width: 200, height: 120, text: "Clean. Simple. Bold.", fill: "#fef08a", draggable: true },
    ],
  },
  {
    id: "vibrant",
    name: "Vibrant",
    emoji: "🌈",
    items: [
      { type: "rect", x: 60, y: 60, width: 240, height: 160, fill: "#7B61FF", draggable: true },
      { type: "rect", x: 320, y: 60, width: 160, height: 160, fill: "#3BE7FF", draggable: true },
      { type: "rect", x: 500, y: 60, width: 120, height: 160, fill: "#EC4899", draggable: true },
      { type: "text", x: 60, y: 250, text: "VIBRANT ENERGY", fontSize: 28, fill: "#7B61FF", draggable: true },
      { type: "sticky", x: 60, y: 310, width: 200, height: 100, text: "Bold colors, bold ideas.", fill: "#fecdd3", draggable: true },
    ],
  },
  {
    id: "editorial",
    name: "Editorial",
    emoji: "📰",
    items: [
      { type: "rect", x: 60, y: 60, width: 560, height: 8, fill: "#000000", draggable: true },
      { type: "text", x: 60, y: 90, text: "EDITORIAL", fontSize: 48, fill: "#050505", draggable: true },
      { type: "rect", x: 60, y: 160, width: 260, height: 180, fill: "#f3f4f6", draggable: true },
      { type: "rect", x: 340, y: 160, width: 280, height: 80, fill: "#e5e7eb", draggable: true },
      { type: "sticky", x: 340, y: 260, width: 280, height: 80, text: "Story. Style. Statement.", fill: "#fef9c3", draggable: true },
    ],
  },
]

// ─── AI Side Panel ────────────────────────────────────────────────────────────

function AISidePanel({
  onAddImage,
  onClose,
}: {
  onAddImage: (url: string) => void
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState("")
  const [generating, setGenerating] = useState(false)
  const [results, setResults] = useState<string[]>([])

  const generate = async () => {
    if (!prompt.trim()) return
    setGenerating(true)
    try {
      const res = await fetch("/api/generate/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sd35",
          prompt: prompt.trim(),
          aspectRatio: "1:1",
          numImages: 1,
          quality: "standard",
        }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? "Generation failed"); return }

      // Poll for result
      const jobId = data.jobId
      let attempts = 0
      const poll = setInterval(async () => {
        attempts++
        if (attempts > 30) { clearInterval(poll); setGenerating(false); toast.error("Timeout"); return }
        const s = await fetch(`/api/generate/image/status/${jobId}`)
        const sd = await s.json()
        if (sd.status === "completed" && sd.output_urls?.length) {
          clearInterval(poll)
          setResults((prev) => [...sd.output_urls, ...prev])
          setGenerating(false)
          toast.success("Image generated!")
        } else if (sd.status === "failed") {
          clearInterval(poll)
          setGenerating(false)
          toast.error("Generation failed")
        }
      }, 3000)
    } catch {
      toast.error("Generation failed")
      setGenerating(false)
    }
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: "#0d0d14", borderRight: "1px solid rgba(255,255,255,0.08)" }}
    >
      <div className="p-4 border-b border-white/8 flex items-center justify-between">
        <div>
          <h3 className="text-white font-bold text-sm">AI Images</h3>
          <p className="text-white/40 text-xs">Generate and add to the canvas</p>
        </div>
        <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors p-1">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="p-3 border-b border-white/8">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image..."
          rows={3}
          className="w-full rounded-lg px-3 py-2 text-xs text-white placeholder-white/30 resize-none focus:outline-none"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
        />
        <button
          onClick={generate}
          disabled={generating || !prompt.trim()}
          className="mt-2 w-full py-2 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
        >
          {generating ? "Generating..." : "Generate"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {results.length === 0 && !generating && (
          <p className="text-white/30 text-xs text-center py-8">Generated images will appear here</p>
        )}
        {generating && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full" />
          </div>
        )}
        {results.map((url, i) => (
          <div key={i} className="relative group rounded-lg overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="w-full h-auto block rounded-lg" />
            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <button
                onClick={() => { onAddImage(url); toast.success("Added to the canvas") }}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white"
                style={{ background: "rgba(123,97,255,0.9)" }}
              >
                + Canvas
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Konva Image Item ─────────────────────────────────────────────────────────

function CanvasImageNode({
  item,
  isSelected,
  onSelect,
  onChange,
}: {
  item: CanvasItem
  isSelected: boolean
  onSelect: () => void
  onChange: (attrs: Partial<CanvasItem>) => void
}) {
  const [image] = useImage(item.src ?? "", "anonymous")
  const ref = useRef<Konva.Image>(null)
  const trRef = useRef<Konva.Transformer>(null)

  useEffect(() => {
    if (isSelected && trRef.current && ref.current) {
      trRef.current.nodes([ref.current])
      trRef.current.getLayer()?.batchDraw()
    }
  }, [isSelected])

  return (
    <>
      <KonvaImage
        ref={ref}
        image={image}
        x={item.x}
        y={item.y}
        width={item.width ?? 300}
        height={item.height ?? 200}
        rotation={item.rotation ?? 0}
        scaleX={item.scaleX ?? 1}
        scaleY={item.scaleY ?? 1}
        draggable={item.draggable}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
        onTransformEnd={(e) => {
          const node = e.target
          onChange({
            x: node.x(),
            y: node.y(),
            rotation: node.rotation(),
            scaleX: node.scaleX(),
            scaleY: node.scaleY(),
          })
        }}
      />
      {isSelected && (
        <Transformer
          ref={trRef}
          boundBoxFunc={(_, newBox) => newBox}
        />
      )}
    </>
  )
}

// ─── Konva Text Item ──────────────────────────────────────────────────────────

function CanvasTextNode({
  item,
  isSelected,
  onSelect,
  onChange,
}: {
  item: CanvasItem
  isSelected: boolean
  onSelect: () => void
  onChange: (attrs: Partial<CanvasItem>) => void
}) {
  const ref = useRef<Konva.Text>(null)
  const trRef = useRef<Konva.Transformer>(null)

  useEffect(() => {
    if (isSelected && trRef.current && ref.current) {
      trRef.current.nodes([ref.current])
      trRef.current.getLayer()?.batchDraw()
    }
  }, [isSelected])

  return (
    <>
      <KonvaText
        ref={ref}
        x={item.x}
        y={item.y}
        text={item.text ?? "Tekst"}
        fontSize={item.fontSize ?? 20}
        fill={item.fill ?? "#ffffff"}
        rotation={item.rotation ?? 0}
        scaleX={item.scaleX ?? 1}
        scaleY={item.scaleY ?? 1}
        draggable={item.draggable}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
        onTransformEnd={(e) => {
          const node = e.target
          onChange({
            x: node.x(),
            y: node.y(),
            rotation: node.rotation(),
            scaleX: node.scaleX(),
            scaleY: node.scaleY(),
          })
        }}
        onDblClick={() => {
          const newText = prompt("Edit text:", item.text ?? "")
          if (newText !== null) onChange({ text: newText })
        }}
      />
      {isSelected && (
        <Transformer ref={trRef} boundBoxFunc={(_, newBox) => newBox} />
      )}
    </>
  )
}

// ─── Konva Rect Item ──────────────────────────────────────────────────────────

function CanvasRectNode({
  item,
  isSelected,
  onSelect,
  onChange,
}: {
  item: CanvasItem
  isSelected: boolean
  onSelect: () => void
  onChange: (attrs: Partial<CanvasItem>) => void
}) {
  const ref = useRef<Konva.Rect>(null)
  const trRef = useRef<Konva.Transformer>(null)

  useEffect(() => {
    if (isSelected && trRef.current && ref.current) {
      trRef.current.nodes([ref.current])
      trRef.current.getLayer()?.batchDraw()
    }
  }, [isSelected])

  return (
    <>
      <Rect
        ref={ref}
        x={item.x}
        y={item.y}
        width={item.width ?? 200}
        height={item.height ?? 150}
        fill={item.fill ?? "#7B61FF"}
        rotation={item.rotation ?? 0}
        scaleX={item.scaleX ?? 1}
        scaleY={item.scaleY ?? 1}
        draggable={item.draggable}
        cornerRadius={item.type === "sticky" ? 8 : 0}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
        onTransformEnd={(e) => {
          const node = e.target as Konva.Rect
          onChange({
            x: node.x(),
            y: node.y(),
            width: Math.max(20, node.width() * node.scaleX()),
            height: Math.max(20, node.height() * node.scaleY()),
            rotation: node.rotation(),
            scaleX: 1,
            scaleY: 1,
          })
          node.scaleX(1)
          node.scaleY(1)
        }}
      />
      {item.type === "sticky" && (
        <KonvaText
          x={item.x + 10}
          y={item.y + 10}
          width={(item.width ?? 200) - 20}
          text={item.text ?? "Nota..."}
          fontSize={13}
          fill="#1a1a1a"
          listening={false}
        />
      )}
      {isSelected && (
        <Transformer ref={trRef} boundBoxFunc={(_, newBox) => newBox} />
      )}
    </>
  )
}

// ─── Share Link Modal ─────────────────────────────────────────────────────────

function ShareModal({ shareUrl, onClose }: { shareUrl: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative rounded-2xl p-6 w-full max-w-md"
        style={{ background: "#0d0d14", border: "1px solid rgba(255,255,255,0.12)" }}
      >
        <h3 className="text-white font-bold text-lg mb-2">Share canvas</h3>
        <p className="text-white/40 text-sm mb-4">Send the link to clients or your team (Agency plan)</p>
        <div
          className="flex items-center gap-2 px-4 py-3 rounded-xl mb-4"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
        >
          <span className="text-white/60 text-sm flex-1 truncate">{shareUrl}</span>
          <button
            onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("Link kopiran!") }}
            className="text-xs font-bold px-3 py-1.5 rounded-lg flex-shrink-0 text-white"
            style={{ background: "rgba(123,97,255,0.5)" }}
          >
            Copy
          </button>
        </div>
        <button onClick={onClose} className="w-full py-2.5 rounded-xl text-sm font-semibold text-white/60 hover:text-white transition-colors"
          style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
          Close
        </button>
      </div>
    </div>
  )
}

// ─── Main Canvas App ──────────────────────────────────────────────────────────

export default function CanvasApp() {
  const { data: session } = useAuthSession()
  const userPlan = (session?.user?.plan as string) ?? "free"

  const stageRef = useRef<Konva.Stage>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [items, setItems] = useState<CanvasItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>("select")
  const [showAIPanel, setShowAIPanel] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [stageSize, setStageSize] = useState({ width: 1200, height: 800 })
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 })
  const [stageScale, setStageScale] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const [lastPointerPos, setLastPointerPos] = useState({ x: 0, y: 0 })

  const nextId = useCallback(() => `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, [])

  // Resize observer
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setStageSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    setStageSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Keyboard: delete selected
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        const tag = (e.target as HTMLElement).tagName
        if (tag === "INPUT" || tag === "TEXTAREA") return
        setItems((prev) => prev.filter((i) => i.id !== selectedId))
        setSelectedId(null)
      }
      if (e.key === "Escape") setSelectedId(null)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [selectedId])

  const updateItem = useCallback((id: string, attrs: Partial<CanvasItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...attrs } : item)))
  }, [])

  const addItem = useCallback((partial: Omit<CanvasItem, "id">) => {
    const id = nextId()
    setItems((prev) => [...prev, { ...partial, id }])
    setSelectedId(id)
  }, [nextId])

  const addText = () => {
    addItem({ type: "text", x: 200 + Math.random() * 200, y: 150 + Math.random() * 150, text: "New text", fontSize: 24, fill: "#ffffff", draggable: true })
    setTool("select")
  }

  const addShape = () => {
    addItem({ type: "rect", x: 200 + Math.random() * 200, y: 150 + Math.random() * 150, width: 200, height: 140, fill: "#7B61FF", draggable: true })
    setTool("select")
  }

  const addSticky = () => {
    addItem({ type: "sticky", x: 200 + Math.random() * 200, y: 150 + Math.random() * 150, width: 200, height: 130, fill: "#fef08a", text: "Sticky note...", draggable: true })
    setTool("select")
  }

  const addAIImage = (url: string) => {
    addItem({ type: "image", x: 100 + Math.random() * 300, y: 80 + Math.random() * 200, width: 300, height: 200, src: url, draggable: true })
  }

  const loadTemplate = (tpl: MoodboardTemplate) => {
    const newItems = tpl.items.map((item) => ({ ...item, id: nextId() }))
    setItems(newItems)
    setSelectedId(null)
    setShowTemplates(false)
    toast.success(`Template "${tpl.name}" loaded`)
  }

  // Pan & zoom
  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const scaleBy = 1.08
    const oldScale = stageScale
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    }
    const newScale = e.evt.deltaY < 0 ? oldScale * scaleBy : oldScale / scaleBy
    const clamped = Math.min(Math.max(newScale, 0.1), 5)
    setStageScale(clamped)
    setStagePos({
      x: pointer.x - mousePointTo.x * clamped,
      y: pointer.y - mousePointTo.y * clamped,
    })
  }

  const handleStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target === stageRef.current) {
      setSelectedId(null)
      if (tool === "select") {
        setIsPanning(true)
        const pos = stageRef.current?.getPointerPosition()
        if (pos) setLastPointerPos(pos)
      }
    }
    if (tool === "text") addText()
    if (tool === "shape") addShape()
    if (tool === "sticky") addSticky()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleStageMouseMove = (_e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!isPanning) return
    const pos = stageRef.current?.getPointerPosition()
    if (!pos) return
    setStagePos((prev) => ({
      x: prev.x + (pos.x - lastPointerPos.x),
      y: prev.y + (pos.y - lastPointerPos.y),
    }))
    setLastPointerPos(pos)
  }

  const handleStageMouseUp = () => setIsPanning(false)

  // Export PNG
  const exportPNG = () => {
    const stage = stageRef.current
    if (!stage) return
    const saved = { x: stage.x(), y: stage.y(), scale: stageScale }
    stage.x(0); stage.y(0); stage.scale({ x: 1, y: 1 })
    const dataURL = stage.toDataURL({ pixelRatio: 2 })
    stage.x(saved.x); stage.y(saved.y); stage.scale({ x: saved.scale, y: saved.scale })
    const a = document.createElement("a")
    a.href = dataURL
    a.download = `canvas-${Date.now()}.png`
    a.click()
    toast.success("PNG eksportiran!")
  }

  // Export PDF
  const exportPDF = () => {
    const stage = stageRef.current
    if (!stage) return
    const saved = { x: stage.x(), y: stage.y(), scale: stageScale }
    stage.x(0); stage.y(0); stage.scale({ x: 1, y: 1 })
    const dataURL = stage.toDataURL({ pixelRatio: 2 })
    stage.x(saved.x); stage.y(saved.y); stage.scale({ x: saved.scale, y: saved.scale })
    const pdf = new jsPDF({ orientation: "landscape", unit: "px", format: [stageSize.width * 2, stageSize.height * 2] })
    pdf.addImage(dataURL, "PNG", 0, 0, stageSize.width * 2, stageSize.height * 2)
    pdf.save(`canvas-${Date.now()}.pdf`)
    toast.success("PDF eksportiran!")
  }

  // Share link (Agency)
  const handleShare = () => {
    if (userPlan !== "agency") {
      toast.error("Share links are available on the Agency plan only")
      return
    }
    setShowShare(true)
  }

  const shareUrl = typeof window !== "undefined"
    ? `${window.location.origin}/canvas/share/${Date.now().toString(36)}`
    : ""

  const toolButtons: { id: Tool; label: string; icon: React.ReactNode; action?: () => void }[] = [
    {
      id: "select",
      label: "Select",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 6.85-3.286.395zm-7.518-.986L3 14.489l4.817-1.938-1.293 8.135z" />
        </svg>
      ),
    },
    {
      id: "text",
      label: "Text",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
        </svg>
      ),
    },
    {
      id: "shape",
      label: "Shape",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
        </svg>
      ),
    },
    {
      id: "sticky",
      label: "Sticky",
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
        </svg>
      ),
    },
  ]

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: "#050505" }}>
      {/* ── Top Bar ─────────────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 py-2 flex-shrink-0 z-20"
        style={{ background: "#0d0d14", borderBottom: "1px solid rgba(255,255,255,0.08)", height: 52 }}
      >
        {/* Title */}
        <div className="flex items-center gap-2 mr-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-base"
            style={{ background: "rgba(123,97,255,0.2)", border: "1px solid rgba(123,97,255,0.3)" }}
          >
            🎨
          </div>
          <span className="text-white font-bold text-sm hidden sm:block">Canvas</span>
        </div>

        {/* Tool buttons */}
        <div
          className="flex items-center gap-1 rounded-xl p-1"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          {toolButtons.map((btn) => (
            <button
              key={btn.id}
              onClick={() => setTool(btn.id)}
              title={btn.label}
              className="relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: tool === btn.id ? "rgba(123,97,255,0.3)" : "transparent",
                color: tool === btn.id ? "#A78BFA" : "rgba(255,255,255,0.5)",
                border: tool === btn.id ? "1px solid rgba(123,97,255,0.5)" : "1px solid transparent",
              }}
            >
              {btn.icon}
              <span className="hidden md:block">{btn.label}</span>
            </button>
          ))}
        </div>

        {/* AI Images button */}
        <button
          onClick={() => setShowAIPanel(!showAIPanel)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{
            background: showAIPanel ? "rgba(123,97,255,0.3)" : "rgba(255,255,255,0.04)",
            border: showAIPanel ? "1px solid rgba(123,97,255,0.5)" : "1px solid rgba(255,255,255,0.08)",
            color: showAIPanel ? "#A78BFA" : "rgba(255,255,255,0.6)",
          }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
          <span className="hidden md:block">AI Images</span>
        </button>

        {/* Templates */}
        <button
          onClick={() => setShowTemplates(!showTemplates)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
          </svg>
          <span className="hidden md:block">Templates</span>
        </button>

        <div className="flex-1" />

        {/* Zoom indicator */}
        <span className="text-white/30 text-xs hidden sm:block">{Math.round(stageScale * 100)}%</span>

        {/* Zoom reset */}
        <button
          onClick={() => { setStageScale(1); setStagePos({ x: 0, y: 0 }) }}
          title="Reset zoom"
          className="p-1.5 rounded-lg text-white/40 hover:text-white/80 transition-colors"
          style={{ border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" />
          </svg>
        </button>

        {/* Export PNG */}
        <button
          onClick={exportPNG}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all text-white/70 hover:text-white"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          PNG
        </button>

        {/* Export PDF */}
        <button
          onClick={exportPDF}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all text-white/70 hover:text-white"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          PDF
        </button>

        {/* Share */}
        <button
          onClick={handleShare}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all text-white"
          style={{
            background: userPlan === "agency" ? "linear-gradient(135deg,#7B61FF,#3BE7FF)" : "rgba(255,255,255,0.05)",
            border: userPlan === "agency" ? "none" : "1px solid rgba(255,255,255,0.08)",
            color: userPlan === "agency" ? "#fff" : "rgba(255,255,255,0.3)",
          }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
          </svg>
          <span className="hidden md:block">Share</span>
        </button>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* AI Panel */}
        {showAIPanel && (
          <div className="w-64 flex-shrink-0 flex flex-col overflow-hidden">
            <AISidePanel onAddImage={addAIImage} onClose={() => setShowAIPanel(false)} />
          </div>
        )}

        {/* Canvas */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden"
          style={{
            background: "radial-gradient(ellipse at 50% 50%, rgba(123,97,255,0.04) 0%, #050505 70%)",
            cursor: isPanning ? "grabbing" : tool === "select" ? "grab" : "crosshair",
          }}
        >
          {/* Grid bg hint */}
          <div
            className="absolute inset-0 pointer-events-none opacity-20"
            style={{
              backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.15) 1px, transparent 1px)",
              backgroundSize: "32px 32px",
              backgroundPosition: `${stagePos.x % 32}px ${stagePos.y % 32}px`,
            }}
          />

          <Stage
            ref={stageRef}
            width={stageSize.width}
            height={stageSize.height}
            x={stagePos.x}
            y={stagePos.y}
            scaleX={stageScale}
            scaleY={stageScale}
            onWheel={handleWheel}
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleStageMouseMove}
            onMouseUp={handleStageMouseUp}
            onTouchStart={() => setSelectedId(null)}
          >
            <Layer>
              {items.map((item) => {
                const isSelected = selectedId === item.id
                if (item.type === "image") {
                  return (
                    <CanvasImageNode
                      key={item.id}
                      item={item}
                      isSelected={isSelected}
                      onSelect={() => setSelectedId(item.id)}
                      onChange={(attrs) => updateItem(item.id, attrs)}
                    />
                  )
                }
                if (item.type === "text") {
                  return (
                    <CanvasTextNode
                      key={item.id}
                      item={item}
                      isSelected={isSelected}
                      onSelect={() => setSelectedId(item.id)}
                      onChange={(attrs) => updateItem(item.id, attrs)}
                    />
                  )
                }
                if (item.type === "rect" || item.type === "sticky") {
                  return (
                    <CanvasRectNode
                      key={item.id}
                      item={item}
                      isSelected={isSelected}
                      onSelect={() => setSelectedId(item.id)}
                      onChange={(attrs) => updateItem(item.id, attrs)}
                    />
                  )
                }
                return null
              })}
            </Layer>
          </Stage>

          {/* Empty state */}
          {items.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl mb-4"
                style={{ background: "rgba(123,97,255,0.1)", border: "1px solid rgba(123,97,255,0.2)" }}
              >
                🎨
              </div>
              <h3 className="text-white font-bold text-xl mb-2">Canvas empty</h3>
              <p className="text-white/40 text-sm text-center max-w-xs">
                Choose a tool from the toolbar, generate an AI image, or load a moodboard template.
              </p>
              <div className="flex gap-2 mt-5 pointer-events-auto">
                <button
                  onClick={() => setShowTemplates(true)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:scale-105"
                  style={{ background: "rgba(123,97,255,0.2)", border: "1px solid rgba(123,97,255,0.4)" }}
                >
                  Load template
                </button>
                <button
                  onClick={() => setShowAIPanel(true)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:scale-105"
                  style={{ background: "linear-gradient(135deg,#7B61FF,#3BE7FF)" }}
                >
                  AI images
                </button>
              </div>
            </div>
          )}

          {/* Selected item hint */}
          {selectedId && (
            <div
              className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl text-xs text-white/60 flex items-center gap-3"
              style={{ background: "rgba(13,13,20,0.9)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(8px)" }}
            >
              <span>Drag to move • Transform to resize • Double-click to edit text</span>
              <button
                onClick={() => { setItems((prev) => prev.filter((i) => i.id !== selectedId)); setSelectedId(null) }}
                className="text-red-400 hover:text-red-300 transition-colors font-semibold"
              >
                Delete
              </button>
            </div>
          )}
        </div>

        {/* Properties panel for selected item */}
        {selectedId && (() => {
          const item = items.find((i) => i.id === selectedId)
          if (!item) return null
          return (
            <div
              className="w-52 flex-shrink-0 flex flex-col overflow-y-auto"
              style={{ background: "#0d0d14", borderLeft: "1px solid rgba(255,255,255,0.08)" }}
            >
              <div className="p-4 border-b border-white/8">
                <h4 className="text-white/60 text-xs font-semibold uppercase tracking-widest">Properties</h4>
              </div>
              <div className="p-4 space-y-4">
                {/* Fill color for rect/sticky/text */}
                {(item.type === "rect" || item.type === "sticky" || item.type === "text") && (
                  <div>
                    <label className="text-white/40 text-xs block mb-1">Color</label>
                    <input
                      type="color"
                      value={item.fill ?? "#7B61FF"}
                      onChange={(e) => updateItem(item.id, { fill: e.target.value })}
                      className="w-full h-9 rounded-lg cursor-pointer"
                      style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)" }}
                    />
                  </div>
                )}
                {/* Font size for text */}
                {item.type === "text" && (
                  <div>
                    <label className="text-white/40 text-xs block mb-1">Font size</label>
                    <input
                      type="range"
                      min={10}
                      max={120}
                      value={item.fontSize ?? 20}
                      onChange={(e) => updateItem(item.id, { fontSize: Number(e.target.value) })}
                      className="w-full accent-violet-500"
                    />
                    <span className="text-white/40 text-xs">{item.fontSize ?? 20}px</span>
                  </div>
                )}
                {/* Sticky text edit */}
                {item.type === "sticky" && (
                  <div>
                    <label className="text-white/40 text-xs block mb-1">Text</label>
                    <textarea
                      value={item.text ?? ""}
                      onChange={(e) => updateItem(item.id, { text: e.target.value })}
                      rows={4}
                      className="w-full rounded-lg px-2 py-2 text-xs text-white resize-none focus:outline-none"
                      style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                    />
                  </div>
                )}
                {/* Delete */}
                <button
                  onClick={() => { setItems((prev) => prev.filter((i) => i.id !== selectedId)); setSelectedId(null) }}
                  className="w-full py-2 rounded-lg text-xs font-semibold transition-all text-red-400 hover:bg-red-500/10"
                  style={{ border: "1px solid rgba(239,68,68,0.2)" }}
                >
                  Delete element
                </button>
              </div>
            </div>
          )
        })()}
      </div>

      {/* ── Templates Modal ──────────────────────────────────────────────────── */}
      {showTemplates && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowTemplates(false)} />
          <div
            className="relative rounded-2xl p-6 w-full max-w-lg"
            style={{ background: "#0d0d14", border: "1px solid rgba(255,255,255,0.12)" }}
          >
            <h3 className="text-white font-bold text-lg mb-1">Moodboard Templates</h3>
            <p className="text-white/40 text-sm mb-5">Choose a template and customize it for yourself</p>
            <div className="grid grid-cols-3 gap-3 mb-5">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => loadTemplate(tpl)}
                  className="rounded-xl p-4 text-center transition-all hover:scale-105"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <div className="text-3xl mb-2">{tpl.emoji}</div>
                  <div className="text-white font-semibold text-sm">{tpl.name}</div>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowTemplates(false)}
              className="w-full py-2.5 rounded-xl text-sm text-white/50 hover:text-white transition-colors"
              style={{ border: "1px solid rgba(255,255,255,0.08)" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Share Modal ──────────────────────────────────────────────────────── */}
      {showShare && <ShareModal shareUrl={shareUrl} onClose={() => setShowShare(false)} />}
    </div>
  )
}
