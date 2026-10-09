-- ============================================================
-- QLC price packs for the MAINNET Supabase project only. NOT APPLIED: no mainnet project exists yet.
-- Run after 20261002000002_qlc_payments has been applied there.
-- Every pack is inserted inactive; mainnet payments also stay disabled in code (PAYMENT_CLUSTERS)
-- until the launch task enables them. Final launch prices are an owner decision.
--   activate            UPDATE public.qlc_price_packs SET is_active = true WHERE cluster = 'mainnet-beta';
-- Discounts, offers and regional prices work as described in supabase/pricing/devnet.sql.
-- ============================================================

INSERT INTO public.qlc_price_packs (id, cluster, qlc_amount, usd_value_micros, label, badge, highlighted, sort_order, is_active)
VALUES
  ('mainnet-500',   'mainnet-beta',   50000,  4990000, 'Starter Pack',  NULL,      false, 10, false),
  ('mainnet-1500',  'mainnet-beta',  150000, 12990000, 'Popular Pack',  'Popular', true,  20, false),
  ('mainnet-5000',  'mainnet-beta',  500000, 37990000, 'Pro Pack',      NULL,      false, 30, false),
  ('mainnet-10000', 'mainnet-beta', 1000000, 99990000, 'Business Pack', NULL,      false, 40, false)
ON CONFLICT (id) DO NOTHING;
