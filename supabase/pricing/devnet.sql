-- ============================================================
-- QLC price packs for the DEVNET Supabase project only.
-- Run after 20261002000002_qlc_payments has been applied. Never run on mainnet.
-- PROPOSED: not applied yet (owner approval pending).
-- Mirrors the current top-up packs; 1 legacy credit = 1 QLC.
-- Inserts only missing packs; existing rows (and any operator edits) are left as they are.
--
-- Prices are runtime configuration: the app reads this table on every quote, so edits apply to the
-- next quote without a deploy. Quotes already issued keep the price they were created with.
-- qlc_amount is QLC base units (2 decimals, multiple of 5): 50000 = 500.00 QLC.
-- usd_value_micros is the canonical pack value in USD micro-dollars: 4990000 = $4.99. The payment
-- amount in USDC, SOL or any other enabled asset is derived from it at quote time.
--   change a price      UPDATE public.qlc_price_packs SET usd_value_micros = 4490000, updated_at = NOW() WHERE id = 'devnet-500';
--   hide / show a pack  UPDATE public.qlc_price_packs SET is_active = false WHERE id = 'devnet-10000';
--   new pack            INSERT a row with cluster 'devnet' (sort_order sets the position).
--   temporary discount  INSERT INTO public.qlc_price_packs
--                         (id, cluster, qlc_amount, usd_value_micros, list_usd_value_micros, label, badge, replaces_pack_id, offer, sort_order, starts_at, ends_at)
--                         VALUES ('devnet-1500-launch', 'devnet', 150000, 9990000, 12990000, 'Popular Pack', 'Launch offer',
--                                 'devnet-1500', 'launch-week', 20, '2026-10-12T00:00:00Z', '2026-10-19T00:00:00Z');
--   bonus QLC offer     same as above with a larger qlc_amount and the regular usd_value_micros.
--   regional pricing    INSERT rows with region = 'DE'. Visitors from that region see only its live
--                       packs; the region comes from the trusted header named in PRICING_REGION_HEADER.
-- ============================================================

INSERT INTO public.qlc_price_packs (id, cluster, qlc_amount, usd_value_micros, label, badge, highlighted, sort_order)
VALUES
  ('devnet-500',   'devnet',   50000,  4990000, 'Starter Pack',  NULL,      false, 10),
  ('devnet-1500',  'devnet',  150000, 12990000, 'Popular Pack',  'Popular', true,  20),
  ('devnet-5000',  'devnet',  500000, 37990000, 'Pro Pack',      NULL,      false, 30),
  ('devnet-10000', 'devnet', 1000000, 99990000, 'Business Pack', NULL,      false, 40)
ON CONFLICT (id) DO NOTHING;
