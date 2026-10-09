// Operator CLI for manual QLC grants (beta testers, ambassadors, bug bounties, creator rewards, ...).
// Authorization is possession of the project's service-role key; the operator name is recorded
// on every grant. Repeating a grant key never grants twice.
//
//   npm run credits:grant -- --campaign mainnet-manual-grants --user <profile uuid> \
//     --amount 500 --key bug-bounty-42 --reason "Bug bounty #42" --operator <name>
import { parseArgs } from "node:util"
import { grantManualCredits } from "../src/lib/creditCampaigns/grantService"

const { values } = parseArgs({
  options: {
    campaign: { type: "string" },
    user: { type: "string" },
    amount: { type: "string" },
    key: { type: "string" },
    reason: { type: "string" },
    operator: { type: "string" },
  },
})

const missing = ["campaign", "user", "amount", "key", "reason", "operator"].filter((name) => !values[name as keyof typeof values])
const amount = Number(values.amount)
if (missing.length || !Number.isInteger(amount) || amount <= 0) {
  console.error(missing.length ? `Missing: ${missing.map((m) => `--${m}`).join(", ")}` : "--amount must be a positive integer")
  process.exit(1)
}

grantManualCredits({
  campaignId: values.campaign!,
  userId: values.user!,
  amount,
  grantKey: values.key!,
  reason: values.reason!,
  operator: values.operator!,
})
  .then((outcome) => {
    console.log(JSON.stringify({ cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER, ...outcome }, null, 2))
    process.exit(outcome.status === "granted" || outcome.status === "already_granted" ? 0 : 1)
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
