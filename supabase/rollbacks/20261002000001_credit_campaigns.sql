-- ============================================================
-- Rollback for supabase/proposed/20261002000001_credit_campaigns.sql
--
-- Restores the profile-creation behaviour of the dev project as verified on
-- 2026-10-02 (supabase/snapshots/dev-credit-schema-2026-10-02.sql) and drops the
-- campaign objects. credit_campaigns / credit_grants are dropped with their audit
-- history, so export them first if any grant was made.
--
-- Deliberately NOT restored, because they are security holes and nothing in the
-- application depends on them (all callers use the service role):
--   - PUBLIC / anon / authenticated EXECUTE on credit and counter functions
--   - the "Service role full access" policy that applied to every role
--   - the "own profile" FOR ALL policy that let users change their own credits
--   - anon / authenticated INSERT, UPDATE, DELETE, TRUNCATE on the credit tables
-- provision_nextauth_profile did not exist on the dev project and is not recreated.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.grant_campaign_credits(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP TABLE IF EXISTS public.credit_grants;
DROP TABLE IF EXISTS public.credit_campaigns;

ALTER TABLE public.profiles ALTER COLUMN credits SET DEFAULT 100;

-- Live definition on the dev project before the migration.
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
-- CREATE OR REPLACE keeps the function's search_path setting from the migration;
-- reset it so the definition matches the pre-migration state exactly.
ALTER FUNCTION public.handle_new_user() RESET search_path;

COMMIT;
