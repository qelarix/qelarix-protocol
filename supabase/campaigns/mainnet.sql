-- ============================================================
-- Credit campaigns for the MAINNET Supabase project only.
-- Run after 20261002000001_credit_campaigns has been applied. Never run on devnet.
-- Idempotent: re-running updates the definitions but never resets granted_count.
-- ============================================================

INSERT INTO public.credit_campaigns
  (id, cluster, grant_mode, recipient_scope, amount, max_recipients, priority, eligibility, is_active, description)
VALUES
  -- Launch campaign: first 50 successful claims, 200 QLC each, one per wallet.
  -- Inactive until launch: UPDATE public.credit_campaigns SET is_active = true WHERE id = 'mainnet-launch-2026';
  ('mainnet-launch-2026', 'mainnet-beta', 'claim', 'wallet', 200, 50, 10,
   '[{"type": "wallet_identity"}]'::jsonb, false,
   'Mainnet launch: 200 QLC for the first 50 wallets'),
  -- Operator grants (beta testers, ambassadors, bug bounties, creator rewards, ...).
  -- amount is the maximum per grant; each grant needs its own grant key.
  ('mainnet-manual-grants', 'mainnet-beta', 'manual', 'grant_key', 10000, NULL, 1000,
   '[]'::jsonb, true,
   'Operator-issued QLC grants')
ON CONFLICT (id) DO UPDATE SET
  amount          = EXCLUDED.amount,
  max_recipients  = EXCLUDED.max_recipients,
  priority        = EXCLUDED.priority,
  eligibility     = EXCLUDED.eligibility,
  description     = EXCLUDED.description,
  updated_at      = NOW();
