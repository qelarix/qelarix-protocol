// Read-only verification of the deployed QLC program, its mint and its vault on a cluster, against the approved
// policy (scripts/qlc-policy.ts). Sends nothing and reads no keys: every expected value is public.
//
//   npm run qlc:verify -- --cluster devnet [--member <wallet>]...
//   npm run qlc:verify -- --cluster localnet --admin <address> --operator <address> --mint <address>
//
// Devnet expectations are the owner-approved identities and limits; --member (repeatable) also prints that
// wallet's membership and QLC account state. Every outcome, including a missing or invalid vault, is a named
// check in the report. Exits non-zero when any check fails.
import { address, createSolanaRpc, unwrapOption, type Address } from "@solana/kit"
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, fetchMaybeToken, findAssociatedTokenPda, getMintDecoder, type Token } from "@solana-program/token-2022"
import {
  QELARIX_QLC_PROGRAM_ADDRESS,
  fetchMaybeConfig,
  fetchMaybeMember,
  findConfigPda,
  findMemberPda,
  findMembershipAuthorityPda,
  findMintAuthorityPda,
  findSpendAuthorityPda,
  findVaultAuthorityPda,
} from "../src/lib/qlc/generated"
import { findNoBurnAuthority } from "../src/lib/qlc/qlcProgram"
import { report, type Check } from "./qlc-build-preflight"
import { CLUSTERS, DEVNET_LIMITS, DEVNET_SETUP, QLC_METADATA, accountingChecks, assertCluster, checkMintTlv, checkQlcMint, readUpgradeAuthority, type ClusterName } from "./qlc-policy"

const json = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)

const SINGLETONS = ["--cluster", "--admin", "--operator", "--mint"] as const

/** Strict arguments: unknown flags, repeated singleton flags and missing values are errors. --member may repeat. */
export function parseVerifyArgs(argv: string[]): { values: Partial<Record<(typeof SINGLETONS)[number], string>>; members: string[]; errors: string[] } {
  const values: Partial<Record<(typeof SINGLETONS)[number], string>> = {}
  const members: string[] = []
  const errors: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag !== "--member" && !(SINGLETONS as readonly string[]).includes(flag)) {
      errors.push(`unknown argument ${JSON.stringify(flag)}`)
      continue
    }
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${flag} has no value`)
      continue
    }
    i++
    if (flag === "--member") members.push(value)
    else if (flag in values) errors.push(`${flag} given more than once`)
    else values[flag as (typeof SINGLETONS)[number]] = value
  }
  if (!values["--cluster"] || !CLUSTERS[values["--cluster"] as ClusterName]) errors.push("--cluster must be localnet or devnet")
  return { values, members, errors }
}

async function main(): Promise<boolean> {
  const { values, members: memberArgs, errors } = parseVerifyArgs(process.argv.slice(2))
  if (errors.length) {
    for (const error of errors) console.error(`argument: ${error}`)
    return false
  }
  const clusterName = values["--cluster"] as ClusterName
  const devnet = clusterName === "devnet"
  const rpc = createSolanaRpc(CLUSTERS[clusterName].http)
  const genesis = await assertCluster(rpc, clusterName)
  const required = (flag: (typeof SINGLETONS)[number], devnetValue: string) => {
    const value = values[flag] ?? (devnet ? devnetValue : undefined)
    if (!value) throw new Error(`${flag} is required on localnet`)
    return address(value)
  }
  const admin = required("--admin", DEVNET_SETUP.admin)
  const operator = required("--operator", DEVNET_SETUP.operator)
  const expectedMint = required("--mint", DEVNET_SETUP.mint)
  const members = memberArgs.map((m) => address(m))

  const checks: Check[] = [{ name: "cluster: RPC genesis matches --cluster", ok: true, detail: `${clusterName} ${genesis}` }]
  const program = await rpc.getAccountInfo(QELARIX_QLC_PROGRAM_ADDRESS, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send()
  const { programData, deployed, upgradeAuthority } = await readUpgradeAuthority(rpc)
  checks.push(
    { name: "program deployed and executable (upgradeable loader)", ok: Boolean(program.value?.executable && deployed), detail: QELARIX_QLC_PROGRAM_ADDRESS },
    { name: "upgrade authority = admin", ok: upgradeAuthority === admin, detail: String(upgradeAuthority) },
  )
  const [configAddress] = await findConfigPda()
  const maybeConfig = await fetchMaybeConfig(rpc, configAddress)
  checks.push({ name: "program initialized (config account exists)", ok: maybeConfig.exists, detail: configAddress })
  if (!maybeConfig.exists) return report(`QLC verification on ${clusterName} (read-only)`, checks, "")
  const config = maybeConfig.data
  const [[mintAuthority], [membershipAuthority], [vaultAuthority], [spendAuthority], noBurnAuthority] = await Promise.all([
    findMintAuthorityPda(),
    findMembershipAuthorityPda(),
    findVaultAuthorityPda(),
    findSpendAuthorityPda(),
    findNoBurnAuthority(),
  ])
  const mint = config.qlcMint
  const tokenAccountOf = async (owner: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0]
  checks.push(
    { name: "config mint = owner mint identity", ok: mint === expectedMint, detail: mint },
    { name: "config admin = admin", ok: config.admin === admin, detail: config.admin },
    { name: "config operator = operator", ok: config.operator === operator, detail: config.operator },
    {
      name: "config limits = owner-approved devnet limits",
      ok:
        !devnet ||
        (config.maxDeliveryAmount === DEVNET_LIMITS.maxDeliveryAmount &&
          config.maxChargeAmount === DEVNET_LIMITS.maxChargeAmount &&
          config.mintWindowSecs === DEVNET_LIMITS.mintWindowSecs &&
          config.mintWindowCap === DEVNET_LIMITS.mintWindowCap),
      detail: `${config.maxDeliveryAmount} / ${config.maxChargeAmount} / ${config.mintWindowSecs} s / ${config.mintWindowCap}`,
    },
    { name: "program not paused", ok: !config.paused },
  )

  const mintInfo = await rpc.getAccountInfo(mint, { encoding: "base64" }).send()
  const expected = { mint, admin, mintAuthority, freezeAuthority: membershipAuthority, noBurnAuthority, ...QLC_METADATA, supply: config.totalMinted }
  let supply: bigint | null = null
  if (!mintInfo.value) checks.push({ name: "mint account exists", ok: false, detail: mint })
  else {
    const data = Buffer.from(mintInfo.value.data[0], "base64")
    checks.push(...checkMintTlv(mintInfo.value.owner, data, expected))
    try {
      const decoded = getMintDecoder().decode(data)
      supply = decoded.supply
      checks.push(...checkQlcMint(decoded, expected))
    } catch (err) {
      checks.push({ name: "mint: decodable Token-2022 mint", ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }

  // The vault: a missing or undecodable account is a failed check, never an unstructured exit.
  const expectedVault = await tokenAccountOf(vaultAuthority)
  checks.push({ name: "vault = associated QLC account of the program's vault authority", ok: config.vault === expectedVault, detail: `${config.vault} (expected ${expectedVault})` })
  let vault: Token | null = null
  try {
    const maybeVault = await fetchMaybeToken(rpc, config.vault)
    checks.push({ name: "vault account exists and decodes as a Token-2022 account", ok: maybeVault.exists, detail: maybeVault.exists ? config.vault : `${config.vault} not found` })
    if (maybeVault.exists) vault = maybeVault.data
  } catch (err) {
    checks.push({ name: "vault account exists and decodes as a Token-2022 account", ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
  if (vault) {
    checks.push(
      { name: "vault mint = QLC mint, owner = vault authority", ok: vault.mint === mint && vault.owner === vaultAuthority, detail: `mint ${vault.mint}, owner ${vault.owner}` },
      { name: "vault admitted (not frozen), no delegate, no close authority", ok: vault.state === AccountState.Initialized && unwrapOption(vault.delegate) === null && unwrapOption(vault.closeAuthority) === null },
    )
  }
  if (vault && supply !== null) {
    checks.push(
      ...accountingChecks({
        supply,
        vault: vault.amount,
        totalMinted: config.totalMinted,
        totalDelivered: config.totalDelivered,
        totalCharged: config.totalCharged,
        totalRefunded: config.totalRefunded,
      }),
    )
  } else {
    checks.push({ name: "accounting: supply / vault / totals invariant", ok: false, detail: "not evaluated: the mint or the vault could not be read" })
  }
  console.log(
    json({
      cluster: clusterName,
      genesis,
      programData,
      config: configAddress,
      mint,
      mintAuthority,
      freezeAuthority: membershipAuthority,
      vaultAuthority,
      spendAuthority,
      noBurnAuthority,
      vault: config.vault,
      vaultBalance: vault?.amount ?? null,
      supply,
      totals: { minted: config.totalMinted, delivered: config.totalDelivered, charged: config.totalCharged, refunded: config.totalRefunded },
    }),
  )
  for (const wallet of members) {
    const [memberAddress] = await findMemberPda({ wallet })
    const member = await fetchMaybeMember(rpc, memberAddress)
    const tokenAccount = await fetchMaybeToken(rpc, await tokenAccountOf(wallet))
    const token = tokenAccount.exists ? tokenAccount.data : null
    console.log(
      json({
        wallet,
        member: member.exists ? { address: memberAddress, suspended: member.data.suspended, lastChargeSeq: member.data.lastChargeSeq } : null,
        qlcAccount: token
          ? { address: tokenAccount.address, frozen: token.state === AccountState.Frozen, amount: token.amount, allowance: unwrapOption(token.delegate) === spendAuthority ? token.delegatedAmount : BigInt(0) }
          : null,
      }),
    )
  }
  return report(`QLC verification on ${clusterName} (read-only)`, checks, "QLC VERIFIED: program, config, mint, vault and accounting match the approved policy.")
}

if (process.argv[1]?.endsWith("qlc-verify.ts")) {
  main()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
