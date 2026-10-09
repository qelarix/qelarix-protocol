// ─────────────────────────────────────────────────────────────────────────────
// Global Storage Usage — service/helper layer (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────
// Storage tracking is best-effort. It must never block uploads/generation.
//
// Every write helper here (recordStorageAsset / releaseStorageAsset) catches all
// errors internally and returns a structured result — it CANNOT throw into a
// caller route. A failed/absent storage registry must never break an upload.
//
// Pure helper layer for the global storage-limit system. Future upload /
// generation / export routes (Phase 3 / 3.5) will call these to record stored
// assets, release them, read usage, and check limits.
//
// SCOPE (Phase 2): helpers ONLY. Nothing here is wired into any route or UI yet.
// No upload/generation/export blocking, no backfill, no delete cleanup. This
// module also does NOT delete actual Supabase Storage objects — it only tracks
// rows in public.user_storage_assets and the profiles.storage_used_bytes cache.
//
// Schema (already applied — Phase 1, migration 20260528000001_global_storage_usage):
//   public.user_storage_assets (id, user_id, bucket, path, size_bytes, asset_type,
//     source_type, source_table, source_id, status, created_at, updated_at,
//     deleted_at, metadata)  — unique(bucket, path)
//   public.profiles.storage_used_bytes  (bigint, NOT NULL default 0)
//   public.profiles.storage_limit_bytes (bigint, nullable → NULL = unlimited)
//
// NOTE: the generated Database type (src/types/database.ts) does not yet include
// the Phase 1 table/columns, so this module uses an UNTYPED view of the existing
// service-role admin client. This keeps Phase 2 to a single new file (no edits to
// shared types or other modules). Column names are managed manually below.

import type { SupabaseClient } from "@supabase/supabase-js"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

// ── Types ────────────────────────────────────────────────────────────────────

export type StorageAssetStatus = "active" | "deleted" | "archived"

export type StorageAssetType =
  | "image"
  | "video"
  | "audio"
  | "thumbnail"
  | "reference"
  | "export"
  | "avatar"
  | "upload"
  | "brand_asset"
  | "character_asset"
  | "other"

export type StorageSourceType = "generated" | "uploaded" | "imported" | "system"

export type StorageWarningLevel = "ok" | "soft" | "strong" | "full" | "unlimited"

export interface RecordStorageAssetInput {
  userId: string
  bucket: string
  path: string
  sizeBytes: number
  assetType: StorageAssetType
  sourceType: StorageSourceType
  sourceTable?: string | null
  sourceId?: string | null
  metadata?: Record<string, unknown>
}

export interface ReleaseStorageAssetInput {
  /** Restrict the release to a single owner (recommended when known). */
  userId?: string
  /** Identify the asset by (bucket, path) … */
  bucket?: string
  path?: string
  /** … or directly by its registry row id. */
  assetId?: string
}

export interface StorageUsage {
  usedBytes: number
  /** null when the account is unlimited (Boss/internal or NULL plan limit). */
  limitBytes: number | null
  unlimited: boolean
  /** null when unlimited. */
  remainingBytes: number | null
  /** 0–100+ (can exceed 100 if over limit). Always 0 when unlimited. */
  percentUsed: number
  warningLevel: StorageWarningLevel
}

export interface CanStoreResult {
  allowed: boolean
  reason?: "storage_limit_exceeded"
  usage: StorageUsage
}

/** Result of a best-effort recordStorageAsset() call. Never throws. */
export interface RecordStorageAssetResult {
  /** true when the call completed without an unrecoverable error. */
  ok: boolean
  /** true when the asset row was actually written to the registry. */
  tracked: boolean
  /** registry row id when tracked, else null. */
  id?: string | null
  /** recomputed usage cache when available (best-effort), else null. */
  usedBytes?: number | null
  /** human-readable reason when ok=false. */
  error?: string
}

/** Result of a best-effort releaseStorageAsset() call. Never throws. */
export interface ReleaseStorageAssetResult {
  /** true when the call completed without an unrecoverable error. */
  ok: boolean
  /** number of registry rows marked released. */
  released: number
  /** recomputed usage cache when available (best-effort), else null. */
  usedBytes?: number | null
  /** human-readable reason when ok=false. */
  error?: string
}

// ── Plan storage limits (centralized) ─────────────────────────────────────────
// TODO(storage): the pricing Excel is the source-of-truth for storage limits.
// These constants are an INTERIM default and MUST stay in sync with that sheet
// until a final config source (e.g. a `storage` field on PLANS / a DB config)
// is implemented. Do not change pricing UI here.
const GB = 1024 ** 3
const TB = 1024 ** 4

const STORAGE_LIMITS_BYTES: Record<string, number | null> = {
  free: 2 * GB,
  starter: 25 * GB,
  pro: 150 * GB,
  business: 1 * TB,
  ultra: 1 * TB,
  tester: null, // unlimited (still tracked)
  // legacy alias — kept so pre-rename rows resolve sensibly
  agency: 1 * TB,
}

/**
 * Resolve the storage limit (bytes) for a plan. Returns `null` for unlimited
 * (Boss/internal, the `tester` pseudo-plan, or an explicit unlimited plan).
 * Boss/internal status comes from src/lib/planAccess.ts via `options.isBoss`.
 */
export function getStorageLimitForPlan(
  plan: string | null | undefined,
  options?: { isBoss?: boolean },
): number | null {
  if (options?.isBoss) return null
  const key = (plan ?? "free").toLowerCase()
  if (key in STORAGE_LIMITS_BYTES) return STORAGE_LIMITS_BYTES[key]
  // Unknown/legacy plan → fall back to the most conservative (free) limit.
  return STORAGE_LIMITS_BYTES.free
}

// ── Formatting ─────────────────────────────────────────────────────────────────

/**
 * Human-readable byte size for the UI. Bytes render as whole numbers; KB+ use
 * one decimal only when it adds information (e.g. "1 GB", "1.5 GB", "512 B").
 */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const display =
    unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  return `${display} ${units[unit]}`
}

// ── Warning level ───────────────────────────────────────────────────────────────

function warningLevelFor(percentUsed: number): StorageWarningLevel {
  if (percentUsed >= 100) return "full"
  if (percentUsed >= 90) return "strong"
  if (percentUsed >= 70) return "soft"
  return "ok"
}

// ── Storage path helper ─────────────────────────────────────────────────────────

/**
 * Extract the in-bucket object path from a Supabase public URL.
 * e.g. https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<path>?x=1
 *      → "<path>". Returns null when the URL doesn't match the given bucket.
 * (Phase 2 utility — not wired into any delete route yet.)
 */
export function extractStoragePathFromPublicUrl(
  url: string,
  bucket: string,
): string | null {
  if (!url || !bucket) return null
  for (const kind of ["public", "sign", "authenticated"]) {
    const marker = `/storage/v1/object/${kind}/${bucket}/`
    const idx = url.indexOf(marker)
    if (idx === -1) continue
    const rest = url.slice(idx + marker.length)
    const q = rest.indexOf("?")
    const raw = q === -1 ? rest : rest.slice(0, q)
    if (!raw) return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

// ── Internal: untyped admin client + recompute ───────────────────────────────────

/**
 * Untyped view of the service-role admin client. The Phase 1 table/columns are
 * not in the generated Database type yet, so we drop the generic here. Reuses
 * the existing env/config from src/lib/supabase/admin.ts.
 */
function storageAdmin(): SupabaseClient {
  return createSupabaseAdmin() as unknown as SupabaseClient
}

/**
 * Sum size_bytes of a user's ACTIVE registry rows, paginated to stay correct
 * past PostgREST's default row cap.
 * TODO(storage): replace with a DB-side SUM (SQL view or RPC) before heavy use.
 */
async function sumActiveBytes(
  admin: SupabaseClient,
  userId: string,
): Promise<number> {
  const PAGE = 1000
  let from = 0
  let total = 0
  for (;;) {
    const { data, error } = await admin
      .from("user_storage_assets")
      .select("size_bytes")
      .eq("user_id", userId)
      .eq("status", "active")
      .range(from, from + PAGE - 1)
    if (error) {
      throw new Error(
        `[storageUsage] sumActiveBytes select failed for ${userId}: ${error.message}`,
      )
    }
    const rows = (data as Array<{ size_bytes: number | null }> | null) ?? []
    for (const r of rows) total += Math.max(0, Number(r.size_bytes ?? 0))
    if (rows.length < PAGE) break
    from += PAGE
  }
  return total
}

/**
 * Recompute profiles.storage_used_bytes from the active registry rows. Using a
 * recompute (rather than naive increment/decrement) avoids drift across repeated
 * upserts, retries, and releases.
 */
async function recomputeUserStorage(
  admin: SupabaseClient,
  userId: string,
): Promise<number> {
  const total = await sumActiveBytes(admin, userId)
  const { error } = await admin
    .from("profiles")
    .update({ storage_used_bytes: total })
    .eq("id", userId)
  if (error) {
    throw new Error(
      `[storageUsage] recompute update failed for ${userId}: ${error.message}`,
    )
  }
  return total
}

// ── Public async helpers ──────────────────────────────────────────────────────

/**
 * Read a user's storage usage. Limit resolution order:
 *   1. Internal account (planAccess.isInternalUser, passed as options.internal) → unlimited
 *   2. explicit profiles.storage_limit_bytes (admin override) → use it
 *   3. otherwise derive from plan via getStorageLimitForPlan
 */
export async function getUserStorageUsage(
  userId: string,
  options?: { internal?: boolean },
): Promise<StorageUsage> {
  if (!userId) throw new Error("[storageUsage] getUserStorageUsage: userId is required")

  const admin = storageAdmin()
  const { data, error } = await admin
    .from("profiles")
    .select("plan, storage_used_bytes, storage_limit_bytes")
    .eq("id", userId)
    .single()
  if (error) {
    throw new Error(
      `[storageUsage] getUserStorageUsage: failed to load profile ${userId}: ${error.message}`,
    )
  }

  const profile = (data ?? {}) as {
    plan?: string | null
    storage_used_bytes?: number | null
    storage_limit_bytes?: number | null
  }

  const usedBytes = Math.max(0, Number(profile.storage_used_bytes ?? 0))
  const isBoss = options?.internal === true

  // Boss/internal is always unlimited; otherwise an explicit per-user override
  // wins over the plan-derived limit.
  const limitBytes = isBoss
    ? null
    : profile.storage_limit_bytes ?? getStorageLimitForPlan(profile.plan)

  if (limitBytes === null) {
    return {
      usedBytes,
      limitBytes: null,
      unlimited: true,
      remainingBytes: null,
      percentUsed: 0,
      warningLevel: "unlimited",
    }
  }

  const remainingBytes = Math.max(0, limitBytes - usedBytes)
  const percentUsed = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0
  return {
    usedBytes,
    limitBytes,
    unlimited: false,
    remainingBytes,
    percentUsed,
    warningLevel: warningLevelFor(percentUsed),
  }
}

/**
 * Sanitize caller-supplied metadata into a plain, JSON-serializable object so a
 * bad value can never make the registry insert fail. Drops functions / symbols /
 * undefined via a JSON round-trip; falls back to `{}` for non-serializable
 * input (BigInt, circular refs, non-objects). Never throws.
 */
function sanitizeMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {}
  }
  try {
    const plain = JSON.parse(JSON.stringify(metadata))
    return plain && typeof plain === "object" && !Array.isArray(plain)
      ? (plain as Record<string, unknown>)
      : {}
  } catch (err) {
    console.error(
      "[storageUsage] metadata not JSON-serializable — storing {} instead:",
      err instanceof Error ? err.message : err,
    )
    return {}
  }
}

/**
 * Record (or re-activate) a stored asset and recompute the owner's usage.
 * Upserts on the unique (bucket, path); re-recording a previously released
 * asset flips it back to 'active'. Does not touch the Storage object itself.
 *
 * BEST-EFFORT BY DESIGN — storage tracking must NEVER break a caller's upload
 * flow, so this function NEVER throws (the whole body, including input handling
 * and client creation, is guarded). On bad input or any DB error (e.g. the
 * Phase 1 migration not yet applied to a local DB, so `user_storage_assets` /
 * `profiles.storage_used_bytes` are missing) it logs and returns
 * `{ ok: false, tracked: false, error }`. On success it returns
 * `{ ok: true, tracked: true, id, usedBytes }`. The usage-cache recompute is
 * itself best-effort: if only the recompute fails, the asset is still tracked
 * (`ok: true, tracked: true`) with `usedBytes: null`. Callers may ignore the
 * result entirely — it exists for observability, not control flow.
 */
export async function recordStorageAsset(
  input: RecordStorageAssetInput,
): Promise<RecordStorageAssetResult> {
  try {
    // Destructure inside the try so even a null/garbage `input` cannot throw out.
    const { userId, bucket, path, sizeBytes, assetType, sourceType } = input

    // Defensive validation — log and no-op instead of throwing.
    if (!userId || !bucket || !path) {
      const error = "missing required field (userId/bucket/path)"
      console.error("[storageUsage] recordStorageAsset skipped —", error, {
        hasUserId: !!userId,
        bucket,
        path,
      })
      return { ok: false, tracked: false, id: null, usedBytes: null, error }
    }

    // Bad/absent size → 0 rather than a failed insert.
    const size =
      Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.round(sizeBytes) : 0

    const admin = storageAdmin()
    const row = {
      user_id: userId,
      bucket,
      path,
      size_bytes: size,
      asset_type: assetType ?? "other",
      source_type: sourceType ?? "system",
      source_table: input.sourceTable ?? null,
      source_id: input.sourceId ?? null, // null is allowed
      status: "active" as StorageAssetStatus,
      deleted_at: null,
      metadata: sanitizeMetadata(input.metadata),
    }

    const { data, error } = await admin
      .from("user_storage_assets")
      .upsert(row, { onConflict: "bucket,path" })
      .select("id")
      .single()
    if (error) {
      console.error(
        `[storageUsage] recordStorageAsset upsert failed (${bucket}/${path}) — tracking skipped:`,
        error.message,
      )
      return { ok: false, tracked: false, id: null, usedBytes: null, error: error.message }
    }

    // Cache refresh is itself best-effort: a failure here must not undo the
    // successful registry write nor surface to the caller.
    let usedBytes: number | null = null
    try {
      usedBytes = await recomputeUserStorage(admin, userId)
    } catch (recomputeErr) {
      console.error(
        "[storageUsage] recordStorageAsset recompute skipped:",
        recomputeErr instanceof Error ? recomputeErr.message : recomputeErr,
      )
    }
    return { ok: true, tracked: true, id: (data as { id: string }).id, usedBytes }
  } catch (err) {
    // Absolute backstop — nothing inside escapes to the caller.
    const error = err instanceof Error ? err.message : String(err)
    console.error("[storageUsage] recordStorageAsset failed (best-effort, ignored):", error)
    return { ok: false, tracked: false, id: null, usedBytes: null, error }
  }
}

/**
 * Mark a stored asset as released (status='deleted', deleted_at=now()) and
 * recompute the owner's usage. Does NOT delete the actual Storage object — that
 * is handled by delete routes in a later phase. Provide assetId, or (bucket+path).
 *
 * BEST-EFFORT BY DESIGN — never throws into a caller (the whole body is guarded).
 * On bad input or any DB error it logs and returns `{ ok: false, released: 0,
 * error }`. The per-user usage-cache recompute is best-effort and never fails
 * the release.
 */
export async function releaseStorageAsset(
  input: ReleaseStorageAssetInput,
): Promise<ReleaseStorageAssetResult> {
  try {
    if (!input || (!input.assetId && !(input.bucket && input.path))) {
      const error = "provide assetId or (bucket and path)"
      console.error("[storageUsage] releaseStorageAsset skipped —", error)
      return { ok: false, released: 0, usedBytes: null, error }
    }

    const admin = storageAdmin()
    let query = admin
      .from("user_storage_assets")
      .update({ status: "deleted", deleted_at: new Date().toISOString() })

    if (input.assetId) {
      query = query.eq("id", input.assetId)
    } else {
      query = query.eq("bucket", input.bucket as string).eq("path", input.path as string)
    }
    if (input.userId) query = query.eq("user_id", input.userId)

    const { data, error } = await query.select("id, user_id")
    if (error) {
      console.error("[storageUsage] releaseStorageAsset update failed:", error.message)
      return { ok: false, released: 0, usedBytes: null, error: error.message }
    }

    const rows = (data as Array<{ id: string; user_id: string }> | null) ?? []
    const affectedUserIds = Array.from(
      new Set([
        ...rows.map((r) => r.user_id),
        ...(input.userId ? [input.userId] : []),
      ]),
    )

    // Cache refresh is best-effort per affected user.
    let usedBytes: number | null = null
    for (const uid of affectedUserIds) {
      try {
        usedBytes = await recomputeUserStorage(admin, uid)
      } catch (recomputeErr) {
        console.error(
          "[storageUsage] releaseStorageAsset recompute skipped:",
          recomputeErr instanceof Error ? recomputeErr.message : recomputeErr,
        )
      }
    }
    return { ok: true, released: rows.length, usedBytes }
  } catch (err) {
    // Absolute backstop — nothing inside escapes to the caller.
    const error = err instanceof Error ? err.message : String(err)
    console.error("[storageUsage] releaseStorageAsset failed (best-effort, ignored):", error)
    return { ok: false, released: 0, usedBytes: null, error }
  }
}

/**
 * Check whether a user can store `estimatedBytes` more. Unlimited accounts are
 * always allowed. Returns a structured reason ('storage_limit_exceeded') when
 * blocked. NOT wired into any route yet (Phase 5).
 */
export async function canStoreAsset(
  userId: string,
  estimatedBytes: number,
  options?: { internal?: boolean },
): Promise<CanStoreResult> {
  const usage = await getUserStorageUsage(userId, options)
  if (usage.unlimited || usage.limitBytes === null) {
    return { allowed: true, usage }
  }
  const estimate = Math.max(0, Number.isFinite(estimatedBytes) ? estimatedBytes : 0)
  const allowed = usage.usedBytes + estimate <= usage.limitBytes
  return allowed
    ? { allowed: true, usage }
    : { allowed: false, reason: "storage_limit_exceeded", usage }
}
