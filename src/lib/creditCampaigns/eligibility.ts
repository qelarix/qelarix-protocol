// Campaign eligibility engine.
//
// A campaign's `eligibility` is a JSON array of rules; every rule must pass. Each rule is
// `{ "type": "<rule type>", ...params }` and is handled by one evaluator in RULE_EVALUATORS.
// New rule types are added by registering an evaluator; campaigns, the schema and the claim
// API stay unchanged. Unknown types, malformed parameters and failed reads are never eligible.
import type { AuthUser } from "@/lib/authSession"
import type { SolanaCluster } from "@/lib/solanaCluster"
import type { SolanaAccountSignals } from "./solanaAccountSignals"

export type RuleConfig = { type: string } & Record<string, unknown>

export interface EligibilityContext {
  user: AuthUser
  cluster: SolanaCluster
  signals: SolanaAccountSignals
  now: Date
}

export type EligibilityResult = { eligible: true } | { eligible: false; reason: string }

type RuleEvaluator = (rule: RuleConfig, context: EligibilityContext) => Promise<EligibilityResult>

const ELIGIBLE: EligibilityResult = { eligible: true }
const ineligible = (reason: string): EligibilityResult => ({ eligible: false, reason })

const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0
const isBaseUnits = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,30}$/.test(value)
const isAddress = (value: unknown): value is string => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** Runs a rule that reads the user's wallet; no wallet or a failed read means not eligible. */
function walletRule(
  validate: (rule: RuleConfig) => boolean,
  check: (wallet: string, rule: RuleConfig, context: EligibilityContext) => Promise<boolean>,
  failReason: string,
): RuleEvaluator {
  return async (rule, context) => {
    if (!validate(rule)) return ineligible(`invalid_rule:${rule.type}`)
    const wallet = context.user.walletAddress
    if (!wallet) return ineligible("wallet_required")
    try {
      return (await check(wallet, rule, context)) ? ELIGIBLE : ineligible(failReason)
    } catch {
      return ineligible("signal_unavailable")
    }
  }
}

/** Rule types reserved for data sources that do not exist yet; they never pass until implemented. */
const notAvailable: RuleEvaluator = async (rule) => ineligible(`rule_not_available:${rule.type}`)

export const RULE_EVALUATORS: Record<string, RuleEvaluator> = {
  /** Signed in with a Solana wallet. */
  wallet_identity: async (_rule, { user }) => (user.walletAddress ? ELIGIBLE : ineligible("wallet_required")),

  /** `{ "wallets": ["<address>", ...] }` */
  allowlist: async (rule, { user }) => {
    if (!Array.isArray(rule.wallets) || !rule.wallets.every(isAddress)) return ineligible("invalid_rule:allowlist")
    if (!user.walletAddress) return ineligible("wallet_required")
    return rule.wallets.includes(user.walletAddress) ? ELIGIBLE : ineligible("not_allowlisted")
  },

  /** `{ "userIds": ["<profile uuid>", ...] }`: named testers, with or without a wallet. */
  user_allowlist: async (rule, { user }) => {
    if (!Array.isArray(rule.userIds) || !rule.userIds.every(isUuid)) return ineligible("invalid_rule:user_allowlist")
    const id = user.id.toLowerCase()
    return rule.userIds.some((allowed) => allowed.toLowerCase() === id) ? ELIGIBLE : ineligible("not_allowlisted")
  },

  /** `{ "lamports": <integer> }` */
  min_sol_balance: walletRule(
    (rule) => isPositiveInteger(rule.lamports),
    async (wallet, rule, { signals }) => (await signals.getBalanceLamports(wallet)) >= BigInt(rule.lamports as number),
    "sol_balance_too_low",
  ),

  /** `{ "days": <integer> }`: first finalized transaction at least this many days ago. */
  min_wallet_age_days: walletRule(
    (rule) => isPositiveInteger(rule.days),
    (wallet, rule, { signals, now }) =>
      signals.hasActivityBefore(wallet, Math.floor(now.getTime() / 1000) - (rule.days as number) * 86_400),
    "wallet_too_new",
  ),

  /** `{ "count": <integer> }` */
  min_transaction_count: walletRule(
    (rule) => isPositiveInteger(rule.count),
    (wallet, rule, { signals }) => signals.hasAtLeastTransactions(wallet, rule.count as number),
    "too_few_transactions",
  ),

  /** `{ "mint": "<address>", "minAmount": "<base units>" }`: fungible tokens or a specific NFT mint (minAmount "1"). */
  token_balance: walletRule(
    (rule) => isAddress(rule.mint) && isBaseUnits(rule.minAmount) && BigInt(rule.minAmount) > BigInt(0),
    async (wallet, rule, { signals }) => (await signals.getTokenBalance(wallet, rule.mint as string)) >= BigInt(rule.minAmount as string),
    "token_balance_too_low",
  ),

  /** `{ "rules": [<rule>, ...] }`: passes when at least one nested rule passes. */
  any_of: async (rule, context) => {
    if (!Array.isArray(rule.rules) || rule.rules.length === 0) return ineligible("invalid_rule:any_of")
    let lastReason = "no_rule_passed"
    for (const nested of rule.rules) {
      const result = await evaluateRule(nested, context)
      if (result.eligible) return ELIGIBLE
      lastReason = result.reason
    }
    return ineligible(lastReason)
  },

  verified_usdc_purchase: notAvailable,
  invite_code: notAvailable,
  nft_collection: notAvailable,
}

function evaluateRule(rule: unknown, context: EligibilityContext): Promise<EligibilityResult> {
  if (typeof rule !== "object" || rule === null || typeof (rule as RuleConfig).type !== "string") {
    return Promise.resolve(ineligible("invalid_rule"))
  }
  const evaluator = Object.prototype.hasOwnProperty.call(RULE_EVALUATORS, (rule as RuleConfig).type)
    ? RULE_EVALUATORS[(rule as RuleConfig).type]
    : undefined
  return evaluator ? evaluator(rule as RuleConfig, context) : Promise.resolve(ineligible(`unknown_rule:${(rule as RuleConfig).type}`))
}

/** All rules must pass. An empty list means anyone signed in on the campaign's cluster. */
export async function evaluateEligibility(rules: unknown, context: EligibilityContext): Promise<EligibilityResult> {
  if (!Array.isArray(rules)) return ineligible("invalid_rules")
  for (const rule of rules) {
    const result = await evaluateRule(rule, context)
    if (!result.eligible) return result
  }
  return ELIGIBLE
}
