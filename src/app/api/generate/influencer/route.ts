import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAuthUser } from "@/lib/authSession";
import { CREDITS } from "@/lib/credits";
import { checkGenerationFunds, releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from "@/lib/billing/generationBilling";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { isInternalUser } from "@/lib/planAccess"

const CREDIT_COST = CREDITS.image.grokimagine;

function buildInfluencerPrompt(
  character: string,
  gender: string,
  age: string,
  style: string,
  background: string
): string {
  return `Professional AI influencer portrait, ${character} character type, ${gender}, age ${age}, ${style} artistic style, ${background} background, ultra-realistic, 8K, professional photography lighting, social media ready`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any;

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req);
    if (!authUser?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = authUser.id
  const isAdmin = isInternalUser(authUser);

    const body = await req.json();
    const {
      character = "Nova",
      gender = "Female",
      age = "18-25",
      style = "Realistic",
      background = "Studio",
    } = body;

    const admin: AdminAny = createSupabaseAdmin();

    const funds = await checkGenerationFunds({ user: authUser, credits: CREDIT_COST, exempt: isAdmin });
    if (!funds.ok) return NextResponse.json({ error: funds.error, code: funds.code }, { status: funds.status });

    // The generation id exists before the provider runs, so QLC billing can charge it first; the row is
    // written after success (no-op in credits mode).
    const generationId = randomUUID();
    const charge = await reserveGenerationCharge({ user: authUser, generationId, credits: CREDIT_COST, exempt: isAdmin });
    if (!charge.ok) return NextResponse.json({ error: charge.error, code: charge.code }, { status: charge.status });

    const prompt = buildInfluencerPrompt(character, gender, age, style, background);

    const xaiRes = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-2-image",
        prompt,
        n: 1,
        response_format: "url",
      }),
    });

    if (!xaiRes.ok) {
      const err = await xaiRes.text();
      console.error("xAI API error:", err);
      await releaseGenerationCharge({ generationId, reason: "provider failed" });
      return NextResponse.json({ error: "Generation failed" }, { status: 500 });
    }

    const xaiData = await xaiRes.json();
    const imageUrl = xaiData?.data?.[0]?.url;
    if (!imageUrl) {
      await releaseGenerationCharge({ generationId, reason: "no output" });
      return NextResponse.json({ error: "No image returned" }, { status: 500 });
    }

    await settleGenerationCharge({
      user: authUser, generationId, credits: CREDIT_COST, description: "AI Influencer image", exempt: isAdmin, once: "this-request",
    });

    await admin.from("generations").insert({
      id: generationId,
      user_id: userId,
      type: "image",
      model: "grok-2-image",
      prompt,
      output_url: imageUrl,
      credits_used: CREDIT_COST,
      status: "completed",
    });

    return NextResponse.json({ imageUrl, creditsUsed: CREDIT_COST });
  } catch (err) {
    console.error("Influencer generation error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
