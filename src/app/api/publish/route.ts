import { NextRequest, NextResponse } from "next/server";
import { getRequestAuthUser } from "@/lib/authSession";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any;

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req);
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = authUser.id;

    const body = await req.json();
    const { generationId, title } = body as { generationId?: string; title?: string };

    if (!generationId) {
      return NextResponse.json({ error: "generationId required" }, { status: 400 });
    }

    const admin: AdminAny = createSupabaseAdmin();

    const { error } = await admin
      .from("generations")
      .update({ is_public: true, ...(title ? { title } : {}) })
      .eq("id", generationId)
      .eq("user_id", userId);

    if (error) {
      return NextResponse.json({ error: "Failed to publish" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
