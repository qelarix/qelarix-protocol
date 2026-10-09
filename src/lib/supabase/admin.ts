import { createClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

type ProfilePartial = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "full_name" | "plan" | "credits" | "early_adopter" | "early_adopter_number"
>

export function createSupabaseAdmin() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function getUserById(userId: string) {
  const admin = createSupabaseAdmin()

  const authResult = await admin.auth.admin.getUserById(userId)
  if (authResult.error || !authResult.data.user) return null

  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, plan, credits, early_adopter, early_adopter_number")
    .eq("id", userId)
    .single() as { data: ProfilePartial | null; error: unknown }

  return {
    id: userId,
    email: authResult.data.user.email ?? "",
    name: (profile?.full_name ?? authResult.data.user.user_metadata?.full_name ?? "Creator") as string,
    plan: profile?.plan ?? "free",
    credits: profile?.credits ?? 0,
    earlyAdopter: profile?.early_adopter ?? false,
    earlyAdopterNumber: profile?.early_adopter_number ?? null,
  }
}
