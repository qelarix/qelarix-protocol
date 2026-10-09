-- ============================================================
-- QLC payments: generic multi-asset quotes, settlement and the exactly-once QLC delivery queue
--
-- PROPOSED: not applied to any project. Apply to the dev project (qcggkvubogqlmxcepvbr) only
-- after owner approval; mainnet has no project yet.
-- Requires 20261002000001_credit_campaigns.sql. Rollback: supabase/rollbacks/20261002000002_qlc_payments.sql
-- Configuration rows per project: supabase/payment-assets/<cluster>.sql, supabase/pricing/<cluster>.sql
--
-- QLC is an on-chain Token-2022 token (QLC Token Architecture & Future Tokenomics Source of Truth):
-- the authoritative balance is the member's QLC token account. This schema never changes
-- profiles.credits; it records what Qelarix quoted, was paid and must deliver.
--
-- 1. payment_assets: payable assets as configuration (USDC, SOL, future QLX, approved partner
--    tokens). A row is payable only when enabled AND approved; partner tokens start disabled.
-- 2. qlc_price_packs: one canonical USD value per pack; QLC amounts in base units (2 decimals,
--    multiples of 5 = 0.05 QLC).
-- 3. payment_intents: server quotes (asset, exact payment amount in base units, price snapshot,
--    expiry, payer, treasury, unique on-chain reference); paid at most once. The recovery job
--    (/api/cron/qlc-payments) settles payments nobody confirmed and closes unpaid quotes as expired.
-- 4. qlc_deliveries: every QLC delivery (purchases now; leaderboard, campaigns and grants later)
--    with one stable key. sha256(key) is the on-chain delivery id, so the QLC program executes each
--    delivery at most once even if the queue retries it. Failed attempts back off (next_attempt_at)
--    and the recovery job retries them until delivered.
-- 5. settle_payment_intent(): after the server has verified the finalized payment on chain, marks
--    the quote paid and enqueues its delivery atomically; repeated calls change nothing.
-- ============================================================

BEGIN;

-- ── 1. Payment assets ───────────────────────────────────────────────────────
CREATE TABLE public.payment_assets (
  id                TEXT PRIMARY KEY,
  cluster           TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  symbol            TEXT NOT NULL CHECK (btrim(symbol) <> ''),
  -- The kind selects the transfer and verification rules:
  --   spl-token  one TransferChecked of the exact amount into the treasury's associated token
  --              account, confirmed by the exact balance change (fee-on-transfer tokens never verify)
  --   native-sol one System Program transfer of the exact lamports to the treasury
  kind              TEXT NOT NULL CHECK (kind IN ('spl-token', 'native-sol')),
  mint              TEXT CHECK (mint IS NULL OR mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  token_program     TEXT CHECK (token_program IS NULL OR token_program IN (
                      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')),
  decimals          SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  treasury_address  TEXT NOT NULL CHECK (treasury_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- {"kind": "usd-peg"} or {"kind": "pyth-account", "account": "...", "feedId": "<64 hex>",
  --  "maxAgeSecs": 60, "maxConfidenceBps": 100}
  price_source      JSONB NOT NULL CHECK (price_source ? 'kind'),
  quote_ttl_secs    INTEGER NOT NULL CHECK (quote_ttl_secs BETWEEN 30 AND 3600),
  -- Payment amounts are always rounded up, so Qelarix is never paid less than the pack value.
  rounding          TEXT NOT NULL DEFAULT 'up' CHECK (rounding = 'up'),
  is_enabled        BOOLEAN NOT NULL DEFAULT false,
  approved_by       TEXT,
  approved_at       TIMESTAMPTZ,
  approval_note     TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_assets_kind_fields CHECK (
    (kind = 'native-sol' AND mint IS NULL AND token_program IS NULL AND decimals = 9)
    OR kind = 'spl-token'
  ),
  CONSTRAINT payment_assets_enabled_needs_approval CHECK (
    NOT is_enabled
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL
        AND (kind = 'native-sol' OR (mint IS NOT NULL AND token_program IS NOT NULL)))
  )
);
CREATE UNIQUE INDEX payment_assets_cluster_mint_idx ON public.payment_assets (cluster, mint) WHERE mint IS NOT NULL;

-- ── 2. Pricing configuration ────────────────────────────────────────────────
CREATE TABLE public.qlc_price_packs (
  id                     TEXT PRIMARY KEY,
  cluster                TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  -- QLC base units (2 decimals): 50000 = 500.00 QLC. Always a multiple of 0.05 QLC.
  qlc_amount             BIGINT NOT NULL CHECK (qlc_amount > 0 AND qlc_amount % 5 = 0),
  -- Canonical pack value in USD micro-dollars: 4990000 = $4.99.
  usd_value_micros       BIGINT NOT NULL CHECK (usd_value_micros > 0),
  -- Regular value shown struck through while this row is a discount; NULL when not discounted.
  list_usd_value_micros  BIGINT CHECK (list_usd_value_micros IS NULL OR list_usd_value_micros > usd_value_micros),
  label                  TEXT NOT NULL CHECK (btrim(label) <> ''),
  badge                  TEXT,
  highlighted            BOOLEAN NOT NULL DEFAULT false,
  -- ISO 3166-1 alpha-2 country code; NULL = every region.
  region                 TEXT CHECK (region IS NULL OR region ~ '^[A-Z]{2}$'),
  -- While this row is live, the pack it replaces is hidden (promotions, temporary offers).
  replaces_pack_id       TEXT REFERENCES public.qlc_price_packs (id) ON DELETE SET NULL,
  offer                  TEXT,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  starts_at              TIMESTAMPTZ,
  ends_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qlc_price_packs_window CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  CONSTRAINT qlc_price_packs_not_self CHECK (replaces_pack_id IS NULL OR replaces_pack_id <> id)
);

-- ── 3. QLC delivery queue ───────────────────────────────────────────────────
CREATE TABLE public.qlc_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable key per delivery, e.g. 'payment:<intent id>' or 'leaderboard:2026-10:1'.
  delivery_key     TEXT NOT NULL UNIQUE CHECK (btrim(delivery_key) <> ''),
  -- sha256(delivery_key) in hex = the on-chain delivery id (seed of the program's receipt).
  delivery_id_hex  TEXT NOT NULL UNIQUE CHECK (delivery_id_hex ~ '^[0-9a-f]{64}$'),
  source_type      TEXT NOT NULL CHECK (source_type IN ('payment', 'leaderboard', 'campaign', 'grant')),
  source_id        TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('purchase', 'reward', 'grant', 'campaign')),
  user_id          UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
  wallet_address   TEXT NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster          TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  qlc_amount       BIGINT NOT NULL CHECK (qlc_amount > 0 AND qlc_amount % 5 = 0),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       TEXT,
  last_attempt_at  TIMESTAMPTZ,
  -- Earliest retry after a failed attempt (NULL = never attempted); see record_qlc_delivery_attempt.
  next_attempt_at  TIMESTAMPTZ,
  tx_signature     TEXT,
  from_vault       BIGINT CHECK (from_vault IS NULL OR from_vault >= 0),
  minted           BIGINT CHECK (minted IS NULL OR minted >= 0),
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qlc_deliveries_key_hash CHECK (delivery_id_hex = encode(sha256(convert_to(delivery_key, 'UTF8')), 'hex')),
  CONSTRAINT qlc_deliveries_delivered CHECK (
    status = 'pending'
    OR (delivered_at IS NOT NULL AND from_vault IS NOT NULL AND minted IS NOT NULL AND from_vault + minted = qlc_amount)
  )
);
CREATE INDEX qlc_deliveries_due_idx ON public.qlc_deliveries (cluster, next_attempt_at NULLS FIRST) WHERE status = 'pending';
CREATE INDEX qlc_deliveries_user_idx ON public.qlc_deliveries (user_id, created_at DESC);

-- ── 4. Payment intents ──────────────────────────────────────────────────────
CREATE TABLE public.payment_intents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Kept when a profile is deleted: the payment record is part of the audit trail.
  user_id                UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
  wallet_address         TEXT NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster                TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  pack_id                TEXT NOT NULL,
  offer                  TEXT,
  qlc_amount             BIGINT NOT NULL CHECK (qlc_amount > 0 AND qlc_amount % 5 = 0),
  usd_value_micros       BIGINT NOT NULL CHECK (usd_value_micros > 0),
  payment_asset_id       TEXT NOT NULL,
  payment_asset_symbol   TEXT NOT NULL,
  payment_asset_kind     TEXT NOT NULL CHECK (payment_asset_kind IN ('spl-token', 'native-sol')),
  payment_mint           TEXT,
  payment_token_program  TEXT,
  payment_decimals       SMALLINT NOT NULL CHECK (payment_decimals BETWEEN 0 AND 18),
  payment_amount         BIGINT NOT NULL CHECK (payment_amount > 0),
  treasury_address       TEXT NOT NULL,
  -- Account whose balance must increase: the treasury's token account, or the treasury for SOL.
  destination_account    TEXT NOT NULL,
  price_source           TEXT NOT NULL,
  price_snapshot         JSONB NOT NULL,
  quoted_at              TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  -- Random public key added (read-only) to the transfer so the payment can be found on chain.
  reference              TEXT NOT NULL UNIQUE CHECK (reference ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- expired: closed by the recovery job after a final on-chain lookup found no payment. It is not
  -- scanned again, but a payment that landed before expires_at still settles (confirm).
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired')),
  tx_signature           TEXT UNIQUE,
  tx_slot                BIGINT,
  tx_block_time          TIMESTAMPTZ,
  paid_at                TIMESTAMPTZ,
  delivery_id            UUID UNIQUE REFERENCES public.qlc_deliveries (id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_intents_mint_matches_kind CHECK (
    (payment_asset_kind = 'native-sol' AND payment_mint IS NULL)
    OR (payment_asset_kind = 'spl-token' AND payment_mint IS NOT NULL AND payment_token_program IS NOT NULL)
  ),
  CONSTRAINT payment_intents_status CHECK (
    (status IN ('pending', 'expired') AND tx_signature IS NULL AND paid_at IS NULL AND delivery_id IS NULL)
    OR (status = 'paid' AND tx_signature IS NOT NULL AND paid_at IS NOT NULL AND tx_block_time IS NOT NULL AND delivery_id IS NOT NULL)
  )
);
CREATE INDEX payment_intents_user_idx ON public.payment_intents (user_id, created_at DESC);
CREATE INDEX payment_intents_pending_idx ON public.payment_intents (cluster, quoted_at) WHERE status = 'pending';

-- ── 5. Access ───────────────────────────────────────────────────────────────
-- Configuration and every write are server-only (service_role bypasses RLS). Members may read
-- their own quotes and deliveries. New tables inherit Supabase's default grants, so revoke first.
ALTER TABLE public.payment_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qlc_price_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qlc_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_intents_select_own ON public.payment_intents FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY qlc_deliveries_select_own ON public.qlc_deliveries FOR SELECT USING (auth.uid() = user_id);
REVOKE ALL ON public.payment_assets, public.qlc_price_packs, public.qlc_deliveries, public.payment_intents
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_intents, public.qlc_deliveries TO authenticated;
GRANT ALL ON public.payment_assets, public.qlc_price_packs, public.qlc_deliveries, public.payment_intents TO service_role;

-- ── 6. Settlement ───────────────────────────────────────────────────────────
-- Called by the server only after it has verified the finalized transaction on chain. The verified
-- values are compared with the quote again here, so a mismatch can never enqueue a delivery.
-- Concurrency: the intent row is locked FOR UPDATE; unique tx_signature and delivery_key are the
-- final replay guards. Any failure rolls back the intent and the delivery together.
CREATE OR REPLACE FUNCTION public.settle_payment_intent(
  p_intent_id            UUID,
  p_user_id              UUID,
  p_cluster              TEXT,
  p_tx_signature         TEXT,
  p_payer                TEXT,
  p_payment_mint         TEXT,
  p_treasury_address     TEXT,
  p_destination_account  TEXT,
  p_payment_amount       BIGINT,
  p_reference            TEXT,
  p_tx_slot              BIGINT,
  p_tx_block_time        TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent       public.payment_intents%ROWTYPE;
  v_key          TEXT;
  v_delivery_id  UUID;
BEGIN
  IF p_intent_id IS NULL OR p_user_id IS NULL OR p_tx_block_time IS NULL
     OR coalesce(p_tx_signature, '') !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_intent FROM public.payment_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('status', 'unknown_intent');
  END IF;

  IF v_intent.status = 'paid' THEN
    IF v_intent.tx_signature = p_tx_signature THEN
      RETURN jsonb_build_object('status', 'already_paid', 'intentId', v_intent.id,
        'deliveryId', v_intent.delivery_id, 'signature', v_intent.tx_signature);
    END IF;
    RETURN jsonb_build_object('status', 'intent_already_paid', 'intentId', v_intent.id,
      'signature', v_intent.tx_signature);
  END IF;

  IF v_intent.cluster <> p_cluster THEN
    RETURN jsonb_build_object('status', 'cluster_mismatch', 'intentId', v_intent.id);
  END IF;
  IF v_intent.wallet_address <> p_payer THEN
    RETURN jsonb_build_object('status', 'payer_mismatch', 'intentId', v_intent.id);
  END IF;
  IF v_intent.payment_mint IS DISTINCT FROM p_payment_mint THEN
    RETURN jsonb_build_object('status', 'asset_mismatch', 'intentId', v_intent.id);
  END IF;
  IF v_intent.treasury_address <> p_treasury_address OR v_intent.destination_account <> p_destination_account THEN
    RETURN jsonb_build_object('status', 'destination_mismatch', 'intentId', v_intent.id);
  END IF;
  IF v_intent.payment_amount <> p_payment_amount THEN
    RETURN jsonb_build_object('status', 'amount_mismatch', 'intentId', v_intent.id);
  END IF;
  IF v_intent.reference <> p_reference THEN
    RETURN jsonb_build_object('status', 'reference_mismatch', 'intentId', v_intent.id);
  END IF;
  -- The payment counts when it landed before the quote expired, even if verified later (also when
  -- the recovery job already closed the quote as expired).
  IF p_tx_block_time > v_intent.expires_at THEN
    RETURN jsonb_build_object('status', 'expired', 'intentId', v_intent.id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_intents WHERE tx_signature = p_tx_signature) THEN
    RETURN jsonb_build_object('status', 'signature_used', 'intentId', v_intent.id);
  END IF;

  v_key := 'payment:' || v_intent.id::text;
  INSERT INTO public.qlc_deliveries (delivery_key, delivery_id_hex, source_type, source_id, kind,
                                     user_id, wallet_address, cluster, qlc_amount)
  VALUES (v_key, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), 'payment', v_intent.id::text, 'purchase',
          v_intent.user_id, v_intent.wallet_address, v_intent.cluster, v_intent.qlc_amount)
  RETURNING id INTO v_delivery_id;

  UPDATE public.payment_intents
    SET status = 'paid', tx_signature = p_tx_signature, tx_slot = p_tx_slot,
        tx_block_time = p_tx_block_time, paid_at = NOW(), delivery_id = v_delivery_id
    WHERE id = v_intent.id;

  RETURN jsonb_build_object('status', 'paid', 'intentId', v_intent.id, 'deliveryId', v_delivery_id,
    'signature', p_tx_signature);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'signature_used', 'intentId', p_intent_id);
END;
$$;

-- Records a failed delivery attempt. The delivery stays pending and is retried after a backoff of
-- 1, 2, 4 ... minutes, at most one hour, for as long as it takes (it is never dropped).
CREATE OR REPLACE FUNCTION public.record_qlc_delivery_attempt(p_delivery_id UUID, p_error TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.qlc_deliveries
    SET attempts = attempts + 1, last_error = left(p_error, 500), last_attempt_at = NOW(),
        next_attempt_at = NOW() + LEAST(INTERVAL '1 minute' * power(2, LEAST(attempts, 6)), INTERVAL '1 hour'),
        updated_at = NOW()
    WHERE id = p_delivery_id AND status = 'pending';
$$;

REVOKE EXECUTE ON FUNCTION public.settle_payment_intent(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_payment_intent(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TIMESTAMPTZ)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.record_qlc_delivery_attempt(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_qlc_delivery_attempt(UUID, TEXT) TO service_role;

COMMIT;
