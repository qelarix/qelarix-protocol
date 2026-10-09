-- Monthly leaderboard rewards

CREATE TABLE IF NOT EXISTS public.leaderboard_winners (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  likes_count INTEGER NOT NULL DEFAULT 0,
  credits_awarded INTEGER NOT NULL,
  email_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, month, year, rank)
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name TEXT;

-- Current month top creators by likes
CREATE OR REPLACE VIEW public.monthly_leaderboard AS
SELECT
  p.id AS user_id,
  p.full_name,
  p.email,
  p.avatar_url,
  COUNT(gl.id) AS likes_count,
  EXTRACT(MONTH FROM NOW()) AS month,
  EXTRACT(YEAR FROM NOW()) AS year
FROM public.profiles p
JOIN public.generations g ON g.user_id = p.id
  AND g.is_public = true
  AND EXTRACT(MONTH FROM g.created_at) = EXTRACT(MONTH FROM NOW())
  AND EXTRACT(YEAR FROM g.created_at) = EXTRACT(YEAR FROM NOW())
JOIN public.generation_likes gl ON gl.generation_id = g.id
  AND EXTRACT(MONTH FROM gl.created_at) = EXTRACT(MONTH FROM NOW())
  AND EXTRACT(YEAR FROM gl.created_at) = EXTRACT(YEAR FROM NOW())
GROUP BY p.id, p.full_name, p.email, p.avatar_url
ORDER BY likes_count DESC;

-- Last month top 3 (for cron job)
CREATE OR REPLACE VIEW public.last_month_leaderboard AS
SELECT
  p.id AS user_id,
  p.full_name,
  p.email,
  COUNT(gl.id) AS likes_count,
  EXTRACT(MONTH FROM NOW() - INTERVAL '1 month') AS month,
  EXTRACT(YEAR FROM NOW() - INTERVAL '1 month') AS year,
  ROW_NUMBER() OVER (ORDER BY COUNT(gl.id) DESC) AS rank
FROM public.profiles p
JOIN public.generations g ON g.user_id = p.id
  AND g.is_public = true
  AND EXTRACT(MONTH FROM g.created_at) = EXTRACT(MONTH FROM NOW() - INTERVAL '1 month')
  AND EXTRACT(YEAR FROM g.created_at) = EXTRACT(YEAR FROM NOW() - INTERVAL '1 month')
JOIN public.generation_likes gl ON gl.generation_id = g.id
  AND EXTRACT(MONTH FROM gl.created_at) = EXTRACT(MONTH FROM NOW() - INTERVAL '1 month')
  AND EXTRACT(YEAR FROM gl.created_at) = EXTRACT(YEAR FROM NOW() - INTERVAL '1 month')
GROUP BY p.id, p.full_name, p.email
ORDER BY likes_count DESC
LIMIT 3;

-- Add credits helper
CREATE OR REPLACE FUNCTION public.add_credits(p_user_id UUID, p_amount INTEGER, p_desc TEXT DEFAULT '')
RETURNS void AS $$
  UPDATE public.profiles SET credits = credits + p_amount WHERE id = p_user_id;
$$ LANGUAGE sql SECURITY DEFINER;
