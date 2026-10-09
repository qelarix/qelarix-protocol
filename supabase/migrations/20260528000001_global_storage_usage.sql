-- ============================================================
-- Qelarix — Global Storage Usage (Phase 1: SCHEMA ONLY)
-- Migration: 20260528000001_global_storage_usage
-- ============================================================
-- Adds a per-file storage registry + per-user counters so storage limits
-- can be enforced GLOBALLY (every Supabase-hosted asset across the whole
-- account), not just Cinema Studio.
--
-- Phase 1 is SCHEMA ONLY. There is intentionally NO:
--   - app wiring (recordAsset / releaseAsset helpers)
--   - usage UI
--   - upload/generation/export blocking
--   - backfill of existing files
--   - delete-cleanup
-- Those are later phases.
--
-- SCOPE: this registry is intended to track ONLY Supabase-hosted files
-- (buckets: generations / media / avatars / public / cinema-characters /
-- cinema-refs). External provider URLs (fal.ai / MUAPI / Grok video that
-- are NOT stored in Supabase) are out of scope for now and are not
-- represented here.

-- ── 1. Registry table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_storage_assets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bucket       TEXT        NOT NULL,
  path         TEXT        NOT NULL,
  size_bytes   BIGINT      NOT NULL DEFAULT 0
               CONSTRAINT user_storage_assets_size_bytes_check CHECK (size_bytes >= 0),
  asset_type   TEXT        NOT NULL,   -- image | video | audio | thumbnail | reference | export | avatar | upload | ...
  source_type  TEXT        NOT NULL,   -- generated | uploaded
  source_table TEXT,                   -- e.g. 'generations', 'cinema_scenes' (nullable)
  source_id    UUID,                   -- row id in source_table (nullable; e.g. /api/upload has no row)
  status       TEXT        NOT NULL DEFAULT 'active'
               CONSTRAINT user_storage_assets_status_check CHECK (status IN ('active','deleted','archived')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb
);

-- ── 2. Indexes ────────────────────────────────────────────────────────────────
-- Uniqueness on (bucket, path) is enforced via a UNIQUE INDEX that ALSO doubles
-- as the (bucket, path) lookup index. This avoids creating a redundant second
-- index, and a unique index still supports future ON CONFLICT (bucket, path)
-- upserts in the service-role write helpers.
CREATE UNIQUE INDEX IF NOT EXISTS user_storage_assets_bucket_path_idx
  ON public.user_storage_assets (bucket, path);

CREATE INDEX IF NOT EXISTS user_storage_assets_user_status_idx
  ON public.user_storage_assets (user_id, status);

CREATE INDEX IF NOT EXISTS user_storage_assets_source_idx
  ON public.user_storage_assets (source_table, source_id);

-- ── 3. updated_at trigger (reuse existing shared helper) ─────────────────────
-- public.set_updated_at() is defined in 20260521000001_cinema_studio.sql and
-- simply sets NEW.updated_at = NOW(). Reused here — no new function created.
DROP TRIGGER IF EXISTS user_storage_assets_updated_at ON public.user_storage_assets;
CREATE TRIGGER user_storage_assets_updated_at
  BEFORE UPDATE ON public.user_storage_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 4. Profile counters ──────────────────────────────────────────────────────
-- storage_used_bytes:  denormalized cache of SUM(size_bytes) over this user's
--                      'active' registry rows. Maintained by service-role helpers
--                      in a later phase; recomputable from the registry any time.
-- storage_limit_bytes: NULL = unlimited (Boss / internal accounts). A NULL limit
--                      still TRACKS usage — it just isn't enforced.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS storage_used_bytes  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_limit_bytes BIGINT;

-- ── 5. Row Level Security ────────────────────────────────────────────────────
ALTER TABLE public.user_storage_assets ENABLE ROW LEVEL SECURITY;

-- Owners may READ their own rows only. Writes (insert/update/delete) are
-- intentionally NOT granted to end users — they are performed by service-role
-- API routes in later phases, and service_role bypasses RLS entirely.
DROP POLICY IF EXISTS user_storage_assets_select_own ON public.user_storage_assets;
CREATE POLICY user_storage_assets_select_own
  ON public.user_storage_assets
  FOR SELECT
  USING (auth.uid() = user_id);

-- ── 6. Explicit grants (Supabase Data API compatibility) ─────────────────────
GRANT SELECT ON public.user_storage_assets TO authenticated;
GRANT ALL    ON public.user_storage_assets TO service_role;
-- No sequence grants needed: id uses gen_random_uuid() (no serial/identity column).
-- profiles' two new columns inherit the existing table-level grants on
-- public.profiles; no new profiles grant/policy is added (privacy unchanged).

-- ── 7. Widen profiles.plan CHECK ─────────────────────────────────────────────
-- The original inline CHECK (20260506000001_initial_schema.sql) only allowed
--   plan IN ('free','starter','pro','agency')
-- but the app now uses 'business' and 'ultra' (and a 'tester' pseudo-plan),
-- so writing those plans would be silently rejected by the old constraint —
-- which matters because storage limits will be keyed off the plan.
--
-- Name-agnostic swap: find the existing plan CHECK by its definition (no
-- guessing of the auto-generated constraint name), drop it, then add a single
-- widened constraint. Idempotent: re-running drops the freshly added one and
-- re-adds it. The only CHECK constraint on public.profiles referencing 'plan'
-- is the plan enum, so this targets exactly that constraint.
DO $$
DECLARE
  c_name text;
BEGIN
  FOR c_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class      rel ON rel.oid = con.conrelid
    JOIN pg_namespace  nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'profiles'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%plan%'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', c_name);
  END LOOP;

  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_plan_check
    CHECK (plan IN ('free','starter','pro','business','ultra','agency','tester'));
END $$;
