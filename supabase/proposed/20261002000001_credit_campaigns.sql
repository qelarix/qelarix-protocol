-- ============================================================
-- QLC credit campaigns
--
-- Applied to the dev project (qcggkvubogqlmxcepvbr) on 2026-10-02 after owner approval.
-- Not applied to mainnet (no mainnet project exists yet).
-- Rollback: supabase/rollbacks/20261002000001_credit_campaigns.sql
-- Campaign definitions are per project: supabase/campaigns/{devnet,mainnet}.sql
-- Written against the verified dev schema (supabase/snapshots/dev-credit-schema-2026-10-02.sql)
-- and the repo migrations; it does not assume which add_credits overloads exist.
--
-- 1. Credit and counter functions become server-only (service_role). On the dev
--    project PUBLIC / anon / authenticated could execute all of them.
-- 2. Profile and credit tables: users can read only their own rows and can no
--    longer write them. The "Service role full access" policy applied to every
--    role, and "own profile" (FOR ALL) let users change their own credits.
-- 3. The unused provision_nextauth_profile is removed where it exists.
-- 4. Profile creation no longer grants credits or early-adopter promotions.
-- 5. Credits are granted only through credit_campaigns + credit_grants via
--    grant_campaign_credits(): cluster-scoped, capped, one grant per
--    recipient, idempotent, concurrency-safe and audited.
-- ============================================================

BEGIN;

-- ── 1. Credit and counter functions: server only ────────────────────────────
-- Every existing signature is covered, whatever overloads a project has. All
-- application callers use the service role.
DO $$
DECLARE
  fn REGPROCEDURE;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'add_credits', 'deduct_credits', 'provision_nextauth_profile',
        'increment_likes', 'decrement_likes', 'increment_views', 'increment_shares',
        'increment_followers', 'decrement_followers', 'increment_following', 'decrement_following',
        'update_monthly_stats_like', 'update_monthly_stats_view'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- ── 2. Profile and credit tables ────────────────────────────────────────────
-- service_role bypasses RLS, so no policy is needed for server access.
DROP POLICY IF EXISTS "Service role full access" ON public.profiles;
DROP POLICY IF EXISTS "own profile" ON public.profiles;
DROP POLICY IF EXISTS "own profile update" ON public.profiles;
DROP POLICY IF EXISTS "own profile read" ON public.profiles;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT USING (auth.uid() = id);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.profiles, public.credit_transactions, public.early_adopter_counter
  FROM anon, authenticated;

-- ── 3. Legacy grant path ────────────────────────────────────────────────────
-- Not called by the application; granted signup and early-adopter credits.
DROP FUNCTION IF EXISTS public.provision_nextauth_profile(UUID, TEXT, TEXT);

-- ── 4. Profile creation without promotions ──────────────────────────────────
ALTER TABLE public.profiles ALTER COLUMN credits SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url, credits)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url',
    0
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
-- early_adopter_counter is kept for history and is no longer written.

-- ── 5. Campaigns ────────────────────────────────────────────────────────────
CREATE TABLE public.credit_campaigns (
  id               TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  cluster          TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  -- claim: users request it through the claim API; manual: operators only.
  grant_mode       TEXT NOT NULL CHECK (grant_mode IN ('claim', 'manual')),
  -- One grant per wallet, per user, or per operator-supplied grant key.
  recipient_scope  TEXT NOT NULL CHECK (recipient_scope IN ('wallet', 'user', 'grant_key')),
  -- claim: exact amount per grant. manual: maximum amount per grant.
  amount           INTEGER NOT NULL CHECK (amount > 0),
  max_recipients   INTEGER CHECK (max_recipients > 0),
  granted_count    INTEGER NOT NULL DEFAULT 0 CHECK (granted_count >= 0),
  -- Lower runs first. Within an exclusion group a recipient gets at most one campaign.
  priority         INTEGER NOT NULL DEFAULT 100,
  exclusion_group  TEXT,
  -- Eligibility rules evaluated by the server-side grant service (all must pass).
  eligibility      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(eligibility) = 'array'),
  -- What the granted credits are intended for, e.g. {"modelGroup": "low-cost"}. Configuration
  -- only: model access is enforced by the generation layer, not by this table.
  usage_scope      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage_scope) = 'object'),
  is_active        BOOLEAN NOT NULL DEFAULT false,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  description      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_campaigns_cap CHECK (max_recipients IS NULL OR granted_count <= max_recipients),
  CONSTRAINT credit_campaigns_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT credit_campaigns_claim_scope CHECK (grant_mode = 'manual' OR recipient_scope IN ('wallet', 'user'))
);

CREATE TABLE public.credit_grants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id            TEXT NOT NULL REFERENCES public.credit_campaigns(id),
  cluster                TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  -- 'wallet:<address>' | 'user:<uuid>' | 'key:<operator grant key>'
  recipient_key          TEXT NOT NULL,
  -- Grants outlive deleted profiles so a wallet cannot claim the same campaign twice.
  user_id                UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  wallet_address         TEXT,
  amount                 INTEGER NOT NULL CHECK (amount > 0),
  recipient_number       INTEGER NOT NULL CHECK (recipient_number > 0),
  reason                 TEXT NOT NULL,
  granted_by             TEXT NOT NULL,
  credit_transaction_id  UUID REFERENCES public.credit_transactions(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_grants_one_per_recipient UNIQUE (campaign_id, recipient_key),
  CONSTRAINT credit_grants_recipient_number UNIQUE (campaign_id, recipient_number)
);
CREATE INDEX credit_grants_user_id_idx ON public.credit_grants (user_id);
CREATE INDEX credit_grants_wallet_address_idx ON public.credit_grants (wallet_address) WHERE wallet_address IS NOT NULL;

ALTER TABLE public.credit_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;
-- Users may read their own grants; campaigns and all writes are server-only.
CREATE POLICY credit_grants_select_own ON public.credit_grants FOR SELECT USING (auth.uid() = user_id);
REVOKE ALL ON public.credit_campaigns FROM anon, authenticated;
REVOKE ALL ON public.credit_grants FROM anon, authenticated;
GRANT SELECT ON public.credit_grants TO authenticated;
GRANT ALL ON public.credit_campaigns, public.credit_grants TO service_role;

-- ── 6. Grant function ───────────────────────────────────────────────────────
-- Concurrency: the campaign row is locked FOR UPDATE, so cap checks and the
-- recipient counter are serialized per campaign; an advisory lock serializes
-- campaigns that share an exclusion group for the same recipient. The unique
-- constraints are the final duplicate guard. Any failure rolls back the whole
-- grant (balance, counter, ledger row and grant row change together or not at all).
CREATE OR REPLACE FUNCTION public.grant_campaign_credits(
  p_campaign_id     TEXT,
  p_cluster         TEXT,
  p_grant_mode      TEXT,
  p_user_id         UUID,
  p_wallet_address  TEXT,
  p_grant_key       TEXT,
  p_amount          INTEGER,
  p_reason          TEXT,
  p_granted_by      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign       public.credit_campaigns%ROWTYPE;
  v_existing       public.credit_grants%ROWTYPE;
  v_recipient_key  TEXT;
  v_amount         INTEGER;
  v_number         INTEGER;
  v_balance        INTEGER;
  v_tx_id          UUID;
  v_grant_id       UUID;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_granted_by), '') = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'campaignId', p_campaign_id);
  END IF;

  SELECT * INTO v_campaign FROM public.credit_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unknown_campaign', 'campaignId', p_campaign_id);
  END IF;
  -- Cluster and grant mode are fixed per campaign, so an invalid request is refused
  -- before anything else, including the idempotency lookup.
  IF v_campaign.cluster <> p_cluster THEN
    RETURN jsonb_build_object('status', 'cluster_mismatch', 'campaignId', p_campaign_id);
  END IF;
  IF v_campaign.grant_mode <> p_grant_mode THEN
    RETURN jsonb_build_object('status', 'mode_mismatch', 'campaignId', p_campaign_id);
  END IF;

  -- Recipient key is derived here, never trusted from the caller for claim campaigns.
  IF v_campaign.recipient_scope = 'wallet' THEN
    IF p_wallet_address IS NULL OR p_wallet_address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
      RETURN jsonb_build_object('status', 'invalid_recipient', 'campaignId', p_campaign_id);
    END IF;
    v_recipient_key := 'wallet:' || p_wallet_address;
  ELSIF v_campaign.recipient_scope = 'user' THEN
    v_recipient_key := 'user:' || p_user_id::text;
  ELSE
    IF coalesce(btrim(p_grant_key), '') = '' THEN
      RETURN jsonb_build_object('status', 'invalid_recipient', 'campaignId', p_campaign_id);
    END IF;
    v_recipient_key := 'key:' || p_grant_key;
  END IF;

  IF v_campaign.exclusion_group IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'credit-exclusion:' || v_campaign.cluster || ':' || v_campaign.exclusion_group || ':' ||
      coalesce(p_wallet_address, p_user_id::text), 0));
  END IF;

  SELECT * INTO v_campaign FROM public.credit_campaigns WHERE id = p_campaign_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.credit_grants
    WHERE campaign_id = p_campaign_id AND recipient_key = v_recipient_key;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_granted', 'campaignId', p_campaign_id,
      'amount', v_existing.amount, 'recipientNumber', v_existing.recipient_number, 'grantId', v_existing.id);
  END IF;

  IF NOT v_campaign.is_active
     OR (v_campaign.starts_at IS NOT NULL AND NOW() < v_campaign.starts_at)
     OR (v_campaign.ends_at IS NOT NULL AND NOW() >= v_campaign.ends_at) THEN
    RETURN jsonb_build_object('status', 'inactive', 'campaignId', p_campaign_id);
  END IF;
  IF v_campaign.max_recipients IS NOT NULL AND v_campaign.granted_count >= v_campaign.max_recipients THEN
    RETURN jsonb_build_object('status', 'cap_reached', 'campaignId', p_campaign_id);
  END IF;

  IF v_campaign.grant_mode = 'claim' THEN
    IF p_amount IS NOT NULL AND p_amount <> v_campaign.amount THEN
      RETURN jsonb_build_object('status', 'invalid_amount', 'campaignId', p_campaign_id);
    END IF;
    v_amount := v_campaign.amount;
  ELSE
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_campaign.amount THEN
      RETURN jsonb_build_object('status', 'invalid_amount', 'campaignId', p_campaign_id);
    END IF;
    v_amount := p_amount;
  END IF;

  IF v_campaign.exclusion_group IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.credit_grants g
    JOIN public.credit_campaigns c ON c.id = g.campaign_id
    WHERE c.cluster = v_campaign.cluster
      AND c.exclusion_group = v_campaign.exclusion_group
      AND (g.user_id = p_user_id OR (p_wallet_address IS NOT NULL AND g.wallet_address = p_wallet_address))
  ) THEN
    RETURN jsonb_build_object('status', 'excluded', 'campaignId', p_campaign_id);
  END IF;

  UPDATE public.profiles
    SET credits = credits + v_amount, updated_at = NOW()
    WHERE id = p_user_id
    RETURNING credits INTO v_balance;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unknown_user', 'campaignId', p_campaign_id);
  END IF;

  v_number := v_campaign.granted_count + 1;
  UPDATE public.credit_campaigns SET granted_count = v_number, updated_at = NOW() WHERE id = p_campaign_id;

  INSERT INTO public.credit_transactions (user_id, amount, type, description)
  VALUES (p_user_id, v_amount, CASE WHEN v_campaign.grant_mode = 'claim' THEN 'promo' ELSE 'bonus' END,
          p_campaign_id || ': ' || p_reason)
  RETURNING id INTO v_tx_id;

  INSERT INTO public.credit_grants (campaign_id, cluster, recipient_key, user_id, wallet_address, amount,
                                    recipient_number, reason, granted_by, credit_transaction_id)
  VALUES (p_campaign_id, v_campaign.cluster, v_recipient_key, p_user_id, p_wallet_address, v_amount,
          v_number, p_reason, p_granted_by, v_tx_id)
  RETURNING id INTO v_grant_id;

  RETURN jsonb_build_object('status', 'granted', 'campaignId', p_campaign_id, 'amount', v_amount,
    'recipientNumber', v_number, 'grantId', v_grant_id, 'balance', v_balance);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'already_granted', 'campaignId', p_campaign_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.grant_campaign_credits(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_campaign_credits(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT)
  TO service_role;

COMMIT;
