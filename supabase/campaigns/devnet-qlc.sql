-- ============================================================
-- On-chain QLC campaign for the DEVNET Supabase project only (open-wallet Devnet / Colosseum testing).
-- Run after supabase/proposed/20261006000001_qlc_generation_billing.sql. Never run on mainnet.
-- PROPOSED: not applied. Inserted INACTIVE; it is switched on only by the owner-authorized QLC billing
-- cutover, together with GENERATION_BILLING=qlc and an opened test epoch:
--   UPDATE public.credit_campaigns SET is_active = true  WHERE id = 'devnet-open-qlc';
--   UPDATE public.credit_campaigns SET is_active = false WHERE id = 'devnet-test-credits';
--
-- Every wallet (no allowlist) receives 500.00 QLC once: the grant enqueues an exactly-once delivery in
-- qlc_deliveries (key campaign:devnet-open-qlc:wallet:<address>), executed by the program's deliver
-- instruction (Program Vault inventory first, mint only the shortfall, minting capped per window).
-- No recipient cap: the global test-epoch consumption budget is the safety ceiling.
-- ============================================================
INSERT INTO public.credit_campaigns
  (id, cluster, grant_mode, recipient_scope, amount, max_recipients, priority, eligibility, usage_scope, is_active, description, payout)
VALUES
  ('devnet-open-qlc', 'devnet', 'claim', 'wallet', 500, NULL, 5,
   '[{"type": "wallet_identity"}]'::jsonb, '{}'::jsonb, false,
   'Devnet open testing: 500 QLC per wallet', 'qlc')
ON CONFLICT (id) DO NOTHING;
