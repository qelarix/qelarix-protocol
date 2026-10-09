"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { toast } from "sonner"

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "idle" | "uploading" | "pending" | "processing" | "done" | "error"
type ActiveColumn = "library" | "generator" | "preview"

interface CharacterDesc {
  text: string
  style: string
  outfit: string
  background: string
  pose: string
}

interface SavedCharacter {
  id: string
  name: string
  description: string | null
  reference_images: string[]
  type: string
  created_at: string
}

const STYLES = ["Realistic", "Cinematic", "Anime", "3D"] as const
type StyleType = (typeof STYLES)[number]

const STYLE_ICONS: Record<StyleType, string> = {
  Realistic: "📷",
  Cinematic: "🎬",
  Anime: "✨",
  "3D": "🎮",
}

// ─── Parse character description ──────────────────────────────────────────────

function parseDesc(raw: string | null): CharacterDesc {
  if (!raw) return { text: "", style: "Realistic", outfit: "", background: "", pose: "" }
  try {
    return JSON.parse(raw) as CharacterDesc
  } catch {
    return { text: raw, style: "Realistic", outfit: "", background: "", pose: "" }
  }
}

// ─── Library Card ──────────────────────────────────────────────────────────────

function LibraryCard({
  character,
  onEdit,
  onDelete,
}: {
  character: SavedCharacter
  onEdit: (c: SavedCharacter) => void
  onDelete: (id: string) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const desc = parseDesc(character.description)
  const previewUrl = character.reference_images[0] ?? null

  const handleDelete = async () => {
    if (!confirm(`Delete "${character.name}"?`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/character/${character.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      onDelete(character.id)
      toast.success("Character deleted")
    } catch {
      toast.error("Could not delete the character")
      setDeleting(false)
    }
  }

  return (
    <div
      className="rounded-xl overflow-hidden group relative"
      style={{ background: "#0d0d14", border: "1px solid rgba(255,255,255,0.08)" }}
    >
      {/* Preview image */}
      <div className="aspect-square relative overflow-hidden bg-black/30">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={character.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-4xl opacity-30">👤</span>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
          <button
            onClick={() => onEdit(character)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:scale-105"
            style={{ background: "rgba(123,97,255,0.9)" }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
            </svg>
            Edit
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:scale-105 disabled:opacity-50"
            style={{ background: "rgba(239,68,68,0.8)" }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            {deleting ? "..." : "Delete"}
          </button>
        </div>

        {/* Style badge */}
        {desc.style && (
          <span
            className="absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded-full"
            style={{ background: "rgba(0,0,0,0.7)", color: "#A78BFA", border: "1px solid rgba(123,97,255,0.4)" }}
          >
            {STYLE_ICONS[desc.style as StyleType] ?? ""} {desc.style}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-3">
        <div className="text-white font-semibold text-sm truncate">{character.name}</div>
        {desc.text && (
          <div className="text-white/40 text-xs mt-0.5 truncate">{desc.text}</div>
        )}
        <div className="text-white/25 text-xs mt-1">
          {new Date(character.created_at).toLocaleDateString("en-GB")}
        </div>
      </div>
    </div>
  )
}

// ─── Reference Photo Slot ─────────────────────────────────────────────────────

function ReferenceSlot({
  index,
  url,
  uploading,
  onFile,
  onRemove,
}: {
  index: number
  url: string | null
  uploading: boolean
  onFile: (file: File, index: number) => void
  onRemove: (index: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div
      className="relative aspect-square rounded-xl overflow-hidden cursor-pointer group"
      style={{
        background: url ? "transparent" : "rgba(255,255,255,0.03)",
        border: url ? "1.5px solid rgba(123,97,255,0.5)" : "2px dashed rgba(255,255,255,0.12)",
      }}
      onClick={() => !url && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file, index)
          e.target.value = ""
        }}
      />

      {uploading ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg className="animate-spin w-5 h-5 text-purple-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
      ) : url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={`Reference ${index + 1}`} className="w-full h-full object-cover" />
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(index) }}
            className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <svg className="w-5 h-5 text-white/25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-white/25 text-[10px]">Ref {index + 1}</span>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CharacterPage() {
  const { data: session } = useAuthSession()
  const credits = session?.user?.credits ?? 0

  // Library
  const [characters, setCharacters] = useState<SavedCharacter[]>([])
  const [loadingLibrary, setLoadingLibrary] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Form fields
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [style, setStyle] = useState<StyleType>("Realistic")
  const [outfit, setOutfit] = useState("")
  const [background, setBackground] = useState("")
  const [pose, setPose] = useState("")

  // Reference photos (up to 3)
  const [refUrls, setRefUrls] = useState<(string | null)[]>([null, null, null])
  const [refUploading, setRefUploading] = useState<boolean[]>([false, false, false])

  // Generation state
  const [phase, setPhase] = useState<Phase>("idle")
  const [progress, setProgress] = useState(0)
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)
  const [savingCharacter, setSavingCharacter] = useState(false)

  // Mobile column view
  const [activeColumn, setActiveColumn] = useState<ActiveColumn>("generator")

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const CREDIT_COST = 15
  const hasEnoughCredits = credits >= CREDIT_COST
  const isGenerating = phase === "pending" || phase === "processing"

  // ── Load library ────────────────────────────────────────────────────────────

  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/character")
      if (!res.ok) throw new Error()
      const data = await res.json() as { characters: SavedCharacter[] }
      setCharacters(data.characters)
    } catch {
      toast.error("Could not load the library")
    } finally {
      setLoadingLibrary(false)
    }
  }, [])

  useEffect(() => { loadLibrary() }, [loadLibrary])

  // ── Poll generation status ──────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const pollStatus = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`/api/character/generate/status/${jobId}`)
        const data = await res.json() as {
          status: string
          output_url?: string
          progress?: number
          error?: string
        }

        if (data.status === "completed" && data.output_url) {
          stopPolling()
          setGeneratedUrl(data.output_url)
          setPhase("done")
          setProgress(100)
          toast.success("Character generated!")
          setActiveColumn("preview")
        } else if (data.status === "failed") {
          stopPolling()
          setPhase("error")
          toast.error(data.error ?? "Generation failed")
        } else {
          setProgress(data.progress ?? 30)
        }
      } catch {
        stopPolling()
        setPhase("error")
        toast.error("Could not check the status")
      }
    },
    [stopPolling],
  )

  useEffect(() => () => stopPolling(), [stopPolling])

  // ── Handle reference photo upload ───────────────────────────────────────────

  const handleRefFile = async (file: File, index: number) => {
    setRefUploading((prev) => {
      const next = [...prev]
      next[index] = true
      return next
    })

    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("folder", "character-refs")

      const res = await fetch("/api/upload", { method: "POST", body: formData })
      const data = await res.json() as { url?: string; error?: string }

      if (!res.ok || !data.url) throw new Error(data.error ?? "Upload failed")

      setRefUrls((prev) => {
        const next = [...prev]
        next[index] = data.url!
        return next
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setRefUploading((prev) => {
        const next = [...prev]
        next[index] = false
        return next
      })
    }
  }

  const handleRemoveRef = (index: number) => {
    setRefUrls((prev) => {
      const next = [...prev]
      next[index] = null
      return next
    })
  }

  // ── Handle generation ───────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!name.trim()) { toast.error("Enter a character name"); return }
    if (!description.trim()) { toast.error("Enter a character description"); return }
    if (!hasEnoughCredits) { toast.error(`Not enough QLC. You need ${CREDIT_COST}, you have ${credits}.`); return }

    stopPolling()
    setPhase("pending")
    setProgress(5)
    setGeneratedUrl(null)

    const primaryRef = refUrls.find((u) => u !== null) ?? undefined

    try {
      const res = await fetch("/api/character/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          style,
          outfit: outfit.trim(),
          background: background.trim(),
          pose: pose.trim(),
          referenceImageUrl: primaryRef,
        }),
      })

      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok) {
        setPhase("error")
        toast.error(data.error ?? "Could not start the generation")
        return
      }

      setPhase("processing")
      setProgress(20)
      pollRef.current = setInterval(() => pollStatus(data.jobId!), 3000)
    } catch {
      setPhase("error")
      toast.error("Could not send the request")
    }
  }

  // ── Handle save character ────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!name.trim()) { toast.error("Enter a character name"); return }
    setSavingCharacter(true)

    const uploadedRefs = refUrls.filter((u) => u !== null) as string[]

    try {
      const isEditing = editingId !== null
      const url = isEditing ? `/api/character/${editingId}` : "/api/character"
      const method = isEditing ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          style,
          outfit: outfit.trim(),
          background: background.trim(),
          pose: pose.trim(),
          referenceImages: uploadedRefs,
          generatedImageUrl: generatedUrl ?? undefined,
        }),
      })

      const data = await res.json() as { character?: SavedCharacter; error?: string }
      if (!res.ok) {
        toast.error(data.error ?? "Could not save the character")
        return
      }

      if (isEditing) {
        setCharacters((prev) => prev.map((c) => c.id === editingId ? data.character! : c))
        toast.success("Character updated!")
      } else {
        setCharacters((prev) => [data.character!, ...prev])
        toast.success("Character saved to your library!")
      }

      resetForm()
      setActiveColumn("library")
    } catch {
      toast.error("Could not save the character")
    } finally {
      setSavingCharacter(false)
    }
  }

  // ── Edit from library ────────────────────────────────────────────────────────

  const handleEdit = (character: SavedCharacter) => {
    const desc = parseDesc(character.description)
    setEditingId(character.id)
    setName(character.name)
    setDescription(desc.text)
    setStyle((desc.style as StyleType) ?? "Realistic")
    setOutfit(desc.outfit ?? "")
    setBackground(desc.background ?? "")
    setPose(desc.pose ?? "")

    // Populate refs (skip first if it was a generated image — show all)
    const refs: (string | null)[] = [null, null, null]
    character.reference_images.slice(0, 3).forEach((url, i) => { refs[i] = url })
    setRefUrls(refs)

    setGeneratedUrl(null)
    setPhase("idle")
    setActiveColumn("generator")
  }

  const resetForm = () => {
    setEditingId(null)
    setName("")
    setDescription("")
    setStyle("Realistic")
    setOutfit("")
    setBackground("")
    setPose("")
    setRefUrls([null, null, null])
    setGeneratedUrl(null)
    setPhase("idle")
    setProgress(0)
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen pt-16 lg:pt-0">
      {/* Mobile tab bar */}
      <div
        className="flex lg:hidden border-b border-white/8"
        style={{ background: "#0d0d14" }}
      >
        {(["library", "generator", "preview"] as ActiveColumn[]).map((col) => (
          <button
            key={col}
            onClick={() => setActiveColumn(col)}
            className="flex-1 py-3 text-xs font-semibold capitalize transition-colors"
            style={{
              color: activeColumn === col ? "#A78BFA" : "rgba(255,255,255,0.4)",
              borderBottom: activeColumn === col ? "2px solid #7B61FF" : "2px solid transparent",
            }}
          >
            {col === "library" ? `Biblioteka (${characters.length})` : col === "generator" ? "Generator" : "Preview"}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── COLUMN 1: Library ─────────────────────────────────────────────── */}
        <div
          className={[
            "w-full lg:w-[260px] flex-shrink-0 flex flex-col border-r border-white/8 overflow-hidden",
            activeColumn === "library" ? "flex" : "hidden lg:flex",
          ].join(" ")}
          style={{ background: "#050505" }}
        >
          <div className="p-4 border-b border-white/8 flex items-center justify-between flex-shrink-0">
            <div>
              <h2 className="text-white font-bold text-sm">Biblioteka</h2>
              <p className="text-white/40 text-xs">{characters.length} karaktera</p>
            </div>
            <button
              onClick={resetForm}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:scale-105"
              style={{ background: "rgba(123,97,255,0.2)", border: "1px solid rgba(123,97,255,0.3)" }}
              title="New character"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              New
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {loadingLibrary ? (
              <div className="grid grid-cols-2 gap-2">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="aspect-square rounded-xl animate-pulse"
                    style={{ background: "rgba(255,255,255,0.05)" }}
                  />
                ))}
              </div>
            ) : characters.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <span className="text-4xl mb-3 opacity-30">👥</span>
                <p className="text-white/30 text-xs">No saved characters</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {characters.map((character) => (
                  <LibraryCard
                    key={character.id}
                    character={character}
                    onEdit={handleEdit}
                    onDelete={(id) => setCharacters((prev) => prev.filter((c) => c.id !== id))}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── COLUMN 2: Generator Form ──────────────────────────────────────── */}
        <div
          className={[
            "w-full lg:w-[380px] flex-shrink-0 flex flex-col border-r border-white/8 overflow-hidden",
            activeColumn === "generator" ? "flex" : "hidden lg:flex",
          ].join(" ")}
          style={{ background: "#0d0d14" }}
        >
          <div className="p-4 border-b border-white/8 flex-shrink-0">
            <div className="flex items-center gap-2">
              <div>
                <h1 className="text-white font-bold text-base">
                  {editingId ? "Edit character" : "Character Generator"}
                </h1>
                <p className="text-white/40 text-xs mt-0.5">FLUX Kontext Pro · 15 credits</p>
              </div>
              {editingId && (
                <button
                  onClick={resetForm}
                  className="ml-auto text-xs text-white/40 hover:text-white/70 transition-colors px-2 py-1 rounded"
                >
                  Odustani
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Name */}
            <div>
              <label className="text-white/60 text-xs font-semibold uppercase tracking-widest block mb-1.5">
                Character name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sofia, Marcus, Dragon Queen..."
                maxLength={100}
                className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
            </div>

            {/* Reference Photos */}
            <div>
              <label className="text-white/60 text-xs font-semibold uppercase tracking-widest block mb-1.5">
                Reference images (up to 3)
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[0, 1, 2].map((i) => (
                  <ReferenceSlot
                    key={i}
                    index={i}
                    url={refUrls[i]}
                    uploading={refUploading[i]}
                    onFile={handleRefFile}
                    onRemove={handleRemoveRef}
                  />
                ))}
              </div>
              <p className="text-white/30 text-xs mt-1.5">
                The first image is used as the reference for generation
              </p>
            </div>

            {/* Description */}
            <div>
              <label className="text-white/60 text-xs font-semibold uppercase tracking-widest block mb-1.5">
                Character description *
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe appearance, personality, distinctive traits..."
                rows={4}
                maxLength={800}
                className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-white/30 resize-none focus:outline-none"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
              <div className="text-right text-white/25 text-xs mt-1">{description.length}/800</div>
            </div>

            {/* Style Pills */}
            <div>
              <label className="text-white/60 text-xs font-semibold uppercase tracking-widest block mb-1.5">
                Style
              </label>
              <div className="flex gap-2 flex-wrap">
                {STYLES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStyle(s)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all"
                    style={{
                      background: style === s ? "rgba(123,97,255,0.3)" : "rgba(255,255,255,0.05)",
                      border: style === s ? "1.5px solid rgba(123,97,255,0.7)" : "1px solid rgba(255,255,255,0.1)",
                      color: style === s ? "#C4B5FD" : "rgba(255,255,255,0.5)",
                    }}
                  >
                    <span>{STYLE_ICONS[s]}</span>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Outfit */}
            <div>
              <label className="text-white/60 text-xs font-semibold uppercase tracking-widest block mb-1.5">
                Outfit
              </label>
              <input
                type="text"
                value={outfit}
                onChange={(e) => setOutfit(e.target.value)}
                placeholder="e.g. black leather jacket, fantasy armor, casual outfit..."
                maxLength={200}
                className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
            </div>

            {/* Background */}
            <div>
              <label className="text-white/60 text-xs font-semibold uppercase tracking-widest block mb-1.5">
                Background
              </label>
              <input
                type="text"
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                placeholder="e.g. cyberpunk city, forest, neutral studio, castle..."
                maxLength={200}
                className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
            </div>

            {/* Pose */}
            <div>
              <label className="text-white/60 text-xs font-semibold uppercase tracking-widest block mb-1.5">
                Pose
              </label>
              <input
                type="text"
                value={pose}
                onChange={(e) => setPose(e.target.value)}
                placeholder="e.g. front portrait, dynamic action, seated..."
                maxLength={200}
                className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
            </div>
          </div>

          {/* Bottom actions */}
          <div className="p-4 border-t border-white/8 space-y-2 flex-shrink-0">
            {/* Credit info */}
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-white/40">Generation cost</span>
              <div className="flex items-center gap-3">
                <span className="text-white font-bold">{CREDIT_COST} kr</span>
                <span className={`font-semibold ${hasEnoughCredits ? "text-green-400" : "text-red-400"}`}>
                  Balance: {credits.toLocaleString()} QLC
                </span>
              </div>
            </div>

            {!hasEnoughCredits && (
              <div
                className="rounded-lg p-2 text-xs text-center"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)", color: "#F87171" }}
              >
                Not enough QLC. You need {CREDIT_COST - credits} more.
              </div>
            )}

            {/* Generate button */}
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !hasEnoughCredits || !name.trim() || !description.trim()}
              className="w-full py-3 rounded-xl font-bold text-white text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 hover:scale-[1.01] active:scale-[0.98]"
              style={{
                background: isGenerating
                  ? "rgba(123,97,255,0.4)"
                  : "linear-gradient(135deg, #7B61FF, #3BE7FF)",
                boxShadow: isGenerating ? "none" : "0 0 20px rgba(123,97,255,0.35)",
              }}
            >
              {isGenerating ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Generating... {progress}%
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.847a4.5 4.5 0 003.09 3.09L15.75 12l-2.847.813a4.5 4.5 0 00-3.09 3.09z" />
                  </svg>
                  Generate character · 15 QLC
                </span>
              )}
            </button>

            {/* Save button */}
            <button
              onClick={handleSave}
              disabled={savingCharacter || !name.trim()}
              className="w-full py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.8)",
              }}
            >
              {savingCharacter ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Saving...
                </span>
              ) : editingId ? (
                "Save changes"
              ) : (
                "Save to library"
              )}
            </button>
          </div>
        </div>

        {/* ── COLUMN 3: Preview ─────────────────────────────────────────────── */}
        <div
          className={[
            "flex-1 flex flex-col overflow-hidden",
            activeColumn === "preview" ? "flex" : "hidden lg:flex",
          ].join(" ")}
          style={{ background: "#050505" }}
        >
          <div className="p-4 border-b border-white/8 flex-shrink-0">
            <h2 className="text-white font-bold text-sm">Preview</h2>
            <p className="text-white/40 text-xs mt-0.5">Generated character</p>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {/* Progress bar */}
            {isGenerating && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white/60 text-sm">
                    {phase === "pending" ? "Sending request..." : "Generating character..."}
                  </span>
                  <span className="text-white/60 text-sm">{progress}%</span>
                </div>
                <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${progress}%`, background: "linear-gradient(90deg, #7B61FF, #3BE7FF)" }}
                  />
                </div>
                <p className="text-white/30 text-xs mt-2 text-center">
                  FLUX Kontext Pro generation can take 15-60 seconds...
                </p>
              </div>
            )}

            {/* Error state */}
            {phase === "error" && (
              <div
                className="rounded-xl p-6 mb-6 text-center"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
              >
                <div className="text-4xl mb-3">⚠️</div>
                <p className="text-red-400 font-semibold mb-2">Generation failed</p>
                <p className="text-white/40 text-sm mb-4">No credits were charged. Please try again.</p>
                <button
                  onClick={() => setPhase("idle")}
                  className="px-5 py-2 rounded-lg text-sm font-semibold text-white"
                  style={{ background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.3)" }}
                >
                  Try again
                </button>
              </div>
            )}

            {/* Generated image */}
            {generatedUrl && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-bold text-base">{name || "Karakter"}</h3>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs px-2.5 py-1 rounded-full font-semibold"
                      style={{ background: "rgba(123,97,255,0.2)", color: "#A78BFA", border: "1px solid rgba(123,97,255,0.3)" }}
                    >
                      {STYLE_ICONS[style]} {style}
                    </span>
                  </div>
                </div>

                <div
                  className="relative rounded-2xl overflow-hidden group"
                  style={{ border: "1px solid rgba(123,97,255,0.3)" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={generatedUrl}
                    alt={name}
                    className="w-full h-auto block"
                  />

                  {/* Image overlay actions */}
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                    <a
                      href={generatedUrl}
                      download={`${name || "character"}-${Date.now()}.jpg`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all hover:scale-105"
                      style={{ background: "rgba(123,97,255,0.9)" }}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Preuzmi
                    </a>
                    <button
                      onClick={handleSave}
                      disabled={savingCharacter}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all hover:scale-105 disabled:opacity-50"
                      style={{ background: "rgba(255,255,255,0.15)" }}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 16v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2h2m3-4H9a2 2 0 00-2 2v7a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-1m-1 4l-3 3m0 0l-3-3m3 3V3" />
                      </svg>
                      {savingCharacter ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>

                {/* Character details */}
                <div className="mt-4 space-y-2">
                  {description && (
                    <div className="flex gap-2 text-xs">
                      <span className="text-white/30 shrink-0">Opis:</span>
                      <span className="text-white/60">{description}</span>
                    </div>
                  )}
                  {outfit && (
                    <div className="flex gap-2 text-xs">
                      <span className="text-white/30 shrink-0">Outfit:</span>
                      <span className="text-white/60">{outfit}</span>
                    </div>
                  )}
                  {background && (
                    <div className="flex gap-2 text-xs">
                      <span className="text-white/30 shrink-0">Background:</span>
                      <span className="text-white/60">{background}</span>
                    </div>
                  )}
                  {pose && (
                    <div className="flex gap-2 text-xs">
                      <span className="text-white/30 shrink-0">Poza:</span>
                      <span className="text-white/60">{pose}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Empty state */}
            {!isGenerating && !generatedUrl && phase !== "error" && (
              <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                <div
                  className="w-24 h-24 rounded-2xl flex items-center justify-center text-5xl mb-5"
                  style={{ background: "rgba(123,97,255,0.08)", border: "1px solid rgba(123,97,255,0.15)" }}
                >
                  👤
                </div>
                <h3 className="text-white font-bold text-xl mb-2">Create your character</h3>
                <p className="text-white/40 text-sm max-w-xs leading-relaxed">
                  Enter a name and description, pick a style and click &ldquo;Generate character&rdquo;.
                  FLUX Kontext Pro creates a high-quality portrait.
                </p>

                <div className="mt-8 grid grid-cols-2 gap-3 w-full max-w-sm">
                  {[
                    { name: "Sofia", desc: "Elven warrior with blue eyes", style: "Anime" },
                    { name: "Marcus", desc: "Middle-aged cyberpunk detective", style: "Cinematic" },
                    { name: "Lyra", desc: "Sorceress with long red hair", style: "Realistic" },
                    { name: "Rex-7", desc: "Robot soldier with AI visors", style: "3D" },
                  ].map((example) => (
                    <button
                      key={example.name}
                      onClick={() => {
                        setName(example.name)
                        setDescription(example.desc)
                        setStyle(example.style as StyleType)
                        setActiveColumn("generator")
                      }}
                      className="p-3 rounded-xl text-left transition-all hover:scale-[1.02]"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-sm">{STYLE_ICONS[example.style as StyleType]}</span>
                        <span className="text-white font-semibold text-xs">{example.name}</span>
                      </div>
                      <p className="text-white/40 text-xs leading-tight">{example.desc}</p>
                      <span
                        className="inline-block mt-1.5 text-[10px] px-2 py-0.5 rounded-full"
                        style={{ background: "rgba(123,97,255,0.15)", color: "#A78BFA" }}
                      >
                        {example.style}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
