import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any;

// Live data: never serve a cached/static response (Next.js would otherwise freeze this GET at build time).
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    const admin: AdminAny = createSupabaseAdmin();

    // Current month standings
    const { data: standings } = await admin
      .from("monthly_leaderboard")
      .select("user_id, full_name, avatar_url, likes_count")
      .limit(10);

    // Hall of Fame — past winners grouped by month/year
    const { data: pastWinners } = await admin
      .from("leaderboard_winners")
      .select("user_id, month, year, rank, likes_count, credits_awarded, profiles:profiles(full_name, avatar_url)")
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .order("rank", { ascending: true })
      .limit(50);

    return NextResponse.json({
      standings: standings ?? [],
      hallOfFame: pastWinners ?? [],
    });
  } catch (err) {
    console.error("[leaderboard]", err);
    return NextResponse.json({ standings: [], hallOfFame: [] });
  }
}
