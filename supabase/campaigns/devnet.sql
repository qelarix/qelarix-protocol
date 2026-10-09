-- ============================================================
-- Credit campaigns for the DEVNET Supabase project only.
-- Run after 20261002000001_credit_campaigns has been applied. Never run on mainnet.
-- Applied to the dev project (qcggkvubogqlmxcepvbr) on 2026-10-02.
-- Devnet credits are test-only: they live in the devnet project, are scoped to
-- cluster 'devnet', and are refused by any deployment configured for mainnet.
-- Inserts only missing campaigns; existing rows (and any operator edits) are left as they are.
--
-- Everything is configuration, no code change needed:
--   amount per tester    UPDATE public.credit_campaigns SET amount = 1500 WHERE id = 'devnet-test-credits';
--   tester cap           UPDATE public.credit_campaigns SET max_recipients = 30 WHERE id = 'devnet-test-credits';
--   stop (immediate)     UPDATE public.credit_campaigns SET is_active = false WHERE id = 'devnet-test-credits';
--   resume               UPDATE public.credit_campaigns SET is_active = true  WHERE id = 'devnet-test-credits';
--     Stopping blocks every new test grant from the moment it commits (the grant function
--     re-reads is_active under the campaign row lock). Resuming keeps granted_count, existing
--     grants and audit rows; testers who already received credits stay at already_granted.
--   operator top-ups     have their own switch: UPDATE ... SET is_active = false WHERE id = 'devnet-manual-grants';
--     Manual grants cannot be issued into devnet-test-credits (mode_mismatch) and never use its tester cap.
--   time window          UPDATE public.credit_campaigns SET starts_at = '...', ends_at = '...' WHERE id = 'devnet-test-credits';
--   allowed testers      UPDATE public.credit_campaigns
--                          SET eligibility = '[{"type": "user_allowlist", "userIds": ["<profile uuid>"]}]'
--                          WHERE id = 'devnet-test-credits';
--   intended model group UPDATE public.credit_campaigns SET usage_scope = '{"modelGroup": "low-cost"}' WHERE id = 'devnet-test-credits';
--   extra QLC to one tester: npm run credits:grant -- --campaign devnet-manual-grants ...
--   another test campaign: INSERT a new row with cluster 'devnet'.
-- ============================================================

INSERT INTO public.credit_campaigns
  (id, cluster, grant_mode, recipient_scope, amount, max_recipients, priority, eligibility, usage_scope, is_active, description)
VALUES
  -- Test credits: once per tester. 1,000 QLC and the 20-tester cap are the owner's current settings.
  ('devnet-test-credits', 'devnet', 'claim', 'user', 1000, 20, 10,
   '[]'::jsonb, '{"modelGroup": "low-cost"}'::jsonb, true,
   'Devnet test credits'),
  -- Operator top-ups for individual testers; amount is the maximum per grant.
  ('devnet-manual-grants', 'devnet', 'manual', 'grant_key', 10000, NULL, 1000,
   '[]'::jsonb, '{}'::jsonb, true,
   'Operator-issued devnet test credits')
ON CONFLICT (id) DO NOTHING;
