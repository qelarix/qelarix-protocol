// Credit Grant Service: the only application path that grants promotional QLC.
//
// The server decides everything: cluster (from deployment config), which campaigns are active,
// eligibility, priority order, amount, duplicate prevention and audit. Callers only say who is
// asking. Final enforcement (cluster, cap, one grant per recipient, concurrency, ledger) happens
// atomically in the database function grant_campaign_credits.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuthUser } from "@/lib/authSession"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { getSolanaCluster, getSolanaRpcUrl, type SolanaCluster } from "@/lib/solanaCluster"
import { evaluateEligibility } from "./eligibility"
import { createSolanaAccountSignals, type SolanaAccountSignals } from "./solanaAccountSignals"

export type GrantStatus =
  | "granted"
  | "already_granted"
  | "cap_reached"
  | "inactive"
  | "excluded"
  | "cluster_mismatch"
  | "mode_mismatch"
  | "invalid_recipient"
  | "invalid_amount"
  | "invalid_request"
  | "unknown_campaign"
  | "unknown_user"

export interface CreditCampaign {
  id: string
  recipientScope: "wallet" | "user" | "grant_key"
  amount: number
  maxRecipients: number | null
  grantedCount: number
  priority: number
  exclusionGroup: string | null
  eligibility: unknown
}

export interface GrantRequest {
  campaignId: string
  cluster: SolanaCluster
  mode: "claim" | "manual"
  userId: string
  walletAddress: string | null
  grantKey: string | null
  amount: number | null
  reason: string
  grantedBy: string
}

export interface GrantOutcome {
  status: GrantStatus
  campaignId: string
  amount?: number
  recipientNumber?: number
  balance?: number
  /** QLC payout campaigns: the qlc_deliveries row that delivers the grant on chain. */
  deliveryId?: string | null
}

export interface CampaignStore {
  /** Active claim campaigns for the cluster whose time window is open, ordered by priority. */
  listClaimCampaigns(cluster: SolanaCluster, now: Date): Promise<CreditCampaign[]>
  /** Campaigns (any state) in which this user or wallet already received a grant. */
  listRecipientGrants(cluster: SolanaCluster, userId: string, walletAddress: string | null): Promise<{ campaignId: string; exclusionGroup: string | null }[]>
  grant(request: GrantRequest): Promise<GrantOutcome>
}

export interface ClaimGrant {
  campaignId: string
  status: GrantStatus | "not_eligible"
  amount?: number
  reason?: string
  deliveryId?: string
}

export type ClaimResult =
  | { status: "disabled"; cluster: null; grants: [] }
  | { status: "ok"; cluster: SolanaCluster; grants: ClaimGrant[] }

export interface GrantServiceDeps {
  cluster: SolanaCluster | null
  store: CampaignStore
  signals: () => SolanaAccountSignals
  now: () => Date
}

export function defaultGrantServiceDeps(): GrantServiceDeps {
  const cluster = getSolanaCluster()
  return {
    cluster,
    store: createSupabaseCampaignStore(),
    signals: () => createSolanaAccountSignals(getSolanaRpcUrl(cluster ?? "devnet")),
    now: () => new Date(),
  }
}

/** Evaluates every open claim campaign for the signed-in user, in priority order. */
export async function claimCampaignCredits(user: AuthUser, deps: GrantServiceDeps = defaultGrantServiceDeps()): Promise<ClaimResult> {
  const { cluster, store } = deps
  if (!cluster) return { status: "disabled", cluster: null, grants: [] }

  const now = deps.now()
  const campaigns = await store.listClaimCampaigns(cluster, now)
  if (campaigns.length === 0) return { status: "ok", cluster, grants: [] }

  const prior = await store.listRecipientGrants(cluster, user.id, user.walletAddress)
  const grantedCampaigns = new Set(prior.map((g) => g.campaignId))
  const claimedGroups = new Set(prior.flatMap((g) => (g.exclusionGroup ? [g.exclusionGroup] : [])))
  let signals: SolanaAccountSignals | null = null
  const grants: ClaimGrant[] = []

  for (const campaign of campaigns) {
    if (grantedCampaigns.has(campaign.id)) {
      grants.push({ campaignId: campaign.id, status: "already_granted" })
      continue
    }
    if (campaign.exclusionGroup && claimedGroups.has(campaign.exclusionGroup)) {
      grants.push({ campaignId: campaign.id, status: "excluded" })
      continue
    }
    if (campaign.recipientScope === "wallet" && !user.walletAddress) {
      grants.push({ campaignId: campaign.id, status: "not_eligible", reason: "wallet_required" })
      continue
    }
    // Cheap pre-check only; the database decides the cap atomically.
    if (campaign.maxRecipients !== null && campaign.grantedCount >= campaign.maxRecipients) {
      grants.push({ campaignId: campaign.id, status: "cap_reached" })
      continue
    }

    signals ??= deps.signals()
    const verdict = await evaluateEligibility(campaign.eligibility, { user, cluster, signals, now })
    if (!verdict.eligible) {
      grants.push({ campaignId: campaign.id, status: "not_eligible", reason: verdict.reason })
      continue
    }

    const outcome = await store.grant({
      campaignId: campaign.id,
      cluster,
      mode: "claim",
      userId: user.id,
      walletAddress: user.walletAddress,
      grantKey: null,
      amount: null,
      reason: "claimed",
      grantedBy: "claim",
    })
    grants.push({
      campaignId: campaign.id,
      status: outcome.status,
      ...(outcome.amount ? { amount: outcome.amount } : {}),
      ...(outcome.deliveryId ? { deliveryId: outcome.deliveryId } : {}),
    })
    if ((outcome.status === "granted" || outcome.status === "already_granted") && campaign.exclusionGroup) {
      claimedGroups.add(campaign.exclusionGroup)
    }
  }

  return { status: "ok", cluster, grants }
}

/**
 * Devnet test campaigns granted automatically after wallet sign-in. Test infrastructure only: the
 * Mainnet launch claim is a separate, manual flow with its own reviewed amount and eligibility.
 */
export const DEVNET_AUTO_CLAIM_CAMPAIGNS: readonly string[] = ["devnet-test-credits"]
/**
 * The same automatic Devnet claim once generation billing is on chain (GENERATION_BILLING=qlc): 500.00
 * QLC per wallet, delivered on chain through qlc_deliveries (supabase/campaigns/devnet-qlc.sql).
 */
export const DEVNET_QLC_AUTO_CLAIM_CAMPAIGNS: readonly string[] = ["devnet-open-qlc"]

export function devnetAutoClaimCampaigns(billing: "credits" | "qlc"): readonly string[] {
  return billing === "qlc" ? DEVNET_QLC_AUTO_CLAIM_CAMPAIGNS : DEVNET_AUTO_CLAIM_CAMPAIGNS
}

/**
 * Automatic Devnet beta claim after wallet sign-in: the regular claim path (same eligibility, cap and
 * idempotency), limited to the Devnet auto-claim campaigns of the billing mode (database credits before
 * the QLC cutover, 500 on-chain QLC after it) and refused unless the deployment's cluster is devnet, so
 * it can never claim a Mainnet campaign.
 */
export async function claimDevnetBetaCredits(
  user: AuthUser,
  deps: GrantServiceDeps = defaultGrantServiceDeps(),
  billing: "credits" | "qlc" = "credits",
): Promise<ClaimResult> {
  if (deps.cluster !== "devnet") return { status: "disabled", cluster: null, grants: [] }
  const campaigns = devnetAutoClaimCampaigns(billing)
  const store: CampaignStore = {
    ...deps.store,
    listClaimCampaigns: async (cluster, now) =>
      (await deps.store.listClaimCampaigns(cluster, now)).filter((campaign) => campaigns.includes(campaign.id)),
  }
  return claimCampaignCredits(user, { ...deps, store })
}

export interface ManualGrantInput {
  campaignId: string
  userId: string
  amount: number
  /** Unique per intended grant (e.g. "bug-bounty-42"); repeating it never grants twice. */
  grantKey: string
  reason: string
  operator: string
}

/** Operator-issued grant into a manual campaign. Not reachable from any public endpoint. */
export async function grantManualCredits(input: ManualGrantInput, deps: GrantServiceDeps = defaultGrantServiceDeps()): Promise<GrantOutcome> {
  if (!deps.cluster) throw new Error("NEXT_PUBLIC_SOLANA_CLUSTER is not configured")
  if (!input.operator.trim()) throw new Error("operator is required")
  return deps.store.grant({
    campaignId: input.campaignId,
    cluster: deps.cluster,
    mode: "manual",
    userId: input.userId,
    walletAddress: null,
    grantKey: input.grantKey,
    amount: input.amount,
    reason: input.reason,
    grantedBy: `operator:${input.operator.trim()}`,
  })
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

interface CampaignRow {
  starts_at: string | null
  ends_at: string | null
  id: string
  recipient_scope: CreditCampaign["recipientScope"]
  amount: number
  max_recipients: number | null
  granted_count: number
  priority: number
  exclusion_group: string | null
  eligibility: unknown
}

export function createSupabaseCampaignStore(client: SupabaseClient = createSupabaseAdmin() as unknown as SupabaseClient): CampaignStore {
  return {
    async listClaimCampaigns(cluster, now) {
      const { data, error } = await client
        .from("credit_campaigns")
        .select("id, recipient_scope, amount, max_recipients, granted_count, priority, exclusion_group, eligibility, starts_at, ends_at")
        .eq("cluster", cluster)
        .eq("grant_mode", "claim")
        .eq("is_active", true)
        .order("priority", { ascending: true })
        .order("id", { ascending: true })
      if (error) throw new Error(`credit_campaigns query failed: ${error.message}`)
      const time = now.getTime()
      const open = ((data ?? []) as CampaignRow[]).filter(
        (row) => (!row.starts_at || Date.parse(row.starts_at) <= time) && (!row.ends_at || Date.parse(row.ends_at) > time),
      )
      return open.map((row) => ({
        id: row.id,
        recipientScope: row.recipient_scope,
        amount: row.amount,
        maxRecipients: row.max_recipients,
        grantedCount: row.granted_count,
        priority: row.priority,
        exclusionGroup: row.exclusion_group,
        eligibility: row.eligibility,
      }))
    },

    async listRecipientGrants(cluster, userId, walletAddress) {
      // Values are interpolated into a PostgREST filter, so only well-formed ids are accepted.
      if (!UUID_PATTERN.test(userId)) throw new Error("Invalid user id")
      const wallet = walletAddress && WALLET_PATTERN.test(walletAddress) ? walletAddress : null
      const recipient = wallet ? `user_id.eq.${userId},wallet_address.eq.${wallet}` : `user_id.eq.${userId}`
      const { data, error } = await client
        .from("credit_grants")
        .select("campaign_id, credit_campaigns!inner(exclusion_group)")
        .eq("cluster", cluster)
        .or(recipient)
      if (error) throw new Error(`credit_grants query failed: ${error.message}`)
      return ((data ?? []) as unknown as { campaign_id: string; credit_campaigns: { exclusion_group: string | null } }[]).map((row) => ({
        campaignId: row.campaign_id,
        exclusionGroup: row.credit_campaigns?.exclusion_group ?? null,
      }))
    },

    async grant(request) {
      const { data, error } = await client.rpc("grant_campaign_credits", {
        p_campaign_id: request.campaignId,
        p_cluster: request.cluster,
        p_grant_mode: request.mode,
        p_user_id: request.userId,
        p_wallet_address: request.walletAddress,
        p_grant_key: request.grantKey,
        p_amount: request.amount,
        p_reason: request.reason,
        p_granted_by: request.grantedBy,
      })
      if (error) throw new Error(`grant_campaign_credits failed: ${error.message}`)
      return data as GrantOutcome
    },
  }
}
