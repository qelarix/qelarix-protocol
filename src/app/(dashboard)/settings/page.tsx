import { getServerAuthUser } from "@/lib/authSession"
import { generationBillingMode, getGenerationBalance } from "@/lib/billing/generationBilling"
import { redirect } from "next/navigation"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import SettingsClient from "@/components/settings/SettingsClient"
import type { PlanId } from "@/lib/plans"
import type { CreditTransaction, Profile } from "@/types/database"

export default async function SettingsPage() {
  const authUser = await getServerAuthUser()
  if (!authUser?.id) redirect("/login")

  const admin = createSupabaseAdmin()
  const userId = authUser.id

  const [{ data: profile }, { data: transactions }] = await Promise.all([
    admin.from("profiles").select("*").eq("id", userId).single(),
    admin
      .from("credit_transactions")
      .select("id, amount, type, description, created_at, stripe_payment_intent_id, user_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),
  ])
  // In QLC billing mode the spendable balance is the wallet's on-chain QLC, not profiles.credits.
  const shownProfile = profile && generationBillingMode() === "qlc"
    ? { ...(profile as Profile), credits: await getGenerationBalance(authUser).catch(() => 0) }
    : profile

  return (
    <SettingsClient
      userId={userId}
      walletAddress={authUser.walletAddress ?? ""}
      profile={shownProfile as Profile | null}
      transactions={(transactions ?? []) as CreditTransaction[]}
      plan={((profile as Profile | null)?.plan ?? "free") as PlanId}
    />
  )
}
