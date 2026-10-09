-- ============================================================
-- QLC generation billing and Devnet test epochs
--
-- PROPOSED: not applied to any project. Apply to the dev project (qcggkvubogqlmxcepvbr) only after
-- owner approval; mainnet has no project yet.
-- Requires 20261002000001_credit_campaigns.sql and 20261002000002_qlc_payments.sql (qlc_deliveries).
-- Rollback: supabase/rollbacks/20261006000001_qlc_generation_billing.sql
-- Campaign configuration (after this file): supabase/campaigns/devnet-qlc.sql
--
-- With GENERATION_BILLING=qlc every generation is paid on chain (src/lib/billing/generationBilling.ts):
-- the server reserves the cost against the cluster's current test epoch, charges the member's QLC
-- allowance into the Program Vault (program instruction `charge`, one sequence number per charge),
-- calls the provider only after the charge is confirmed, settles on success and refunds exactly once
-- on failure. These tables mirror that lifecycle for idempotency and audit; the authoritative balance
-- stays the member's on-chain QLC account. profiles.credits is never read or changed in this mode.
--
-- 1. credit_campaigns.payout: 'credits' (legacy database credits) or 'qlc' (the grant becomes an
--    exactly-once on-chain QLC delivery in qlc_deliveries; the amount is in whole QLC).
-- 2. qlc_generation_epochs: a global consumption budget per test cycle. Every reservation is admitted
--    atomically against the current epoch under a row lock, so concurrent requests cannot overshoot
--    the limit. A request that does not fit pauses the epoch for everyone; nothing reopens it
--    automatically. A new epoch is opened only by the owner (open_qlc_generation_epoch); earlier
--    epochs and their charges are never changed or deleted.
--    Budget policy: an admitted reservation counts toward its epoch even if the generation later fails
--    and the QLC is refunded. Only a reservation whose on-chain charge never landed (no QLC moved, no
--    provider call) is released; otherwise a wallet could grief the global budget by revoking its
--    allowance between the precheck and the charge.
-- 3. qlc_charge_wallets / qlc_charges: one charge per generation (generation_id UNIQUE), one sequence
--    number per wallet (UNIQUE), and compare-and-set state transitions:
--      pending → charged → settled → closed
--                        → refund_pending → refunded → closed
--      pending → charge_failed            (charge never landed; reservation released)
--    generation_id is the generations.id of the job; synchronous routes insert that row after the
--    provider succeeds, so there is deliberately no foreign key.
-- ============================================================

BEGIN;

-- ── 1. Campaign payout ──────────────────────────────────────────────────────
ALTER TABLE public.credit_campaigns
  ADD COLUMN payout TEXT NOT NULL DEFAULT 'credits' CHECK (payout IN ('credits', 'qlc'));
ALTER TABLE public.credit_grants
  ADD COLUMN qlc_delivery_id UUID REFERENCES public.qlc_deliveries (id) ON DELETE SET NULL;

-- ── 2. Generation epochs ────────────────────────────────────────────────────
CREATE TABLE public.qlc_generation_epochs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster           TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  status            TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  -- QLC base units (2 decimals): 1500000 = 15,000.00 QLC.
  limit_amount      BIGINT NOT NULL CHECK (limit_amount > 0 AND limit_amount % 5 = 0),
  -- Admitted reservations (net of charges that never landed). Never reduced by refunds.
  reserved_amount   BIGINT NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  released_amount   BIGINT NOT NULL DEFAULT 0 CHECK (released_amount >= 0),
  -- Informational: QLC refunded to members for failed generations of this epoch.
  refunded_amount   BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  reservations      INTEGER NOT NULL DEFAULT 0 CHECK (reservations >= 0),
  -- Idempotency key of the owner action that opened the epoch.
  request_key       TEXT NOT NULL UNIQUE CHECK (btrim(request_key) <> ''),
  opened_by         TEXT NOT NULL CHECK (btrim(opened_by) <> ''),
  open_reason       TEXT NOT NULL CHECK (btrim(open_reason) <> ''),
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at         TIMESTAMPTZ,
  paused_by         TEXT,
  pause_reason      TEXT CHECK (pause_reason IN ('budget_exhausted', 'owner')),
  pause_note        TEXT,
  -- The request that did not fit (budget_exhausted only).
  rejected_amount   BIGINT CHECK (rejected_amount IS NULL OR rejected_amount > 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qlc_generation_epochs_within_limit CHECK (reserved_amount <= limit_amount),
  CONSTRAINT qlc_generation_epochs_paused CHECK (
    (status = 'active' AND paused_at IS NULL AND pause_reason IS NULL)
    OR (status = 'paused' AND paused_at IS NOT NULL AND pause_reason IS NOT NULL AND paused_by IS NOT NULL)
  )
);
-- At most one active epoch per cluster; the current epoch is the newest row of the cluster.
CREATE UNIQUE INDEX qlc_generation_epochs_one_active ON public.qlc_generation_epochs (cluster) WHERE status = 'active';
CREATE INDEX qlc_generation_epochs_current ON public.qlc_generation_epochs (cluster, id DESC);

-- ── 3. Charges ──────────────────────────────────────────────────────────────
CREATE TABLE public.qlc_charge_wallets (
  cluster         TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  wallet_address  TEXT NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  last_seq        BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster, wallet_address)
);

CREATE TABLE public.qlc_charges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id      UUID NOT NULL UNIQUE,
  epoch_id           BIGINT NOT NULL REFERENCES public.qlc_generation_epochs (id),
  cluster            TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  user_id            UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
  wallet_address     TEXT NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  amount             BIGINT NOT NULL CHECK (amount > 0 AND amount % 5 = 0),
  seq                BIGINT NOT NULL CHECK (seq > 0),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'charged', 'settled', 'refund_pending', 'refunded', 'charge_failed', 'closed')),
  -- Final outcome kept when the on-chain receipt is closed.
  outcome            TEXT CHECK (outcome IN ('settled', 'refunded')),
  -- The generation failed while the charge outcome was still unknown: refund once it is confirmed.
  release_requested  BOOLEAN NOT NULL DEFAULT false,
  charge_signature   TEXT,
  refund_signature   TEXT,
  close_signature    TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  charged_at         TIMESTAMPTZ,
  settled_at         TIMESTAMPTZ,
  refunded_at        TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qlc_charges_wallet_seq UNIQUE (cluster, wallet_address, seq),
  CONSTRAINT qlc_charges_closed CHECK ((status = 'closed') = (outcome IS NOT NULL))
);
CREATE INDEX qlc_charges_epoch_idx ON public.qlc_charges (epoch_id);
CREATE INDEX qlc_charges_open_idx ON public.qlc_charges (cluster, status, updated_at) WHERE status IN ('pending', 'charged', 'refund_pending', 'settled', 'refunded');
CREATE INDEX qlc_charges_user_idx ON public.qlc_charges (user_id, created_at DESC);

-- Per-epoch review totals (counts by state). security_invoker: the caller's privileges apply (server only).
CREATE VIEW public.qlc_generation_epoch_totals WITH (security_invoker = true) AS
SELECT e.id AS epoch_id, e.cluster, e.status, e.limit_amount, e.reserved_amount, e.released_amount, e.refunded_amount,
       e.limit_amount - e.reserved_amount AS remaining_amount, e.reservations,
       count(c.*) FILTER (WHERE c.status = 'pending') AS pending_count,
       count(c.*) FILTER (WHERE c.status IN ('charged', 'refund_pending')) AS open_count,
       count(c.*) FILTER (WHERE c.status = 'settled' OR c.outcome = 'settled') AS settled_count,
       count(c.*) FILTER (WHERE c.status = 'refunded' OR c.outcome = 'refunded') AS refunded_count,
       count(c.*) FILTER (WHERE c.status = 'charge_failed') AS charge_failed_count,
       e.opened_at, e.opened_by, e.open_reason, e.paused_at, e.paused_by, e.pause_reason, e.rejected_amount
FROM public.qlc_generation_epochs e
LEFT JOIN public.qlc_charges c ON c.epoch_id = e.id
GROUP BY e.id;

ALTER TABLE public.qlc_generation_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qlc_charge_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qlc_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qlc_generation_epochs, public.qlc_charge_wallets, public.qlc_charges, public.qlc_generation_epoch_totals
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.qlc_generation_epochs, public.qlc_charge_wallets, public.qlc_charges TO service_role;
GRANT SELECT ON public.qlc_generation_epoch_totals TO service_role;

-- ── 4. Reservation (before the provider is called) ──────────────────────────
-- Lock order everywhere: epoch row, then wallet row. Returns
--   {status: 'reserved' | 'existing' | 'paused' | 'budget_exhausted' | 'no_epoch' | 'invalid_request', ...}.
CREATE OR REPLACE FUNCTION public.reserve_qlc_generation_charge(
  p_generation_id  UUID,
  p_cluster        TEXT,
  p_user_id        UUID,
  p_wallet         TEXT,
  p_amount         BIGINT,
  p_min_seq        BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge  public.qlc_charges%ROWTYPE;
  v_epoch   public.qlc_generation_epochs%ROWTYPE;
  v_seq     BIGINT;
BEGIN
  IF p_generation_id IS NULL OR p_cluster NOT IN ('devnet', 'mainnet-beta')
     OR p_wallet IS NULL OR p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_amount IS NULL OR p_amount <= 0 OR p_amount % 5 <> 0 OR p_min_seq IS NULL OR p_min_seq < 1 THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'existing', 'chargeStatus', v_charge.status, 'seq', v_charge.seq,
      'epochId', v_charge.epoch_id, 'amount', v_charge.amount, 'wallet', v_charge.wallet_address);
  END IF;

  SELECT * INTO v_epoch FROM public.qlc_generation_epochs
    WHERE cluster = p_cluster ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_epoch');
  END IF;
  IF v_epoch.status = 'paused' THEN
    RETURN jsonb_build_object('status', 'paused', 'epochId', v_epoch.id, 'pauseReason', v_epoch.pause_reason);
  END IF;
  IF v_epoch.reserved_amount + p_amount > v_epoch.limit_amount THEN
    UPDATE public.qlc_generation_epochs
      SET status = 'paused', paused_at = NOW(), paused_by = 'system', pause_reason = 'budget_exhausted',
          rejected_amount = p_amount, updated_at = NOW()
      WHERE id = v_epoch.id;
    RETURN jsonb_build_object('status', 'budget_exhausted', 'epochId', v_epoch.id,
      'remaining', v_epoch.limit_amount - v_epoch.reserved_amount);
  END IF;

  UPDATE public.qlc_generation_epochs
    SET reserved_amount = reserved_amount + p_amount, reservations = reservations + 1, updated_at = NOW()
    WHERE id = v_epoch.id;

  INSERT INTO public.qlc_charge_wallets (cluster, wallet_address) VALUES (p_cluster, p_wallet)
    ON CONFLICT (cluster, wallet_address) DO NOTHING;
  SELECT greatest(last_seq + 1, p_min_seq) INTO v_seq FROM public.qlc_charge_wallets
    WHERE cluster = p_cluster AND wallet_address = p_wallet FOR UPDATE;
  UPDATE public.qlc_charge_wallets SET last_seq = v_seq, updated_at = NOW()
    WHERE cluster = p_cluster AND wallet_address = p_wallet;

  INSERT INTO public.qlc_charges (generation_id, epoch_id, cluster, user_id, wallet_address, amount, seq)
    VALUES (p_generation_id, v_epoch.id, p_cluster, p_user_id, p_wallet, p_amount, v_seq);

  RETURN jsonb_build_object('status', 'reserved', 'seq', v_seq, 'epochId', v_epoch.id,
    'remaining', v_epoch.limit_amount - v_epoch.reserved_amount - p_amount);
EXCEPTION
  WHEN unique_violation THEN
    -- A concurrent reservation for the same generation won; report it (the whole attempt rolled back).
    SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'existing', 'chargeStatus', v_charge.status, 'seq', v_charge.seq,
        'epochId', v_charge.epoch_id, 'amount', v_charge.amount, 'wallet', v_charge.wallet_address);
    END IF;
    RAISE;
END;
$$;

-- The wallet's sequence was already used on chain (e.g. a later charge landed first): give the pending
-- charge a new, higher number. Only pending charges change.
CREATE OR REPLACE FUNCTION public.reassign_qlc_charge_seq(p_generation_id UUID, p_min_seq BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge  public.qlc_charges%ROWTYPE;
  v_seq     BIGINT;
BEGIN
  SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_charge'); END IF;
  IF v_charge.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'not_pending', 'chargeStatus', v_charge.status, 'seq', v_charge.seq);
  END IF;
  SELECT greatest(last_seq + 1, coalesce(p_min_seq, 1)) INTO v_seq FROM public.qlc_charge_wallets
    WHERE cluster = v_charge.cluster AND wallet_address = v_charge.wallet_address FOR UPDATE;
  UPDATE public.qlc_charge_wallets SET last_seq = v_seq, updated_at = NOW()
    WHERE cluster = v_charge.cluster AND wallet_address = v_charge.wallet_address;
  UPDATE public.qlc_charges SET seq = v_seq, attempts = attempts + 1, updated_at = NOW()
    WHERE id = v_charge.id AND status = 'pending';
  RETURN jsonb_build_object('status', 'reassigned', 'seq', v_seq);
END;
$$;

-- ── 5. Transitions (compare-and-set; repeating one is a no-op that reports the current state) ────
CREATE OR REPLACE FUNCTION public.mark_qlc_charge_charged(p_generation_id UUID, p_signature TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge public.qlc_charges%ROWTYPE;
BEGIN
  UPDATE public.qlc_charges
    SET status = 'charged', charge_signature = coalesce(p_signature, charge_signature), charged_at = NOW(), updated_at = NOW()
    WHERE generation_id = p_generation_id AND status = 'pending'
    RETURNING * INTO v_charge;
  IF NOT FOUND THEN
    SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_charge'); END IF;
    RETURN jsonb_build_object('status', 'unchanged', 'chargeStatus', v_charge.status, 'releaseRequested', v_charge.release_requested);
  END IF;
  RETURN jsonb_build_object('status', 'charged', 'chargeStatus', 'charged', 'releaseRequested', v_charge.release_requested);
END;
$$;

-- The charge never landed on chain (definitive refusal, or absent after its blockhash expired): no QLC
-- moved and no provider was called, so the reservation is released from the epoch budget.
CREATE OR REPLACE FUNCTION public.fail_qlc_charge(p_generation_id UUID, p_error TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge public.qlc_charges%ROWTYPE;
BEGIN
  SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_charge'); END IF;
  -- Epoch first, then charge (the reservation lock order).
  PERFORM 1 FROM public.qlc_generation_epochs WHERE id = v_charge.epoch_id FOR UPDATE;
  UPDATE public.qlc_charges
    SET status = 'charge_failed', last_error = left(p_error, 500), attempts = attempts + 1, updated_at = NOW()
    WHERE id = v_charge.id AND status = 'pending'
    RETURNING * INTO v_charge;
  IF NOT FOUND THEN
    SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
    RETURN jsonb_build_object('status', 'unchanged', 'chargeStatus', v_charge.status);
  END IF;
  UPDATE public.qlc_generation_epochs
    SET reserved_amount = reserved_amount - v_charge.amount, released_amount = released_amount + v_charge.amount, updated_at = NOW()
    WHERE id = v_charge.epoch_id;
  RETURN jsonb_build_object('status', 'charge_failed', 'released', v_charge.amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_qlc_charge(p_generation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge public.qlc_charges%ROWTYPE;
BEGIN
  UPDATE public.qlc_charges SET status = 'settled', settled_at = NOW(), updated_at = NOW()
    WHERE generation_id = p_generation_id AND status = 'charged'
    RETURNING * INTO v_charge;
  IF FOUND THEN RETURN jsonb_build_object('status', 'settled'); END IF;
  SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_charge'); END IF;
  RETURN jsonb_build_object('status', 'unchanged', 'chargeStatus', v_charge.status);
END;
$$;

-- Starts the single refund of a charged generation. A charge whose outcome is still unknown is
-- flagged instead (release_requested) and refunded as soon as it is confirmed.
CREATE OR REPLACE FUNCTION public.begin_qlc_charge_refund(p_generation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge public.qlc_charges%ROWTYPE;
BEGIN
  UPDATE public.qlc_charges SET status = 'refund_pending', updated_at = NOW()
    WHERE generation_id = p_generation_id AND status = 'charged'
    RETURNING * INTO v_charge;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'refund_pending', 'wallet', v_charge.wallet_address, 'seq', v_charge.seq,
      'amount', v_charge.amount);
  END IF;
  UPDATE public.qlc_charges SET release_requested = true, updated_at = NOW()
    WHERE generation_id = p_generation_id AND status = 'pending'
    RETURNING * INTO v_charge;
  IF FOUND THEN RETURN jsonb_build_object('status', 'release_requested'); END IF;
  SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_charge'); END IF;
  RETURN jsonb_build_object('status', 'unchanged', 'chargeStatus', v_charge.status, 'wallet', v_charge.wallet_address,
    'seq', v_charge.seq, 'amount', v_charge.amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_qlc_charge_refunded(p_generation_id UUID, p_signature TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge public.qlc_charges%ROWTYPE;
BEGIN
  SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_charge'); END IF;
  PERFORM 1 FROM public.qlc_generation_epochs WHERE id = v_charge.epoch_id FOR UPDATE;
  UPDATE public.qlc_charges
    SET status = 'refunded', refund_signature = coalesce(p_signature, refund_signature), refunded_at = NOW(), updated_at = NOW()
    WHERE id = v_charge.id AND status = 'refund_pending'
    RETURNING * INTO v_charge;
  IF NOT FOUND THEN
    SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
    RETURN jsonb_build_object('status', 'unchanged', 'chargeStatus', v_charge.status);
  END IF;
  -- Refunds are recorded for review but never reopen the epoch budget.
  UPDATE public.qlc_generation_epochs SET refunded_amount = refunded_amount + v_charge.amount, updated_at = NOW()
    WHERE id = v_charge.epoch_id;
  RETURN jsonb_build_object('status', 'refunded');
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_qlc_charge_closed(p_generation_id UUID, p_signature TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge public.qlc_charges%ROWTYPE;
BEGIN
  UPDATE public.qlc_charges
    SET outcome = status, status = 'closed', close_signature = coalesce(p_signature, close_signature), closed_at = NOW(), updated_at = NOW()
    WHERE generation_id = p_generation_id AND status IN ('settled', 'refunded')
    RETURNING * INTO v_charge;
  IF FOUND THEN RETURN jsonb_build_object('status', 'closed', 'outcome', v_charge.outcome); END IF;
  SELECT * INTO v_charge FROM public.qlc_charges WHERE generation_id = p_generation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_charge'); END IF;
  RETURN jsonb_build_object('status', 'unchanged', 'chargeStatus', v_charge.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_qlc_charge_error(p_generation_id UUID, p_error TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.qlc_charges SET attempts = attempts + 1, last_error = left(p_error, 500), updated_at = NOW()
    WHERE generation_id = p_generation_id;
$$;

-- ── 6. Owner epoch controls (never automatic; history is kept) ──────────────
-- Opens a new active epoch when none is active. Repeating the same request key returns the same
-- epoch, so a retried owner command cannot open two epochs.
CREATE OR REPLACE FUNCTION public.open_qlc_generation_epoch(
  p_cluster      TEXT,
  p_limit        BIGINT,
  p_opened_by    TEXT,
  p_reason       TEXT,
  p_request_key  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_epoch public.qlc_generation_epochs%ROWTYPE;
BEGIN
  IF p_cluster NOT IN ('devnet', 'mainnet-beta') OR p_limit IS NULL OR p_limit <= 0 OR p_limit % 5 <> 0
     OR coalesce(btrim(p_opened_by), '') = '' OR coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_request_key), '') = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('qlc-generation-epoch:' || p_cluster, 0));

  SELECT * INTO v_epoch FROM public.qlc_generation_epochs WHERE request_key = p_request_key;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_opened', 'epochId', v_epoch.id, 'epochStatus', v_epoch.status);
  END IF;
  SELECT * INTO v_epoch FROM public.qlc_generation_epochs WHERE cluster = p_cluster AND status = 'active';
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_active', 'epochId', v_epoch.id);
  END IF;

  INSERT INTO public.qlc_generation_epochs (cluster, status, limit_amount, request_key, opened_by, open_reason)
    VALUES (p_cluster, 'active', p_limit, p_request_key, btrim(p_opened_by), btrim(p_reason))
    RETURNING * INTO v_epoch;
  RETURN jsonb_build_object('status', 'opened', 'epochId', v_epoch.id, 'limit', v_epoch.limit_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_qlc_generation_epoch(p_cluster TEXT, p_paused_by TEXT, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_epoch public.qlc_generation_epochs%ROWTYPE;
BEGIN
  IF coalesce(btrim(p_paused_by), '') = '' THEN RETURN jsonb_build_object('status', 'invalid_request'); END IF;
  UPDATE public.qlc_generation_epochs
    SET status = 'paused', paused_at = NOW(), paused_by = btrim(p_paused_by), pause_reason = 'owner', pause_note = p_note, updated_at = NOW()
    WHERE cluster = p_cluster AND status = 'active'
    RETURNING * INTO v_epoch;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_active_epoch'); END IF;
  RETURN jsonb_build_object('status', 'paused', 'epochId', v_epoch.id);
END;
$$;

-- ── 7. Campaign grants: QLC payout ──────────────────────────────────────────
-- Same rules as before (cluster, mode, recipient, cap, one grant per recipient, exclusion groups);
-- a payout = 'qlc' campaign enqueues an exactly-once QLC delivery (whole QLC × 100 base units) for the
-- recipient's wallet instead of changing profiles.credits.
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
  v_delivery_key   TEXT;
  v_delivery_id    UUID;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_granted_by), '') = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'campaignId', p_campaign_id);
  END IF;

  SELECT * INTO v_campaign FROM public.credit_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unknown_campaign', 'campaignId', p_campaign_id);
  END IF;
  IF v_campaign.cluster <> p_cluster THEN
    RETURN jsonb_build_object('status', 'cluster_mismatch', 'campaignId', p_campaign_id);
  END IF;
  IF v_campaign.grant_mode <> p_grant_mode THEN
    RETURN jsonb_build_object('status', 'mode_mismatch', 'campaignId', p_campaign_id);
  END IF;

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
  -- QLC is delivered to a wallet: a QLC payout needs one, whatever the recipient scope.
  IF v_campaign.payout = 'qlc' AND (p_wallet_address IS NULL OR p_wallet_address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') THEN
    RETURN jsonb_build_object('status', 'invalid_recipient', 'campaignId', p_campaign_id);
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
      'amount', v_existing.amount, 'recipientNumber', v_existing.recipient_number, 'grantId', v_existing.id,
      'deliveryId', v_existing.qlc_delivery_id);
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

  IF v_campaign.payout = 'qlc' THEN
    PERFORM 1 FROM public.profiles WHERE id = p_user_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'unknown_user', 'campaignId', p_campaign_id);
    END IF;
    v_delivery_key := 'campaign:' || p_campaign_id || ':' || v_recipient_key;
    INSERT INTO public.qlc_deliveries (delivery_key, delivery_id_hex, source_type, source_id, kind, user_id,
                                       wallet_address, cluster, qlc_amount)
    VALUES (v_delivery_key, encode(sha256(convert_to(v_delivery_key, 'UTF8')), 'hex'), 'campaign', p_campaign_id,
            'campaign', p_user_id, p_wallet_address, v_campaign.cluster, v_amount::BIGINT * 100)
    RETURNING id INTO v_delivery_id;
  ELSE
    UPDATE public.profiles
      SET credits = credits + v_amount, updated_at = NOW()
      WHERE id = p_user_id
      RETURNING credits INTO v_balance;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'unknown_user', 'campaignId', p_campaign_id);
    END IF;
    INSERT INTO public.credit_transactions (user_id, amount, type, description)
    VALUES (p_user_id, v_amount, CASE WHEN v_campaign.grant_mode = 'claim' THEN 'promo' ELSE 'bonus' END,
            p_campaign_id || ': ' || p_reason)
    RETURNING id INTO v_tx_id;
  END IF;

  v_number := v_campaign.granted_count + 1;
  UPDATE public.credit_campaigns SET granted_count = v_number, updated_at = NOW() WHERE id = p_campaign_id;

  INSERT INTO public.credit_grants (campaign_id, cluster, recipient_key, user_id, wallet_address, amount,
                                    recipient_number, reason, granted_by, credit_transaction_id, qlc_delivery_id)
  VALUES (p_campaign_id, v_campaign.cluster, v_recipient_key, p_user_id, p_wallet_address, v_amount,
          v_number, p_reason, p_granted_by, v_tx_id, v_delivery_id)
  RETURNING id INTO v_grant_id;

  RETURN jsonb_build_object('status', 'granted', 'campaignId', p_campaign_id, 'amount', v_amount,
    'recipientNumber', v_number, 'grantId', v_grant_id, 'balance', v_balance, 'deliveryId', v_delivery_id);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'already_granted', 'campaignId', p_campaign_id);
END;
$$;

-- ── 8. Privileges: server only ──────────────────────────────────────────────
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.reserve_qlc_generation_charge(UUID, TEXT, UUID, TEXT, BIGINT, BIGINT)',
    'public.reassign_qlc_charge_seq(UUID, BIGINT)',
    'public.mark_qlc_charge_charged(UUID, TEXT)',
    'public.fail_qlc_charge(UUID, TEXT)',
    'public.settle_qlc_charge(UUID)',
    'public.begin_qlc_charge_refund(UUID)',
    'public.mark_qlc_charge_refunded(UUID, TEXT)',
    'public.mark_qlc_charge_closed(UUID, TEXT)',
    'public.record_qlc_charge_error(UUID, TEXT)',
    'public.open_qlc_generation_epoch(TEXT, BIGINT, TEXT, TEXT, TEXT)',
    'public.pause_qlc_generation_epoch(TEXT, TEXT, TEXT)',
    'public.grant_campaign_credits(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;
