-- Social counters: likes table, per-generation like / view / share counters and atomic RPCs.
-- Already applied on the dev project; idempotent.

-- Likes
CREATE TABLE IF NOT EXISTS public.likes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  generation_id UUID REFERENCES public.generations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, generation_id)
);

-- Counter columns on generations
ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shares_count INTEGER DEFAULT 0;

-- Atomic increment / decrement RPCs
CREATE OR REPLACE FUNCTION increment_likes(gen_id UUID)
RETURNS void AS $$
  UPDATE public.generations SET likes_count = likes_count + 1 WHERE id = gen_id;
$$ LANGUAGE SQL SECURITY DEFINER;

CREATE OR REPLACE FUNCTION decrement_likes(gen_id UUID)
RETURNS void AS $$
  UPDATE public.generations SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = gen_id;
$$ LANGUAGE SQL SECURITY DEFINER;

CREATE OR REPLACE FUNCTION increment_views(gen_id UUID)
RETURNS void AS $$
  UPDATE public.generations SET views_count = views_count + 1 WHERE id = gen_id;
$$ LANGUAGE SQL SECURITY DEFINER;

CREATE OR REPLACE FUNCTION increment_shares(gen_id UUID)
RETURNS void AS $$
  UPDATE public.generations SET shares_count = shares_count + 1 WHERE id = gen_id;
$$ LANGUAGE SQL SECURITY DEFINER;
