-- ============================================================
-- AI Platforma — Settings Fields Migration
-- Migration: 20260507000001_settings_fields
-- ============================================================

-- Add new profile fields for settings page
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS notification_email_generation BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notification_email_credits BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notification_email_newsletter BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_key_hash TEXT,
  ADD COLUMN IF NOT EXISTS api_key_prefix TEXT,
  ADD COLUMN IF NOT EXISTS webhook_url TEXT;

-- Create avatars storage bucket (public)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  5242880, -- 5 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: anyone can read public avatars
CREATE POLICY "Public avatar read" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

-- Storage RLS: authenticated users can upload their own avatar
CREATE POLICY "User avatar upload" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Storage RLS: authenticated users can update their own avatar
CREATE POLICY "User avatar update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
