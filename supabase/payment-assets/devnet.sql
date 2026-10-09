-- ============================================================
-- Payment assets for the DEVNET Supabase project only.
-- Run after 20261002000002_qlc_payments has been applied. Never run on mainnet.
-- PROPOSED: not applied yet (owner approval pending).
-- Inserts only missing assets; existing rows (and any operator edits) are left as they are.
--
-- An asset is payable only when is_enabled = true AND approved_by / approved_at are set (enforced
-- by a constraint). Treasuries are public addresses only; no key is ever stored.
--   disable now         UPDATE public.payment_assets SET is_enabled = false, updated_at = NOW() WHERE id = 'devnet-sol';
--   enable after review UPDATE public.payment_assets SET is_enabled = true, approved_by = 'PixiMan',
--                         approved_at = NOW(), approval_note = '...', updated_at = NOW() WHERE id = 'devnet-sol';
--
-- Future rails are rows, not code:
--   QLX (once the token exists and its price source is approved), e.g.
--     INSERT INTO public.payment_assets (id, cluster, symbol, kind, mint, token_program, decimals, treasury_address,
--                                        price_source, quote_ttl_secs, sort_order)
--     VALUES ('devnet-qlx', 'devnet', 'QLX', 'spl-token', '<QLX mint>', '<token program>', <decimals>, '<treasury>',
--             '{"kind": "pyth-account", "account": "<price account>", "feedId": "<feed id>", "maxAgeSecs": 60, "maxConfidenceBps": 100}', 120, 30);
--   Partner tokens: the same INSERT with the partner's mint, token program, decimals, treasury and
--   trusted price source. They stay disabled until PixiMan approves them (is_enabled + approved_*).
-- ============================================================

INSERT INTO public.payment_assets
  (id, cluster, symbol, kind, mint, token_program, decimals, treasury_address, price_source, quote_ttl_secs,
   is_enabled, approved_by, approved_at, approval_note, sort_order)
VALUES
  -- Primary rail: Circle devnet USDC, 1 USDC = 1 USD.
  ('devnet-usdc', 'devnet', 'USDC', 'spl-token', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
   'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 6, 'AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw',
   '{"kind": "usd-peg"}'::jsonb, 900,
   true, 'PixiMan', '2026-10-02T00:00:00Z', 'USDC -> QLC primary rail (QLC Source of Truth, 2026-10-02)', 10),
  -- SOL rail: SOL/USD from Pyth's verified on-chain price account (Full verification, <= 60 s old,
  -- confidence <= 1 %); short quotes. QLC stays priced in USD; SOL is only an alternative payment asset.
  ('devnet-sol', 'devnet', 'SOL', 'native-sol', NULL, NULL, 9, 'AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw',
   '{"kind": "pyth-account", "account": "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", "feedId": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "maxAgeSecs": 60, "maxConfidenceBps": 100}'::jsonb, 120,
   true, 'PixiMan', '2026-10-03T00:00:00Z', 'SOL -> QLC rail; Pyth SOL/USD verified price source approved by the owner (2026-10-03)', 20)
ON CONFLICT (id) DO NOTHING;
