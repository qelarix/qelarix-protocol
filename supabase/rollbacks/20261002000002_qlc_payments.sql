-- Rollback for supabase/proposed/20261002000002_qlc_payments.sql
--
-- Removes the payment configuration, quotes, the delivery queue and the settlement functions.
-- QLC already delivered stays in members' wallets on chain (the chain is the source of truth). The
-- intent and delivery rows are the payment audit trail: export public.payment_intents and
-- public.qlc_deliveries before running this if any exist, and finish pending deliveries first.
BEGIN;

DROP FUNCTION IF EXISTS public.settle_payment_intent(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.record_qlc_delivery_attempt(UUID, TEXT);
DROP TABLE IF EXISTS public.payment_intents;
DROP TABLE IF EXISTS public.qlc_deliveries;
DROP TABLE IF EXISTS public.qlc_price_packs;
DROP TABLE IF EXISTS public.payment_assets;

COMMIT;
