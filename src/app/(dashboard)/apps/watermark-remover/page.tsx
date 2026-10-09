"use client"

import { useState, useRef, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"

type JobStatus = "idle" | "pending" | "processing" | "completed" | "failed"

const CREDIT_COST = 30

export default function WatermarkRemoverPage() {
  const [videoUrl, setVideoUrl] = useState("")
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<JobStatus>("idle")
  const [progress, setProgress] = useState(0)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.startsWith("video/")) {
      setError("Please select a video file.")
      return
    }
    setUploadFile(file)
    setPreviewUrl(URL.createObjectURL(file))
    setVideoUrl("")
    setError(null)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file) handleFileSelect(file)
    },
    [handleFileSelect],
  )

  const uploadVideo = async (): Promise<string | null> => {
    if (!uploadFile) return videoUrl || null
    setUploading(true)
    try {
      // Qelarix standard signed direct-to-storage upload (replaces the old FormData → /api/upload →
      // "media" bucket path, which 404s and hits the Vercel body cap). Tiny JSON request authorizes a
      // signed URL; the file is PUT straight to Supabase (generations bucket) — never through a Next route.
      const signRes = await fetch("/api/upload/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadFile.name, contentType: uploadFile.type, sizeBytes: uploadFile.size }),
      })
      const sign = await signRes.json().catch(() => ({}))
      if (!signRes.ok || !sign?.signedUrl || !sign?.publicUrl) throw new Error(sign?.error || "Upload failed")
      const putRes = await fetch(sign.signedUrl as string, {
        method: "PUT",
        headers: { "Content-Type": uploadFile.type, "x-upsert": "false" },
        body: uploadFile,
      })
      if (!putRes.ok) throw new Error("Upload failed")
      return sign.publicUrl as string
    } catch {
      setError("Video upload failed. Try again.")
      return null
    } finally {
      setUploading(false)
    }
  }

  const pollStatus = useCallback((id: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/tools/watermark-remover/status/${id}`)
        const data = await res.json()

        setProgress(data.progress ?? 0)

        if (data.status === "completed") {
          clearInterval(pollRef.current!)
          setStatus("completed")
          setOutputUrl(data.output_url)
        } else if (data.status === "failed") {
          clearInterval(pollRef.current!)
          setStatus("failed")
          setError(data.error_message ?? "Generation failed")
        } else {
          setStatus(data.status === "processing" ? "processing" : "pending")
        }
      } catch {
        // network hiccup — keep polling
      }
    }, 4000)
  }, [])

  const handleGenerate = async () => {
    setError(null)
    setOutputUrl(null)
    setProgress(0)

    const resolvedUrl = await uploadVideo()
    if (!resolvedUrl) return

    setStatus("pending")

    try {
      const res = await fetch("/api/tools/watermark-remover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_url: resolvedUrl }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Could not start watermark removal")
        setStatus("idle")
        return
      }
      setJobId(data.jobId)
      pollStatus(data.jobId)
    } catch {
      setError("Could not send the request")
      setStatus("idle")
    }
  }

  const handleReset = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    setStatus("idle")
    setJobId(null)
    setProgress(0)
    setOutputUrl(null)
    setError(null)
    setUploadFile(null)
    setPreviewUrl(null)
    setVideoUrl("")
  }

  const isGenerating = status === "pending" || status === "processing"

  return (
    <div className="min-h-screen bg-[#050505] text-white p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">🚫</span>
            <div>
              <h1 className="text-2xl font-bold">Watermark Remover</h1>
              <p className="text-gray-400 text-sm">Remove watermarks from video content using AI</p>
            </div>
            <span className="ml-auto px-3 py-1 rounded-full text-xs font-semibold bg-violet-600/20 text-violet-400 border border-violet-500/30">
              MUAPI Tool
            </span>
          </div>
          <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-400 text-xs">
            Use only to remove watermarks from videos you own or have the right to use.
          </div>
        </motion.div>

        <div className="grid gap-6">
          {/* Upload / URL Input */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-[#12121a] border border-white/10 rounded-2xl p-6"
          >
            <h2 className="text-sm font-semibold text-gray-300 mb-4 uppercase tracking-wider">
              Watermarked Video
            </h2>

            {/* Drop zone */}
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-white/20 rounded-xl p-8 text-center cursor-pointer hover:border-violet-500/50 transition-colors mb-4"
            >
              {previewUrl ? (
                <video
                  src={previewUrl}
                  className="max-h-48 mx-auto rounded-lg"
                  controls
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <div className="text-4xl mb-2">🎥</div>
                  <p className="text-gray-400 text-sm">
                    Drop a video here or <span className="text-violet-400">click to upload</span>
                  </p>
                  <p className="text-gray-600 text-xs mt-1">MP4, MOV, WebM — max 100MB</p>
                </>
              )}
            </div>
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

            <div className="relative">
              <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-500 text-xs">
                or URL:
              </div>
              <input
                type="url"
                value={videoUrl}
                onChange={(e) => { setVideoUrl(e.target.value); setUploadFile(null); setPreviewUrl(null) }}
                placeholder="https://..."
                className="w-full bg-[#1a1a2e] border border-white/10 rounded-lg pl-16 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-violet-500/50"
              />
            </div>
          </motion.div>

          {/* Info card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-[#12121a] border border-white/10 rounded-2xl p-5"
          >
            <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
              How it works
            </h2>
            <div className="grid grid-cols-3 gap-3">
              {[
                { step: "1", icon: "📤", text: "Upload a watermarked video" },
                { step: "2", icon: "🤖", text: "AI analyzes and removes the watermark" },
                { step: "3", icon: "✅", text: "Download the clean video" },
              ].map(({ step, icon, text }) => (
                <div key={step} className="bg-white/5 rounded-xl p-3 text-center">
                  <div className="text-2xl mb-1">{icon}</div>
                  <p className="text-xs text-gray-400">{text}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-3">
              Price: <span className="text-violet-400 font-semibold">{CREDIT_COST} QLC</span> per video
            </p>
          </motion.div>

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Generate Button */}
          {(status === "idle" || status === "failed") && (
            <motion.button
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              onClick={handleGenerate}
              disabled={!videoUrl && !uploadFile}
              className="w-full py-4 rounded-2xl font-semibold text-lg bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {uploading ? "Uploading..." : `Remove Watermark — ${CREDIT_COST} QLC`}
            </motion.button>
          )}

          {/* Progress */}
          <AnimatePresence>
            {isGenerating && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="bg-[#12121a] border border-white/10 rounded-2xl p-6"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-gray-400">
                    {status === "processing" ? "AI is removing the watermark..." : "Queued..."}
                  </span>
                  <span className="text-sm font-semibold text-violet-400">{progress}%</span>
                </div>
                <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-violet-600 to-purple-500 rounded-full"
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
                <p className="text-xs text-gray-600 mt-3 text-center">
                  Usually takes 30–90 seconds
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Result */}
          <AnimatePresence>
            {status === "completed" && outputUrl && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-[#12121a] border border-violet-500/30 rounded-2xl p-6"
              >
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-green-400">✓</span>
                  <h3 className="font-semibold">Watermark removed!</h3>
                </div>
                <video
                  src={outputUrl}
                  controls
                  className="w-full rounded-xl mb-4"
                />
                <div className="flex gap-3">
                  <a
                    href={outputUrl}
                    download
                    className="flex-1 py-3 rounded-xl text-center bg-violet-600 hover:bg-violet-500 font-medium transition-colors text-sm"
                  >
                    Download Video
                  </a>
                  <button
                    onClick={handleReset}
                    className="flex-1 py-3 rounded-xl bg-white/5 hover:bg-white/10 font-medium transition-colors text-sm"
                  >
                    New Video
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
