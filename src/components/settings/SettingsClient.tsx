"use client"

import { useState, useRef } from "react"
import Image from "next/image"
import type { PlanId } from "@/lib/plans"
import type { Profile, CreditTransaction } from "@/types/database"
import { shortWalletAddress } from "@/lib/walletIdentity"
import QlcSpending from "@/components/payments/QlcSpending"
import QlcTopUp from "@/components/payments/QlcTopUp"
import { QLC_COLORS } from "@/components/payments/qlcUi"
import QelarixBackdrop from "@/components/ui/QelarixBackdrop"

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "profile" | "plan" | "api" | "notifications" | "security"

interface Props {
  userId: string
  /** Solana wallet the account signs in with. */
  walletAddress: string
  profile: Profile | null
  transactions: CreditTransaction[]
  plan: PlanId
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Sub-components ───────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors"
      style={{
        background: checked ? QLC_COLORS.accent : "rgba(255,255,255,0.1)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <span
        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(20px)" : "translateX(0)" }}
      />
    </button>
  )
}

function SaveButton({
  loading,
  saved,
  onClick,
}: {
  loading: boolean
  saved: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-[filter,opacity] disabled:opacity-60 hover:brightness-110 active:brightness-95"
      style={{
        background: saved ? "rgba(16,185,129,0.2)" : QLC_COLORS.accent,
        border: saved ? "1px solid rgba(16,185,129,0.4)" : "none",
        color: saved ? "#34d399" : "white",
      }}
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Saving...
        </span>
      ) : saved ? (
        "Saved"
      ) : (
        "Save changes"
      )}
    </button>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="px-4 py-3 rounded-xl text-sm text-red-300"
      style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
    >
      {message}
    </div>
  )
}

function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl p-6 ${className ?? ""}`}
      style={{
        background: "rgba(30, 25, 21, 0.58)",
        border: "1px solid rgba(214, 152, 104, 0.16)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), 0 18px 48px rgba(0,0,0,0.35)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      {children}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

// `plan` stays in Props for callers; plan-based UI is gone (owner decision 2026-10-08).
export default function SettingsClient({ userId, walletAddress, profile }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("profile")

  const TABS: { id: Tab; label: string }[] = [
    { id: "profile",       label: "Profile" },
    { id: "plan",          label: "QLC" },
    { id: "notifications", label: "Notifications" },
    { id: "security",      label: "Security" },
  ]

  return (
    <div className="relative min-h-screen">
    <QelarixBackdrop tone="copper" />
    <div className="relative mx-auto w-full max-w-3xl px-4 sm:px-6 pt-16 lg:pt-12 pb-16" style={{ zIndex: 1 }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-white/40 text-sm mt-1">Manage your profile, QLC and security</p>
      </div>

      {/* Tab nav */}
      <div
        className="flex gap-1 mb-8 p-1 rounded-xl overflow-x-auto"
        style={{
          background: "rgba(30, 25, 21, 0.58)",
          border: "1px solid rgba(214, 152, 104, 0.16)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className="flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={{
              background: activeTab === t.id ? "rgba(214, 152, 104, 0.16)" : "transparent",
              color: activeTab === t.id ? "white" : "rgba(255,255,255,0.5)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "profile"       && <ProfileTab    userId={userId} walletAddress={walletAddress} profile={profile} />}
      {activeTab === "plan"          && <PlanTab />}
      {activeTab === "notifications" && <NotificationsTab userId={userId} profile={profile} />}
      {activeTab === "security"      && <SecurityTab   userId={userId} walletAddress={walletAddress} />}
    </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: Profile
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ProfileTab({ userId: _userId, walletAddress, profile }: { userId: string; walletAddress: string; profile: Profile | null }) {
  const [username,  setUsername]  = useState(profile?.username  ?? "")
  const [fullName,  setFullName]  = useState(profile?.full_name ?? "")
  const [bio,       setBio]       = useState(profile?.bio       ?? "")
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url ?? "")
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarFile,    setAvatarFile]    = useState<File | null>(null)

  const [saving,      setSaving]      = useState(false)
  const [saved,       setSaved]       = useState(false)
  const [uploadingAv, setUploadingAv] = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  const initials = (profile?.full_name || walletAddress || "U")[0].toUpperCase()

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (!f.type.startsWith("image/")) { setError("Please choose an image file"); return }
    if (f.size > 5 * 1024 * 1024)    { setError("Image must be under 5MB"); return }
    setError(null)
    setAvatarFile(f)
    setAvatarPreview(URL.createObjectURL(f))
  }

  async function uploadAvatar() {
    if (!avatarFile) return
    setUploadingAv(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append("file", avatarFile)
      const res = await fetch("/api/settings/avatar", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setAvatarUrl(data.avatarUrl)
      setAvatarFile(null)
      setAvatarPreview(null)
      window.dispatchEvent(new CustomEvent('profile-updated'))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload error")
    } finally {
      setUploadingAv(false)
    }
  }

  async function saveProfile() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      if (avatarFile) await uploadAvatar()
      const res = await fetch("/api/settings/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), full_name: fullName.trim(), bio: bio.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSaved(true)
      window.dispatchEvent(new CustomEvent('profile-updated'))
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error saving changes")
    } finally {
      setSaving(false)
    }
  }

  const displayAvatar = avatarPreview ?? avatarUrl

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <SectionCard>
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-4">Avatar</h2>
        <div className="flex items-center gap-5">
          <div className="relative flex-shrink-0">
            {displayAvatar ? (
              <Image
                src={displayAvatar}
                alt="Avatar"
                width={80}
                height={80}
                className="w-20 h-20 rounded-full object-cover"
              />
            ) : (
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold text-white"
                style={{ background: QLC_COLORS.accent }}
              >
                {initials}
              </div>
            )}
            {profile?.early_adopter && (
              <div
                className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full"
                title={`Early Adopter #${profile.early_adopter_number}`}
                style={{
                  background: "#D98A56",
                  border: "2px solid #14110e",
                }}
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white/70 hover:text-white transition-colors"
              style={{ background: "rgba(255,255,255,0.07)" }}
            >
              Change photo
            </button>
            {avatarFile && (
              <p className="text-xs text-white/40">{avatarFile.name}</p>
            )}
            <p className="text-xs text-white/30">JPG, PNG, WebP · max 5MB</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFileChange}
            />
          </div>

          {/* Early Adopter badge info */}
          {profile?.early_adopter && (
            <div
              className="ml-auto flex-shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold"
              style={{
                background: "rgba(245,158,11,0.15)",
                border: "1px solid rgba(245,158,11,0.4)",
                color: "#f59e0b",
              }}
            >
              Early Adopter #{profile.early_adopter_number}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Info fields */}
      <SectionCard>
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-4">Information</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-white/50 mb-1.5">Wallet address</label>
            <input
              readOnly
              value={walletAddress}
              className="w-full px-3 py-2.5 rounded-lg text-sm text-white/40 cursor-not-allowed"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
            />
            <p className="text-[11px] text-white/25 mt-1">Your sign-in wallet cannot be changed</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-white/50 mb-1.5">
              Username
              <span className="ml-1 text-white/25">(3–30 characters, no spaces)</span>
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="my_username"
              maxLength={30}
              className="w-full px-3 py-2.5 rounded-lg text-sm text-white outline-none transition-colors"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-white/50 mb-1.5">Profile name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Name shown on your profile"
              maxLength={100}
              className="w-full px-3 py-2.5 rounded-lg text-sm text-white outline-none transition-colors"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-white/50 mb-1.5">
              Bio
              <span className="ml-1 text-white/25">({bio.length}/300)</span>
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Short description about yourself..."
              maxLength={300}
              rows={3}
              className="w-full px-3 py-2.5 rounded-lg text-sm text-white outline-none resize-none transition-colors"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            />
          </div>
        </div>

        {error && <div className="mt-4"><ErrorBanner message={error} /></div>}

        <div className="mt-5 flex justify-end">
          <SaveButton loading={saving || uploadingAv} saved={saved} onClick={saveProfile} />
        </div>
      </SectionCard>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: QLC
// ─────────────────────────────────────────────────────────────────────────────

function PlanTab() {
  // QLC: on-chain balance, spending limit and QLC packs (same components as Pricing and Buy QLC).
  return (
    <div className="space-y-6">
      <SectionCard>
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-4">QLC</h2>
        <QlcSpending />
        <QlcTopUp />
      </SectionCard>
      <p className="text-xs text-white/35">
        Prices, example costs and how QLC works:{" "}
        <a href="/pricing" className="text-white/60 hover:text-white transition-colors">Pricing</a>
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: API
// ─────────────────────────────────────────────────────────────────────────────

// Developer & agent API (keys, webhooks, x402) is on the roadmap. The key generated here is not yet
// accepted by any endpoint, so the tab shows "Coming soon" until the public API ships.
// Kept for the public API launch (the API is announced on /developers).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ApiTab({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userId: _userId,
  profile,
  plan,
}: {
  userId: string
  profile: Profile | null
  plan: PlanId
}) {
  const hasApi     = plan === "pro" || plan === "ultra" || plan === "business"
  const hasMakeCom = plan === "ultra" || plan === "business"

  const [keyPrefix,    setKeyPrefix]    = useState(profile?.api_key_prefix ?? "")
  const [newKey,       setNewKey]       = useState<string | null>(null)
  const [keyCopied,    setKeyCopied]    = useState(false)
  const [keyLoading,   setKeyLoading]   = useState(false)
  const [keyError,     setKeyError]     = useState<string | null>(null)
  const [revokeLoad,   setRevokeLoad]   = useState(false)

  const [webhookUrl,   setWebhookUrl]   = useState(profile?.webhook_url ?? "")
  const [webhookSave,  setWebhookSave]  = useState(false)
  const [webhookLoad,  setWebhookLoad]  = useState(false)
  const [webhookError, setWebhookError] = useState<string | null>(null)

  async function generateKey() {
    setKeyLoading(true)
    setKeyError(null)
    setNewKey(null)
    try {
      const res = await fetch("/api/settings/api-key", { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setNewKey(data.apiKey)
      setKeyPrefix(data.keyPrefix)
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Error")
    } finally {
      setKeyLoading(false)
    }
  }

  async function revokeKey() {
    setRevokeLoad(true)
    setKeyError(null)
    try {
      const res = await fetch("/api/settings/api-key", { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setKeyPrefix("")
      setNewKey(null)
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Error")
    } finally {
      setRevokeLoad(false)
    }
  }

  async function copyKey() {
    if (!newKey) return
    await navigator.clipboard.writeText(newKey)
    setKeyCopied(true)
    setTimeout(() => setKeyCopied(false), 2000)
  }

  async function saveWebhook() {
    setWebhookLoad(true)
    setWebhookSave(false)
    setWebhookError(null)
    try {
      const res = await fetch("/api/settings/webhook", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: webhookUrl.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setWebhookSave(true)
      setTimeout(() => setWebhookSave(false), 3000)
    } catch (err) {
      setWebhookError(err instanceof Error ? err.message : "Error")
    } finally {
      setWebhookLoad(false)
    }
  }

  if (!hasApi) {
    return (
      <SectionCard>
        <div className="text-center py-8">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "rgba(168,85,247,0.1)" }}
          >
            <svg className="w-7 h-7 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
          </div>
          <h3 className="text-white font-semibold mb-1">API access not available</h3>
          <p className="text-white/40 text-sm mb-5">
            Upgrade to Pro or Business to get API access.
          </p>
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); document.querySelector<HTMLButtonElement>("[data-tab=plan]")?.click() }}
            className="inline-block px-5 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: QLC_COLORS.accent }}
          >
            View plans →
          </a>
        </div>
      </SectionCard>
    )
  }

  return (
    <div className="space-y-6">
      {/* API Key */}
      <SectionCard>
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-4">API key</h2>

        {/* Revealed key — shown only once */}
        {newKey ? (
          <div
            className="rounded-xl p-4 mb-4"
            style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.25)" }}
          >
            <p className="text-xs text-green-400 font-semibold mb-2">
              Save this key now. It is shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-white/80 font-mono break-all">{newKey}</code>
              <button
                onClick={copyKey}
                className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium text-white/70 hover:text-white transition-colors"
                style={{ background: "rgba(255,255,255,0.07)" }}
              >
                {keyCopied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ) : keyPrefix ? (
          <div
            className="flex items-center gap-3 rounded-xl px-4 py-3 mb-4"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <svg className="w-4 h-4 text-white/40 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
            <code className="text-sm text-white/60 font-mono flex-1">{keyPrefix}</code>
          </div>
        ) : (
          <p className="text-white/40 text-sm mb-4">No API key generated.</p>
        )}

        {keyError && <div className="mb-4"><ErrorBanner message={keyError} /></div>}

        <div className="flex gap-2 flex-wrap">
          <button
            onClick={generateKey}
            disabled={keyLoading || revokeLoad}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: QLC_COLORS.accent }}
          >
            {keyLoading ? "Generating..." : keyPrefix ? "Regenerate key" : "Generate API key"}
          </button>
          {keyPrefix && (
            <button
              onClick={revokeKey}
              disabled={revokeLoad || keyLoading}
              className="px-4 py-2 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
              style={{ background: "rgba(239,68,68,0.08)" }}
            >
              {revokeLoad ? "Deleting..." : "Revoke key"}
            </button>
          )}
        </div>

        <div className="mt-4 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <p className="text-white/30 text-xs">
            Use the key in the HTTP header: <code className="text-white/50">Authorization: Bearer sk-plt-...</code>
          </p>
          <p className="text-white/25 text-xs mt-1">
            API documentation coming soon.
          </p>
        </div>
      </SectionCard>

      {/* Webhook */}
      {hasMakeCom && (
        <SectionCard>
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-1">
            Webhook URL
            <span
              className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full normal-case"
              style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)" }}
            >
              Business
            </span>
          </h2>
          <p className="text-white/40 text-xs mb-4">
            Make.com or Zapier webhook URL for receiving notifications on completed generations.
          </p>

          <div className="flex gap-2">
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hook.eu1.make.com/..."
              className="flex-1 px-3 py-2.5 rounded-lg text-sm text-white outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <SaveButton loading={webhookLoad} saved={webhookSave} onClick={saveWebhook} />
          </div>
          {webhookError && <div className="mt-3"><ErrorBanner message={webhookError} /></div>}
        </SectionCard>
      )}

      {/* API info card */}
      <SectionCard>
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(123,97,255,0.1)" }}
          >
            <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </div>
          <div>
            <p className="text-white/60 text-sm font-medium">Documentation</p>
            <p className="text-white/30 text-xs">API documentation coming soon — /generate, /status, /credits endpoints</p>
          </div>
        </div>
      </SectionCard>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: Notifications
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function NotificationsTab({ userId: _userId, profile }: { userId: string; profile: Profile | null }) {
  const [emailGen,        setEmailGen]        = useState(profile?.notification_email_generation ?? true)
  const [emailCredits,    setEmailCredits]    = useState(profile?.notification_email_credits    ?? true)
  const [emailNewsletter, setEmailNewsletter] = useState(profile?.notification_email_newsletter ?? false)

  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notification_email_generation: emailGen,
          notification_email_credits:    emailCredits,
          notification_email_newsletter: emailNewsletter,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error saving changes")
    } finally {
      setSaving(false)
    }
  }

  const rows = [
    {
      title: "Generation complete",
      desc:  "Email when AI finishes generating your video, image, or audio.",
      value: emailGen,
      set:   setEmailGen,
    },
    {
      title: "Low credits (<100)",
      desc:  "Alert when your QLC balance runs low.",
      value: emailCredits,
      set:   setEmailCredits,
    },
    {
      title: "Newsletter & updates",
      desc:  "Notifications about new models, features and promotions.",
      value: emailNewsletter,
      set:   setEmailNewsletter,
    },
  ]

  return (
    <div className="space-y-6">
      <SectionCard>
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-2">Email notifications</h2>
        <p className="text-white/30 text-xs mb-5">
          Control which emails you receive. Transactional emails (invoices, security) are always sent.
        </p>

        <div className="divide-y divide-white/5">
          {rows.map((row) => (
            <div key={row.title} className="flex items-center justify-between py-4">
              <div className="pr-4">
                <p className="text-sm font-medium text-white">{row.title}</p>
                <p className="text-xs text-white/40 mt-0.5">{row.desc}</p>
              </div>
              <Toggle checked={row.value} onChange={row.set} />
            </div>
          ))}
        </div>

        {error && <div className="mt-4"><ErrorBanner message={error} /></div>}

        <div className="mt-5 flex justify-end">
          <SaveButton loading={saving} saved={saved} onClick={save} />
        </div>
      </SectionCard>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: Security
// ─────────────────────────────────────────────────────────────────────────────

function SecurityTab({ userId, walletAddress }: { userId: string; walletAddress: string }) {
  return (
    <div className="space-y-6">
      {/* Active sessions */}
      <SectionCard>
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-4">Active sessions</h2>
        <div
          className="flex items-center gap-4 p-4 rounded-xl"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(16,185,129,0.15)" }}
          >
            <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Current session</p>
            <p className="text-xs text-white/40 truncate">{walletAddress}</p>
          </div>
          <span
            className="flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ background: "rgba(16,185,129,0.15)", color: "#34d399" }}
          >
            Active
          </span>
        </div>
        <p className="text-white/25 text-xs mt-3">
          To log out of all devices, contact support.
        </p>
      </SectionCard>

      {/* Account info */}
      <SectionCard>
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest mb-4">Account information</h2>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/40">User ID</span>
            <code className="text-white/50 text-xs font-mono">{userId.slice(0, 8)}...</code>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/40">Wallet</span>
            <code className="text-white/50 text-xs font-mono">{shortWalletAddress(walletAddress)}</code>
          </div>
        </div>
        <div className="mt-5 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <p className="text-white/30 text-xs">
            To delete your account, send a request to{" "}
            <a href="mailto:contact@pixidigital.io" className="text-violet-400 hover:text-violet-300 transition-colors">
              contact@pixidigital.io
            </a>
            {" "}(GDPR right to erasure).
          </p>
        </div>
      </SectionCard>
    </div>
  )
}
