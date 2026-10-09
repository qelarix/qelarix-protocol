-- ============================================================
-- NextAuth Integration Schema
-- Migration: 20260506000002_nextauth
-- ============================================================

-- Remove FK constraint on profiles.id so NextAuth OAuth users
-- (stored in next_auth.users) can also have profiles
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- ============================================================
-- next_auth SCHEMA — required by @auth/supabase-adapter
-- ============================================================

CREATE SCHEMA IF NOT EXISTS next_auth;

GRANT USAGE ON SCHEMA next_auth TO service_role;
GRANT ALL ON SCHEMA next_auth TO postgres;

CREATE TABLE IF NOT EXISTS next_auth.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text,
  email text,
  "emailVerified" timestamptz,
  image text,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS next_auth.accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  type text NOT NULL,
  provider text NOT NULL,
  "providerAccountId" text NOT NULL,
  refresh_token text,
  access_token text,
  expires_at bigint,
  token_type text,
  scope text,
  id_token text,
  session_state text,
  "userId" uuid,
  PRIMARY KEY (id),
  FOREIGN KEY ("userId") REFERENCES next_auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS next_auth.sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  "sessionToken" text NOT NULL,
  "userId" uuid,
  expires timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE ("sessionToken"),
  FOREIGN KEY ("userId") REFERENCES next_auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS next_auth.verification_tokens (
  identifier text,
  token text,
  expires timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- Helper: returns current NextAuth user id from JWT claim
CREATE OR REPLACE FUNCTION next_auth.uid()
RETURNS uuid LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', TRUE), ''),
    (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'sub')
  )::uuid
$$;

-- ============================================================
-- FUNCTION: provision_nextauth_profile
-- Called from application layer when a NextAuth OAuth user
-- registers for the first time (since auth.users trigger
-- only fires for Supabase Auth signups).
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_nextauth_profile(
  p_user_id   UUID,
  p_full_name TEXT DEFAULT NULL,
  p_avatar    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  adopter_num INTEGER;
  bonus       INTEGER := 100;
  result      JSONB;
BEGIN
  -- No-op if profile already exists
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    SELECT jsonb_build_object(
      'early_adopter', early_adopter,
      'early_adopter_number', early_adopter_number,
      'credits', credits
    ) INTO result FROM public.profiles WHERE id = p_user_id;
    RETURN result;
  END IF;

  -- Atomically claim early adopter slot
  UPDATE public.early_adopter_counter
    SET count = count + 1
    WHERE id = 1 AND count < max_count
    RETURNING count INTO adopter_num;

  IF adopter_num IS NOT NULL THEN
    bonus := 1100;
  END IF;

  INSERT INTO public.profiles (id, full_name, avatar_url, credits, early_adopter, early_adopter_number)
  VALUES (p_user_id, p_full_name, p_avatar, bonus, adopter_num IS NOT NULL, adopter_num);

  IF adopter_num IS NOT NULL THEN
    INSERT INTO public.credit_transactions(user_id, amount, type, description)
    VALUES (p_user_id, 1000, 'promo', 'Early Adopter #' || adopter_num);
  END IF;

  result := jsonb_build_object(
    'early_adopter', adopter_num IS NOT NULL,
    'early_adopter_number', adopter_num,
    'credits', bonus
  );
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
