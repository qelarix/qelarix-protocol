import { NextRequest, NextResponse } from "next/server";
import { getRequestAuthUser } from "@/lib/authSession";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any;

export async function GET(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req);
    const userId = authUser?.id ?? null;

    const { searchParams } = new URL(req.url);
    const tab = searchParams.get("tab") ?? "newest";
    const page = parseInt(searchParams.get("page") ?? "0", 10);
    const limit = 20;
    const offset = page * limit;

    const admin: AdminAny = createSupabaseAdmin();

    let query = admin
      .from("generations")
      .select(`id, type, output_url, model, prompt, created_at, user_id`)
      .eq("is_public", true)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (tab === "videos") {
      query = query.eq("type", "video");
    } else if (tab === "images") {
      query = query.eq("type", "image");
    } else if (tab === "audio") {
      query = query.eq("type", "audio");
    } else if (tab === "characters") {
      query = query.eq("type", "image").ilike("model", "%influencer%");
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error("[explore] query error:", error.message);
      return NextResponse.json({ generations: [] });
    }

    const generations = await Promise.all(
      (rows ?? []).map(async (row: AdminAny) => {
        let likesCount = 0;
        let isLiked = false;
        try {
          const { count } = await admin
            .from("generation_likes")
            .select("*", { count: "exact", head: true })
            .eq("generation_id", row.id);
          likesCount = count ?? 0;

          if (userId) {
            const { data: likeRow } = await admin
              .from("generation_likes")
              .select("id")
              .eq("generation_id", row.id)
              .eq("user_id", userId)
              .maybeSingle();
            isLiked = !!likeRow;
          }
        } catch { /* likes table not critical */ }

        let userName = "Qelarix User";
        try {
          const { data: prof } = await admin
            .from("profiles")
            .select("username, full_name")
            .eq("id", row.user_id)
            .maybeSingle();
          if (prof) userName = prof.username ?? prof.full_name ?? "Qelarix User";
        } catch { /* profile lookup not critical */ }

        return {
          id: row.id,
          type: row.type,
          output_url: row.output_url,
          model: row.model,
          prompt: row.prompt,
          title: null,
          created_at: row.created_at,
          views: 0,
          user_name: userName,
          likes_count: likesCount,
          is_liked: isLiked,
        };
      })
    );

    return NextResponse.json({ generations });
  } catch {
    return NextResponse.json({ generations: [] });
  }
}
