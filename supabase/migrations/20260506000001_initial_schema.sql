-- ============================================================
-- AI Platforma — Initial Schema
-- Migration: 20260506000001_initial_schema
-- ============================================================

-- PROFILES (extends auth.users)
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  username TEXT UNIQUE,
  full_name TEXT,
  avatar_url TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free','starter','pro','agency')),
  credits INTEGER DEFAULT 100,
  credits_used INTEGER DEFAULT 0,
  early_adopter BOOLEAN DEFAULT false,
  early_adopter_number INTEGER,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  subscription_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- GENERATIONS
CREATE TABLE public.generations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('image','video','audio','edit')),
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  output_url TEXT,
  thumbnail_url TEXT,
  credits_used INTEGER NOT NULL,
  settings JSONB DEFAULT '{}',
  is_public BOOLEAN DEFAULT true,
  likes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CREDIT TRANSACTIONS
CREATE TABLE public.credit_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  type TEXT CHECK (type IN ('subscription','topup','bonus','promo','usage','refund')),
  description TEXT,
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- BRAND KITS
CREATE TABLE public.brand_kits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_url TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  font TEXT,
  style_description TEXT,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CHARACTERS (for Cinema Studio)
CREATE TABLE public.characters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  reference_images TEXT[] DEFAULT '{}',
  type TEXT CHECK (type IN ('character','location','prop')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CINEMA PROJECTS
CREATE TABLE public.cinema_projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  genre TEXT,
  style JSONB DEFAULT '{}',
  scenes JSONB DEFAULT '[]',
  characters UUID[],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- LIKES
CREATE TABLE public.likes (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  generation_id UUID REFERENCES public.generations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, generation_id)
);

-- EARLY ADOPTER COUNTER (atomic, thread-safe)
CREATE TABLE public.early_adopter_counter (
  id INTEGER PRIMARY KEY DEFAULT 1,
  count INTEGER DEFAULT 0,
  max_count INTEGER DEFAULT 100
);
INSERT INTO public.early_adopter_counter VALUES (1, 0, 100);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_kits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cinema_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read and update only their own row
CREATE POLICY "own profile read" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "own profile update" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Generations: public ones are readable by all; own ones fully accessible
CREATE POLICY "public or own gens" ON public.generations
  FOR SELECT USING (is_public = true OR auth.uid() = user_id);

CREATE POLICY "insert own gen" ON public.generations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "update own gen" ON public.generations
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "delete own gen" ON public.generations
  FOR DELETE USING (auth.uid() = user_id);

-- Brand kits
CREATE POLICY "own brand kits" ON public.brand_kits
  USING (auth.uid() = user_id);

-- Characters
CREATE POLICY "own characters" ON public.characters
  USING (auth.uid() = user_id);

-- Cinema projects
CREATE POLICY "own cinema" ON public.cinema_projects
  USING (auth.uid() = user_id);

-- Credit transactions: read-only for owner
CREATE POLICY "own transactions" ON public.credit_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Likes
CREATE POLICY "own likes" ON public.likes
  USING (auth.uid() = user_id);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_generations_user_id ON public.generations(user_id);
CREATE INDEX idx_generations_created_at ON public.generations(created_at DESC);
CREATE INDEX idx_generations_is_public ON public.generations(is_public) WHERE is_public = true;
CREATE INDEX idx_credit_transactions_user_id ON public.credit_transactions(user_id);
CREATE INDEX idx_brand_kits_user_id ON public.brand_kits(user_id);
CREATE INDEX idx_characters_user_id ON public.characters(user_id);
CREATE INDEX idx_cinema_projects_user_id ON public.cinema_projects(user_id);

-- ============================================================
-- TRIGGER: new user → profile + Early Adopter promo check
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  adopter_num INTEGER;
  bonus INTEGER := 100;
BEGIN
  -- Atomically claim early adopter slot (only first 100 users)
  UPDATE public.early_adopter_counter
    SET count = count + 1
    WHERE id = 1 AND count < max_count
    RETURNING count INTO adopter_num;

  IF adopter_num IS NOT NULL THEN
    bonus := 1100; -- 100 base + 1000 promo
  END IF;

  INSERT INTO public.profiles (id, full_name, avatar_url, credits, early_adopter, early_adopter_number)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url',
    bonus,
    adopter_num IS NOT NULL,
    adopter_num
  );

  IF adopter_num IS NOT NULL THEN
    INSERT INTO public.credit_transactions(user_id, amount, type, description)
    VALUES (NEW.id, 1000, 'promo', 'Early Adopter #' || adopter_num);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- FUNCTION: deduct credits atomically
-- Returns TRUE if successful, FALSE if insufficient credits
-- ============================================================

CREATE OR REPLACE FUNCTION public.deduct_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_desc TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE public.profiles
    SET credits = credits - p_amount,
        credits_used = credits_used + p_amount
    WHERE id = p_user_id AND credits >= p_amount;

  IF FOUND THEN
    INSERT INTO public.credit_transactions(user_id, amount, type, description)
    VALUES (p_user_id, -p_amount, 'usage', p_desc);
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- FUNCTION: add credits (subscription renewal, topup, bonus)
-- ============================================================

CREATE OR REPLACE FUNCTION public.add_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_type TEXT,
  p_desc TEXT,
  p_stripe_payment_intent_id TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE public.profiles
    SET credits = credits + p_amount,
        updated_at = NOW()
    WHERE id = p_user_id;

  INSERT INTO public.credit_transactions(user_id, amount, type, description, stripe_payment_intent_id)
  VALUES (p_user_id, p_amount, p_type, p_desc, p_stripe_payment_intent_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- FUNCTION: auto-update updated_at on profiles
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
