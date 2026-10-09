"use client"

import { useEffect, useRef, useState } from "react"
import { useAuthSession } from "@/components/providers/AuthSessionProvider"
import { toast } from "sonner"
import type { BrandKit } from "@/types/database"
import { PLAN_GATING_ENABLED, type PlanId } from "@/lib/plans"
import dynamic from "next/dynamic"

const SubscriptionModal = dynamic(
  () => import("@/components/landing/SubscriptionModal"),
  { ssr: false },
)

// ─── Types ───────────────────────────────────────────────────────────────────

const PLAN_KIT_LIMITS: Record<PlanId, number | "∞"> = {
  free: 0,
  starter: 1,
  pro: 3,
  business: Infinity,
  ultra: Infinity,
}

const FONT_OPTIONS = [
  "Inter", "Roboto", "Playfair Display", "Montserrat", "Lato",
  "Raleway", "Poppins", "Open Sans", "Merriweather", "Space Grotesk",
]

interface KitFormState {
  name: string
  primary_color: string
  secondary_color: string
  font: string
  style_description: string
  logo_url: string
  is_default: boolean
}

const DEFAULT_FORM: KitFormState = {
  name: "",
  primary_color: "#7B61FF",
  secondary_color: "#3BE7FF",
  font: "Inter",
  style_description: "",
  logo_url: "",
  is_default: false,
}

// ─── Color Picker ─────────────────────────────────────────────────────────────

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <div
          className="w-10 h-10 rounded-lg flex-shrink-0 cursor-pointer overflow-hidden relative"
          style={{ border: "1px solid rgba(255,255,255,0.15)" }}
        >
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 w-full h-full cursor-pointer opacity-0"
          />
          <div className="w-full h-full" style={{ background: value }} />
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) onChange(v)
          }}
          maxLength={7}
          className="flex-1 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
        />
      </div>
    </div>
  )
}

// ─── Kit Card ─────────────────────────────────────────────────────────────────

function KitCard({
  kit,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  kit: BrandKit
  onEdit: (kit: BrandKit) => void
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
}) {
  return (
    <div
      className="rounded-2xl p-4 transition-all hover:border-violet-500/40"
      style={{
        background: kit.is_default ? "rgba(123,97,255,0.08)" : "rgba(255,255,255,0.03)",
        border: kit.is_default ? "1px solid rgba(123,97,255,0.3)" : "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        {/* Logo / Color preview */}
        {kit.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={kit.logo_url}
            alt={kit.name}
            className="w-12 h-12 rounded-xl object-contain flex-shrink-0"
            style={{ background: "rgba(255,255,255,0.05)" }}
          />
        ) : (
          <div
            className="w-12 h-12 rounded-xl flex-shrink-0 flex items-center justify-center text-white font-bold text-lg"
            style={{ background: `linear-gradient(135deg, ${kit.primary_color ?? "#7B61FF"}, ${kit.secondary_color ?? "#3BE7FF"})` }}
          >
            {kit.name.slice(0, 1).toUpperCase()}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-white font-semibold text-sm truncate">{kit.name}</h3>
            {kit.is_default && (
              <span
                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                style={{ background: "rgba(123,97,255,0.2)", color: "#a855f7", border: "1px solid rgba(123,97,255,0.3)" }}
              >
                DEFAULT
              </span>
            )}
          </div>
          <p className="text-white/30 text-[10px] mt-0.5">{kit.font ?? "Inter"}</p>
        </div>
      </div>

      {/* Colors */}
      <div className="flex items-center gap-2 mb-3">
        <div className="text-white/25 text-[10px] w-14 flex-shrink-0">Colors</div>
        <div className="flex items-center gap-1.5">
          <div
            className="w-5 h-5 rounded-full"
            style={{ background: kit.primary_color ?? "#7B61FF", border: "1px solid rgba(255,255,255,0.15)" }}
            title={kit.primary_color ?? "Primary"}
          />
          <div
            className="w-5 h-5 rounded-full"
            style={{ background: kit.secondary_color ?? "#3BE7FF", border: "1px solid rgba(255,255,255,0.15)" }}
            title={kit.secondary_color ?? "Secondary"}
          />
          <span className="text-white/25 text-[10px] ml-1">
            {kit.primary_color} · {kit.secondary_color}
          </span>
        </div>
      </div>

      {/* Style description */}
      {kit.style_description && (
        <p className="text-white/35 text-xs mb-3 line-clamp-2">{kit.style_description}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        {!kit.is_default && (
          <button
            onClick={() => onSetDefault(kit.id)}
            className="text-[10px] text-white/30 hover:text-violet-300 transition-colors"
          >
            Set as default
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => onEdit(kit)}
          className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white transition-colors"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(kit.id)}
          className="px-3 py-1.5 rounded-lg text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// ─── Kit Modal ────────────────────────────────────────────────────────────────

function KitModal({
  kit,
  onSave,
  onClose,
}: {
  kit: BrandKit | null
  onSave: (data: KitFormState, id?: string) => Promise<void>
  onClose: () => void
}) {
  const [form, setForm] = useState<KitFormState>(
    kit ? {
      name: kit.name,
      primary_color: kit.primary_color ?? "#7B61FF",
      secondary_color: kit.secondary_color ?? "#3BE7FF",
      font: kit.font ?? "Inter",
      style_description: kit.style_description ?? "",
      logo_url: kit.logo_url ?? "",
      is_default: kit.is_default,
    } : { ...DEFAULT_FORM },
  )
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)

  const update = (patch: Partial<KitFormState>) => setForm((prev) => ({ ...prev, ...patch }))

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { toast.error("Logo must not exceed 2 MB"); return }

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("folder", "logos")
      const res = await fetch("/api/upload", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Upload failed")
      update({ logo_url: data.url })
      toast.success("Logo uploaded!")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
      e.target.value = ""
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { toast.error("Naziv je obavezan"); return }
    setSaving(true)
    try {
      await onSave(form, kit?.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: "#0f0f18", border: "1px solid rgba(255,255,255,0.1)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
          <h2 className="text-white font-semibold">{kit ? "Edit brand kit" : "New brand kit"}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto max-h-[70vh]">
          {/* Name */}
          <div>
            <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
              Brand name *
            </label>
            <input
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="e.g. My agency"
              maxLength={80}
              required
              className="w-full rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            />
          </div>

          {/* Logo */}
          <div>
            <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
              Logo
            </label>
            <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
            <div className="flex items-center gap-3">
              {form.logo_url ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.logo_url}
                    alt="Logo"
                    className="w-14 h-14 rounded-xl object-contain"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                  />
                  <button
                    type="button"
                    onClick={() => update({ logo_url: "" })}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500/80 text-white flex items-center justify-center text-xs"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: `linear-gradient(135deg, ${form.primary_color}, ${form.secondary_color})` }}
                >
                  <span className="text-white font-bold text-xl">{(form.name || "?").slice(0, 1).toUpperCase()}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => logoInputRef.current?.click()}
                disabled={uploading}
                className="flex-1 py-2.5 rounded-xl text-xs text-white/50 hover:text-white transition-colors disabled:opacity-40"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                {uploading ? "Uploading..." : "Upload logo (PNG/SVG, max 2 MB)"}
              </button>
            </div>
          </div>

          {/* Colors */}
          <ColorField label="Primary color" value={form.primary_color} onChange={(v) => update({ primary_color: v })} />
          <ColorField label="Secondary color" value={form.secondary_color} onChange={(v) => update({ secondary_color: v })} />

          {/* Font */}
          <div>
            <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
              Font
            </label>
            <select
              value={form.font}
              onChange={(e) => update({ font: e.target.value })}
              className="w-full rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500/50 appearance-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f} value={f} style={{ background: "#1a1a2e" }}>{f}</option>
              ))}
            </select>
          </div>

          {/* Style description */}
          <div>
            <label className="text-white/40 text-[10px] font-semibold uppercase tracking-widest block mb-1.5">
              Style description (for AI)
            </label>
            <textarea
              value={form.style_description}
              onChange={(e) => update({ style_description: e.target.value })}
              rows={3}
              placeholder="e.g. Minimalist style, premium look, dark colors with lilac accents..."
              maxLength={300}
              className="w-full rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 resize-none focus:outline-none focus:ring-1 focus:ring-violet-500/50"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <div className="flex justify-between mt-0.5">
              <p className="text-white/20 text-[10px]">Used as context in AI prompts</p>
              <span className="text-white/20 text-[10px]">{form.style_description.length}/300</span>
            </div>
          </div>

          {/* Default toggle */}
          <div
            className="flex items-center justify-between rounded-xl px-3 py-2.5 cursor-pointer"
            style={{
              background: form.is_default ? "rgba(123,97,255,0.08)" : "rgba(255,255,255,0.03)",
              border: form.is_default ? "1px solid rgba(123,97,255,0.25)" : "1px solid rgba(255,255,255,0.07)",
            }}
            onClick={() => update({ is_default: !form.is_default })}
          >
            <div>
              <div className="text-xs font-medium text-white">Set as default</div>
              <div className="text-[10px] text-white/30">Apply automatically to all generations</div>
            </div>
            <div
              className="w-9 h-5 rounded-full transition-all relative flex-shrink-0"
              style={{ background: form.is_default ? "#7B61FF" : "rgba(255,255,255,0.1)" }}
            >
              <div
                className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm"
                style={{ left: form.is_default ? "calc(100% - 18px)" : "3px" }}
              />
            </div>
          </div>

          {/* Preview */}
          <div>
            <div className="text-white/40 text-[10px] font-semibold uppercase tracking-widest mb-2">Preview</div>
            <div
              className="rounded-xl p-4 flex items-center gap-3"
              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <div
                className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center text-white font-bold"
                style={{ background: `linear-gradient(135deg, ${form.primary_color}, ${form.secondary_color})` }}
              >
                {(form.name || "?").slice(0, 1).toUpperCase()}
              </div>
              <div>
                <div className="text-white text-sm font-semibold" style={{ fontFamily: form.font }}>
                  {form.name || "Brand name"}
                </div>
                <div className="text-white/30 text-xs" style={{ fontFamily: form.font }}>
                  {form.font} · {form.primary_color}
                </div>
              </div>
              <div className="flex-1" />
              <div className="flex gap-1.5">
                <div className="w-4 h-4 rounded-full" style={{ background: form.primary_color }} />
                <div className="w-4 h-4 rounded-full" style={{ background: form.secondary_color }} />
              </div>
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={saving || uploading || !form.name.trim()}
            className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
          >
            {saving ? "Saving..." : kit ? "Save changes" : "Create brand kit"}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── Locked Overlay ───────────────────────────────────────────────────────────

function LockedOverlay({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
        style={{ background: "rgba(123,97,255,0.15)", border: "1px solid rgba(123,97,255,0.3)" }}
      >
        <svg className="w-8 h-8 text-violet-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 1C8.676 1 6 3.676 6 7v1H4v15h16V8h-2V7c0-3.324-2.676-6-6-6zm0 2c2.276 0 4 1.724 4 4v1H8V7c0-2.276 1.724-4 4-4zm0 9a2 2 0 110 4 2 2 0 010-4z" />
        </svg>
      </div>
      <h3 className="text-white font-bold text-lg mb-1">Starter+ plan required</h3>
      <p className="text-white/40 text-sm max-w-xs mb-5">
        Brand kits are available from the Starter plan. Define your visual identity and apply it automatically to every AI generation.
      </p>
      <button
        onClick={onUpgrade}
        className="px-6 py-2.5 rounded-xl text-white font-semibold text-sm hover:opacity-90 transition-all"
        style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
      >
        Upgrade plan →
      </button>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BrandKitPage() {
  const { data: session } = useAuthSession()
  const userPlan = (session?.user?.plan ?? "free") as PlanId
  const isLocked = PLAN_GATING_ENABLED && userPlan === "free"
  const maxKits = PLAN_GATING_ENABLED ? PLAN_KIT_LIMITS[userPlan] : Infinity

  const [kits, setKits] = useState<BrandKit[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingKit, setEditingKit] = useState<BrandKit | null>(null)
  const [showUpgradeModal, setShowUpgradeModal] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    if (!session?.user?.id) return
    fetch("/api/brand-kit")
      .then((r) => r.json())
      .then((d) => { if (d.kits) setKits(d.kits) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [session?.user?.id])

  const openCreate = () => {
    if (isLocked) { setShowUpgradeModal(true); return }
    if (maxKits !== Infinity && kits.length >= (maxKits as number)) {
      toast.error(`Your plan allows up to ${maxKits} brand kit${(maxKits as number) !== 1 ? "s" : ""}. Upgrade for more.`)
      return
    }
    setEditingKit(null)
    setShowModal(true)
  }

  const handleSave = async (data: KitFormState, id?: string) => {
    const method = id ? "PUT" : "POST"
    const url = id ? `/api/brand-kit/${id}` : "/api/brand-kit"

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? "Request failed")

    if (id) {
      setKits((prev) => prev.map((k) => k.id === id ? json.kit : (data.is_default ? { ...k, is_default: false } : k)))
      toast.success("Brand kit updated!")
    } else {
      // If new kit is default, unset others
      setKits((prev) => [json.kit, ...(data.is_default ? prev.map((k) => ({ ...k, is_default: false })) : prev)])
      toast.success("Brand kit created!")
    }
    setShowModal(false)
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this brand kit?")) return
    setDeleting(id)
    try {
      const res = await fetch(`/api/brand-kit/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? "Request failed")
      }
      setKits((prev) => prev.filter((k) => k.id !== id))
      toast.success("Brand kit deleted")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed")
    } finally {
      setDeleting(null)
    }
  }

  const handleSetDefault = async (id: string) => {
    try {
      const res = await fetch(`/api/brand-kit/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_default: true }),
      })
      if (!res.ok) throw new Error("Request failed")
      setKits((prev) => prev.map((k) => ({ ...k, is_default: k.id === id })))
      toast.success("Default kit changed")
    } catch {
      toast.error("Could not set the default kit")
    }
  }

  const canCreateMore = maxKits === Infinity || kits.length < (maxKits as number)

  return (
    <>
      <div className="min-h-screen" style={{ background: "#050505" }}>
        {/* Header */}
        <div
          className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between"
          style={{
            background: "rgba(10,10,15,0.95)",
            backdropFilter: "blur(12px)",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div>
            <h1 className="text-white font-bold text-lg">Brand Kit</h1>
            <p className="text-white/30 text-xs">
              {isLocked ? "Starter+ plan required" : `${kits.length} / ${maxKits === Infinity ? "∞" : maxKits} kits`}
            </p>
          </div>

          {!isLocked && (
            <button
              onClick={openCreate}
              disabled={!canCreateMore}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
              style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              New brand kit
            </button>
          )}
        </div>

        <div className="max-w-4xl mx-auto px-5 py-6">
          {isLocked ? (
            <LockedOverlay onUpgrade={() => setShowUpgradeModal(true)} />
          ) : loading ? (
            <div className="flex justify-center py-20">
              <svg className="w-6 h-6 animate-spin text-violet-400/40" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
            </div>
          ) : kits.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                style={{ background: "rgba(123,97,255,0.08)", border: "1px solid rgba(123,97,255,0.15)" }}
              >
                <svg className="w-8 h-8 text-violet-400/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
                </svg>
              </div>
              <h3 className="text-white/40 font-medium mb-1">No brand kits yet</h3>
              <p className="text-white/20 text-sm mb-5">Create your first brand kit and apply your visual identity automatically</p>
              <button
                onClick={openCreate}
                className="px-5 py-2.5 rounded-xl text-sm font-medium text-white hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
              >
                + Create brand kit
              </button>
            </div>
          ) : (
            <>
              {/* Info banner */}
              <div
                className="rounded-xl p-3.5 mb-5 flex items-start gap-3"
                style={{ background: "rgba(123,97,255,0.06)", border: "1px solid rgba(123,97,255,0.15)" }}
              >
                <svg className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
                <p className="text-white/40 text-xs">
                  The brand kit marked <strong className="text-violet-300">DEFAULT</strong> is added automatically as context to every AI generation.
                  Tick &ldquo;Apply brand kit&rdquo; in the generation forms.
                </p>
              </div>

              {/* Kit grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {kits.map((kit) => (
                  <div key={kit.id} className={deleting === kit.id ? "opacity-50 pointer-events-none" : ""}>
                    <KitCard
                      kit={kit}
                      onEdit={(k) => { setEditingKit(k); setShowModal(true) }}
                      onDelete={handleDelete}
                      onSetDefault={handleSetDefault}
                    />
                  </div>
                ))}

                {/* Add more card */}
                {canCreateMore && (
                  <button
                    onClick={openCreate}
                    className="rounded-2xl flex flex-col items-center justify-center gap-2 p-6 transition-all hover:border-violet-500/40 min-h-[160px]"
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "2px dashed rgba(255,255,255,0.1)",
                    }}
                  >
                    <svg className="w-8 h-8 text-white/15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    <span className="text-white/25 text-sm">Add brand kit</span>
                  </button>
                )}
              </div>

              {/* Plan limit info */}
              {!canCreateMore && maxKits !== Infinity && (
                <div
                  className="mt-5 rounded-xl p-4 flex items-center gap-3"
                  style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.15)" }}
                >
                  <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                  <p className="text-white/40 text-sm">
                    You have reached the limit of {maxKits} brand kit{(maxKits as number) !== 1 ? "s" : ""} for your plan.
                    <button onClick={() => setShowUpgradeModal(true)} className="text-violet-400 hover:text-violet-300 ml-1 underline">
                      Upgrade for more →
                    </button>
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showModal && (
        <KitModal
          kit={editingKit}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditingKit(null) }}
        />
      )}

      <SubscriptionModal isOpen={showUpgradeModal} onClose={() => setShowUpgradeModal(false)} />
    </>
  )
}
