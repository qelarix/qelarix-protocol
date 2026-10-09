-- Explore / publish / likes migration

ALTER TABLE public.generations ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;
ALTER TABLE public.generations ADD COLUMN IF NOT EXISTS views INTEGER DEFAULT 0;
ALTER TABLE public.generations ADD COLUMN IF NOT EXISTS title TEXT;

CREATE TABLE IF NOT EXISTS public.generation_likes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id UUID REFERENCES public.generations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(generation_id, user_id)
);

CREATE OR REPLACE FUNCTION public.increment_views(p_gen_id UUID)
RETURNS void AS $$
  UPDATE public.generations SET views = views + 1 WHERE id = p_gen_id;
$$ LANGUAGE sql SECURITY DEFINER;
