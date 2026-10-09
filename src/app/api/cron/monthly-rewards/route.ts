import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { Resend } from "resend";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any;

const REWARDS = [500, 300, 100] as const;
const RANK_LABELS = ["🥇 1st place", "🥈 2nd place", "🥉 3rd place"] as const;

const resend = new Resend(process.env.RESEND_API_KEY);

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin: AdminAny = createSupabaseAdmin();

    const { data: winners, error } = await admin
      .from("last_month_leaderboard")
      .select("*");

    if (error || !winners?.length) {
      return NextResponse.json({ message: "No winners this month", rewarded: 0 });
    }

    const now = new Date();
    const month = now.getMonth() === 0 ? 12 : now.getMonth();
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

    let rewarded = 0;

    for (const winner of winners) {
      const rank = Number(winner.rank);
      if (rank > 3) continue;

      const credits = REWARDS[rank - 1];

      // Check already awarded
      const { data: existing } = await admin
        .from("leaderboard_winners")
        .select("id")
        .eq("user_id", winner.user_id)
        .eq("month", month)
        .eq("year", year)
        .maybeSingle();

      if (existing) continue;

      await admin.rpc("add_credits", {
        p_user_id: winner.user_id,
        p_amount: credits,
        p_type: "bonus",
        p_desc: `Leaderboard reward ${RANK_LABELS[rank - 1]} — ${month}/${year}`,
      });

      await admin.from("leaderboard_winners").insert({
        user_id: winner.user_id,
        month,
        year,
        rank,
        likes_count: winner.likes_count,
        credits_awarded: credits,
        email_sent: false,
      });

      if (winner.email) {
        const monthName = new Date(year, month - 1, 1).toLocaleString("en", { month: "long" });
        await resend.emails.send({
          from: process.env.EMAIL_FROM ?? "noreply@qelarix.ai",
          to: winner.email,
          subject: `🏆 You won ${credits} credits — Qelarix Leaderboard`,
          html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Leaderboard Winner</title></head>
<body style="margin:0;padding:0;background:#050505;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111318;border-radius:20px;border:1px solid #2A2F3A;overflow:hidden;max-width:560px;">

        <tr><td style="padding:32px 40px 24px;border-bottom:1px solid #2A2F3A;">
          <h1 style="margin:0;font-size:28px;font-weight:900;color:white;letter-spacing:-0.5px;">
            <span style="background:linear-gradient(135deg,#7B61FF,#3BE7FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Qelarix</span>
          </h1>
        </td></tr>

        <tr><td style="padding:40px;text-align:center;">
          <p style="margin:0 0 8px;font-size:48px;">${RANK_LABELS[rank - 1].split(" ")[0]}</p>
          <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:white;">${RANK_LABELS[rank - 1]}</h2>
          <p style="margin:0 0 32px;font-size:15px;color:#AAB2BF;">
            ${monthName} ${year} Leaderboard
          </p>

          <div style="background:#0A0A0F;border:1px solid #7B61FF;border-radius:16px;padding:28px;margin-bottom:32px;display:inline-block;min-width:200px;">
            <p style="margin:0 0 4px;font-size:48px;font-weight:900;color:#7B61FF;">${credits}</p>
            <p style="margin:0;font-size:16px;color:#AAB2BF;">credits awarded</p>
          </div>

          <p style="margin:0 0 8px;font-size:15px;color:#AAB2BF;">
            Your creation earned <strong style="color:white;">${winner.likes_count} likes</strong> this month.
          </p>
          <p style="margin:0 0 32px;font-size:14px;color:#4A5568;">
            Credits have been added to your account automatically.
          </p>

          <a href="https://qelarix.ai/explore" style="display:inline-block;background:linear-gradient(135deg,#7B61FF,#3BE7FF);color:white;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:15px;font-weight:700;">
            View Leaderboard →
          </a>
        </td></tr>

        <tr><td style="padding:24px 40px;border-top:1px solid #2A2F3A;text-align:center;">
          <p style="margin:0;font-size:12px;color:#4A5568;">© 2026 Qelarix AI Platform. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
        });

        await admin
          .from("leaderboard_winners")
          .update({ email_sent: true })
          .eq("user_id", winner.user_id)
          .eq("month", month)
          .eq("year", year);
      }

      rewarded++;
    }

    return NextResponse.json({ message: "Rewards distributed", rewarded });
  } catch (err) {
    console.error("[monthly-rewards]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
