export const PLANS = {
  free: {
    monthlyCredits: 100,
    maxGenerationsPerDay: 5,
    creditRollover: 0,
    videoAccess: ["wan26", "ltx2"] as string[],
    brandKits: 0,
    api: false,
    makecom: false,
    cinemaStudio: false,
    clientPortal: false,
    whiteLabel: false,
    watermark: true,
    freeModels: ["sd35", "nanobanana2", "wan26", "ltx2", "stability30s"] as string[],
    canvas: false,
    viralMode: false,
    storyboard: false,
    aiInfluencer: false,
    apps: false,
  },
  starter: {
    monthlyCredits: 600,
    creditRollover: 30,
    videoAccess: ["wan26", "ltx2", "luma3", "pika25", "kling3_standard", "kling26_standard"] as string[],
    brandKits: 1,
    api: false,
    makecom: false,
    cinemaStudio: false,
    clientPortal: false,
    whiteLabel: false,
    watermark: false,
    freeModels: [] as string[],
    canvas: true,
    viralMode: true,
    storyboard: false,
    aiInfluencer: false,
    apps: false,
  },
  pro: {
    monthlyCredits: 2500,
    creditRollover: 60,
    videoAccess: "all" as const,
    brandKits: 3,
    api: true,
    makecom: false,
    cinemaStudio: true,
    clientPortal: false,
    whiteLabel: false,
    watermark: false,
    freeModels: [] as string[],
    canvas: true,
    viralMode: true,
    storyboard: true,
    aiInfluencer: true,
    apps: true,
  },
  business: {
    monthlyCredits: 10000, // reduced pre-launch (was 35000) for profitability
    creditRollover: 90,
    videoAccess: "all" as const,
    brandKits: -1,
    api: true,
    makecom: true,
    cinemaStudio: true,
    clientPortal: true,
    whiteLabel: true,
    watermark: false,
    freeModels: [] as string[],
    canvas: true,
    viralMode: true,
    storyboard: true,
    aiInfluencer: true,
    apps: true,
  },
  ultra: {
    monthlyCredits: 3500, // reduced pre-launch (was 10000) for profitability
    creditRollover: 60,
    videoAccess: "all" as const,
    brandKits: -1,
    api: true,
    makecom: true,
    cinemaStudio: true,
    clientPortal: true,
    whiteLabel: true,
    watermark: false,
    freeModels: [] as string[],
    canvas: true,
    viralMode: true,
    storyboard: true,
    aiInfluencer: true,
    apps: true,
  },
} as const;

export type PlanId = keyof typeof PLANS;
export type Plan = (typeof PLANS)[PlanId];

// ─────────────────────────────────────────────────────────────────
// Plan hierarchy rank — the SINGLE source for "minimum plan / tier" checks.
// Feature routes (watermark-remover, video-extend, lip-sync) each used to
// define an identical local copy of this map; they now import this one.
// Keep the exact shape (Record<PlanId, number>) so those imports stay drop-in.
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// ACCESS POLICY (owner decision 2026-10-08): every account can use every feature and model.
// There is no plan-based locking anywhere. Each generation is still paid per use (QLC / credits),
// so balance, spending allowance and the epoch gate remain the only limits.
// Set to true only if plan-based locking is ever reintroduced.
// ─────────────────────────────────────────────────────────────────
export const PLAN_GATING_ENABLED = false;

/** True when `planId` meets `required`. Always true while plan gating is disabled. */
export function meetsPlan(planId: PlanId | 'tester' | string, required: PlanId): boolean {
  if (!PLAN_GATING_ENABLED) return true;
  if (planId === 'tester') return true;
  return (PLAN_LEVEL[planId as PlanId] ?? 0) >= (PLAN_LEVEL[required] ?? 0);
}

export const PLAN_LEVEL: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  business: 3,
  ultra: 3,
};

/** Numeric rank for a plan; 'tester' ranks above every real plan (unlimited). */
export function getPlanRank(planId: PlanId | 'tester'): number {
  if (planId === 'tester') return Number.MAX_SAFE_INTEGER;
  return PLAN_LEVEL[planId] ?? 0;
}

export function getPlan(planId: PlanId): Plan {
  return PLANS[planId];
}

export function canAccessVideo(planId: PlanId | 'tester', model?: string): boolean {
  if (!PLAN_GATING_ENABLED) return true
  if (planId === 'tester' || planId === 'ultra') return true
  const plan = PLANS[planId];
  if (plan.videoAccess === "all") return true;
  if (!Array.isArray(plan.videoAccess) || plan.videoAccess.length === 0) return false;
  if (!model) return true;
  return (plan.videoAccess as string[]).includes(model);
}

export function canUseFreeModel(planId: PlanId | 'tester', model: string): boolean {
  if (planId === 'tester') return false
  const plan = PLANS[planId];
  if (!("freeModels" in plan) || !plan.freeModels.length) return false;
  return (plan.freeModels as string[]).includes(model);
}

export function hasFeature(planId: PlanId | 'tester', feature: "api" | "makecom" | "cinemaStudio" | "clientPortal" | "whiteLabel"): boolean {
  if (!PLAN_GATING_ENABLED) return true
  if (planId === 'tester' || planId === 'ultra') return true
  return !!PLANS[planId][feature];
}

export function hasPageAccess(planId: PlanId | 'tester', page: string): boolean {
  if (!PLAN_GATING_ENABLED) return true
  if (planId === 'tester') return true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return !!(PLANS[planId as PlanId] as any)[page]
}
