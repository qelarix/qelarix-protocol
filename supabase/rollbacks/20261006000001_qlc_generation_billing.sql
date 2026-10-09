-- ============================================================
-- Rollback of supabase/proposed/20261006000001_qlc_generation_billing.sql
--
-- Removes generation billing, test epochs and the campaign QLC payout, and restores
-- grant_campaign_credits exactly as defined by 20261002000001_credit_campaigns.sql.
-- Run only while the deployment bills in database credits (GENERATION_BILLING unset / 'credits'):
-- dropping qlc_charges discards the off-chain mirror of on-chain charges (the on-chain receipts and
-- balances are unaffected). QLC deliveries already enqueued by QLC campaigns stay in qlc_deliveries.
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.qlc_generation_epoch_totals;
DROP FUNCTION IF EXISTS public.reserve_qlc_generation_charge(UUID, TEXT, UUID, TEXT, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS public.reassign_qlc_charge_seq(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.mark_qlc_charge_charged(UUID, TEXT);
DROP FUNCTION IF EXISTS public.fail_qlc_charge(UUID, TEXT);
DROP FUNCTION IF EXISTS public.settle_qlc_charge(UUID);
DROP FUNCTION IF EXISTS public.begin_qlc_charge_refund(UUID);
DROP FUNCTION IF EXISTS public.mark_qlc_charge_refunded(UUID, TEXT);
DROP FUNCTION IF EXISTS public.mark_qlc_charge_closed(UUID, TEXT);
DROP FUNCTION IF EXISTS public.record_qlc_charge_error(UUID, TEXT);
DROP FUNCTION IF EXISTS public.open_qlc_generation_epoch(TEXT, BIGINT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.pause_qlc_generation_epoch(TEXT, TEXT, TEXT);
DROP TABLE IF EXISTS public.qlc_charges;
DROP TABLE IF EXISTS public.qlc_charge_wallets;
DROP TABLE IF EXISTS public.qlc_generation_epochs;
ALTER TABLE public.credit_grants DROP COLUMN IF EXISTS qlc_delivery_id;
-- Without the payout column a QLC campaign would grant database credits instead: switch it off first.
UPDATE public.credit_campaigns SET is_active = false, updated_at = NOW() WHERE payout = 'qlc';
ALTER TABLE public.credit_campaigns DROP COLUMN IF EXISTS payout;

-- Original grant function (verbatim from 20261002000001_credit_campaigns.sql).
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
