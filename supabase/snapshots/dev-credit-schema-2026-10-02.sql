-- ============================================================
-- Credit-relevant schema of the DEV project (qcggkvubogqlmxcepvbr), captured on
-- 2026-10-02 with scripts/supabase-security-verify.mjs (read-only introspection).
--
-- Used only to test migrations and rollbacks against a local throwaway Postgres
-- (scripts/credit-campaigns-db-check.mjs). Never run against a Supabase project.
-- Expects the Supabase roles (anon, authenticated, service_role) and auth.users.
-- Columns, constraints, policies, table grants and function bodies match the live
-- project; unrelated tables and columns are omitted.
-- ============================================================

CREATE TABLE public.profiles (
  id                       UUID PRIMARY KEY REFERENCES auth.users(id),
  username                 TEXT,
  full_name                TEXT,
  avatar_url               TEXT,
  plan                     TEXT DEFAULT 'free' CONSTRAINT profiles_plan_check
                             CHECK (plan = ANY (ARRAY['free','starter','pro','business','ultra','agency','tester'])),
  credits                  INTEGER DEFAULT 100,
  credits_used             INTEGER DEFAULT 0,
  early_adopter            BOOLEAN DEFAULT false,
  early_adopter_number     INTEGER,
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT,
  subscription_status      TEXT DEFAULT 'inactive',
  subscription_period_end  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now(),
  email                    TEXT,
  display_name             TEXT,
  bio                      TEXT,
  followers_count          INTEGER DEFAULT 0,
  following_count          INTEGER DEFAULT 0,
  total_likes              INTEGER DEFAULT 0,
  is_creator               BOOLEAN DEFAULT false,
  storage_used_bytes       BIGINT NOT NULL DEFAULT 0,
  storage_limit_bytes      BIGINT
);

CREATE TABLE public.credit_transactions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount                    INTEGER NOT NULL,
  type                      TEXT CONSTRAINT credit_transactions_type_check
                              CHECK (type = ANY (ARRAY['subscription','topup','bonus','promo','usage','refund'])),
  description               TEXT,
  stripe_payment_intent_id  TEXT,
  created_at                TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.early_adopter_counter (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  count      INTEGER DEFAULT 0,
  max_count  INTEGER DEFAULT 100
);
INSERT INTO public.early_adopter_counter VALUES (1, 18, 100);

CREATE TABLE public.generations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID,
  likes_count   INTEGER DEFAULT 0,
  views_count   INTEGER DEFAULT 0,
  shares_count  INTEGER DEFAULT 0
);

CREATE TABLE public.monthly_creator_stats (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID,
  month        INTEGER NOT NULL,
  year         INTEGER NOT NULL,
  likes_count  INTEGER DEFAULT 0,
  views_count  INTEGER DEFAULT 0,
  score        INTEGER,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, month, year)
);

-- Row level security and policies exactly as live.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.early_adopter_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_creator_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON public.profiles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "own profile" ON public.profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "own transactions" ON public.credit_transactions FOR SELECT USING (auth.uid() = user_id);

-- Table grants as live.
REVOKE ALL ON public.profiles, public.credit_transactions, public.early_adopter_counter FROM anon, authenticated;
GRANT REFERENCES, TRIGGER, TRUNCATE ON public.profiles, public.credit_transactions, public.early_adopter_counter TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE
  ON public.profiles, public.credit_transactions, public.early_adopter_counter TO authenticated;
GRANT ALL ON public.profiles, public.credit_transactions, public.early_adopter_counter, public.generations,
  public.monthly_creator_stats TO service_role;

-- Functions: live bodies (SECURITY DEFINER, default PUBLIC EXECUTE, no search_path).
CREATE OR REPLACE FUNCTION public.add_credits(p_user_id uuid, p_amount integer, p_desc text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  UPDATE public.profiles SET credits=credits+p_amount WHERE id=p_user_id;
  INSERT INTO public.credit_transactions(user_id,amount,type,description) VALUES(p_user_id,p_amount,'topup',p_desc);
END;
$function$;

CREATE OR REPLACE FUNCTION public.deduct_credits(p_user_id uuid, p_amount integer, p_desc text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  UPDATE public.profiles SET credits=credits-p_amount, credits_used=credits_used+p_amount WHERE id=p_user_id AND credits>=p_amount;
  IF FOUND THEN INSERT INTO public.credit_transactions(user_id,amount,type,description) VALUES(p_user_id,-p_amount,'usage',p_desc); RETURN TRUE; END IF;
  RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE adopter_num INTEGER; bonus INTEGER := 100;
BEGIN
  UPDATE public.early_adopter_counter
  SET count = count + 1 WHERE id = 1 AND count < max_count
  RETURNING count INTO adopter_num;

  IF adopter_num IS NOT NULL THEN bonus := 1100; END IF;

  INSERT INTO public.profiles(id, credits, early_adopter, early_adopter_number)
  VALUES(NEW.id, bonus, adopter_num IS NOT NULL, adopter_num);
  RETURN NEW;
END;
$function$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.increment_likes(gen_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.generations SET likes_count = likes_count + 1 WHERE id = gen_id;
$function$;
CREATE OR REPLACE FUNCTION public.decrement_likes(gen_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.generations SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = gen_id;
$function$;
CREATE OR REPLACE FUNCTION public.increment_views(gen_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.generations SET views_count = views_count + 1 WHERE id = gen_id;
$function$;
CREATE OR REPLACE FUNCTION public.increment_shares(gen_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.generations SET shares_count = shares_count + 1 WHERE id = gen_id;
$function$;
CREATE OR REPLACE FUNCTION public.increment_followers(profile_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.profiles SET followers_count = followers_count + 1 WHERE id = profile_id;
$function$;
CREATE OR REPLACE FUNCTION public.decrement_followers(profile_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.profiles SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = profile_id;
$function$;
CREATE OR REPLACE FUNCTION public.increment_following(profile_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.profiles SET following_count = following_count + 1 WHERE id = profile_id;
$function$;
CREATE OR REPLACE FUNCTION public.decrement_following(profile_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $function$
  UPDATE public.profiles SET following_count = GREATEST(following_count - 1, 0) WHERE id = profile_id;
$function$;
CREATE OR REPLACE FUNCTION public.update_monthly_stats_like(p_user_id uuid, p_amount integer)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  INSERT INTO public.monthly_creator_stats (user_id, month, year, likes_count, views_count)
  VALUES (p_user_id, EXTRACT(MONTH FROM NOW()), EXTRACT(YEAR FROM NOW()), p_amount, 0)
  ON CONFLICT (user_id, month, year)
  DO UPDATE SET likes_count = monthly_creator_stats.likes_count + p_amount;
END;
$function$;
CREATE OR REPLACE FUNCTION public.update_monthly_stats_view(p_user_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  INSERT INTO public.monthly_creator_stats (user_id, month, year, likes_count, views_count)
  VALUES (p_user_id, EXTRACT(MONTH FROM NOW()), EXTRACT(YEAR FROM NOW()), 0, 1)
  ON CONFLICT (user_id, month, year)
  DO UPDATE SET views_count = monthly_creator_stats.views_count + 1;
END;
$function$;
