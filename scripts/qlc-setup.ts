// One-time QLC setup for a cluster, in two transactions. The default command is read-only: it checks the
// cluster, the program and its upgrade authority, the owner's mint identity, the limits, the payer and the live
// metadata URLs, decides the next step from on-chain state, and simulates the transactions (sigVerify off,
// nothing signed, nothing sent).
//
//   npm run qlc:setup -- plan --cluster devnet --payer C7pkmggd8mNoc1n9XitK6QP4HzdVGGhFTUrbUfFmo7Hp   read-only (default)
//   npm run qlc:setup -- create-mint --cluster devnet --payer C7pkmggd8mNoc1n9XitK6QP4HzdVGGhFTUrbUfFmo7Hp \
//       --payer-wallet phantom --mint-keypair <owner file> --execute                     OWNER MUTATION — DO NOT RUN
//   (or --payer-keypair <owner file> instead of --payer-wallet phantom for a local payer key, e.g. localnet)
//   npm run qlc:setup -- initialize --cluster localnet --admin-keypair <file> --execute  local rehearsal only
//
// TX1 create-mint: creates the owner's mint identity (Task 08) with exactly the approved Token-2022 extensions.
//   Signers: the payer (rent + fees) and the mint identity, which is also the transient mint authority inside
//   this one atomic transaction: it initializes the token metadata and hands the mint authority to the
//   program. The admin (owner Ledger) is only named as the pause, transfer-hook, metadata-pointer and metadata
//   update authority; it does not sign. The freeze authority is the program from the start.
// TX2 initialize: the program's initialize instruction. The program requires the upgrade authority (the owner
//   Ledger on devnet) to sign it AND to pay the config and vault rent (`payer = admin`). On devnet this script
//   only builds and simulates TX2; the owner signs it with the reviewed standalone Ledger signer
//   (tools/qlc-tx2-signer, Task 09A; the Ledger TX2 signer runbook (Notion)). Devnet TX1 sits behind the reviewed
//   integration gate below, opened in Task 09I once the owner prerequisites were met, so a mint is never created
//   that cannot be initialized right after; each step still runs only when the owner authorizes it.
//
// TX1 with a Phantom payer (--payer-wallet phantom, scripts/qlc-tx1-phantom.ts): the mint co-signs the exact reviewed
//   message first (Phantom then cannot add priority fees), Phantom signs on a local owner page, the result must be the
//   byte-identical message with both signatures valid, and the owner types SEND in the terminal before the single send.
//
// The setup never generates a key, never creates a second mint, never uses a default keypair, and reads key
// files only when the owner passes them to an --execute command. Mainnet is refused.
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit"
import { getCreateAccountInstruction } from "@solana-program/system"
import {
  AccountState,
  AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getInitializeDefaultAccountStateInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializePausableConfigInstruction,
  getInitializePermissionedBurnInstruction,
  getInitializeTokenMetadataInstruction,
  getInitializeTransferHookInstruction,
  getMintDecoder,
  getMintSize,
  getSetAuthorityInstruction,
  getTokenDecoder,
  getTokenSize,
} from "@solana-program/token-2022"
import {
  QELARIX_QLC_PROGRAM_ADDRESS,
  fetchMaybeConfig,
  findConfigPda,
  findMembershipAuthorityPda,
  findMintAuthorityPda,
  findVaultAuthorityPda,
  getConfigDecoder,
  getConfigSize,
  getInitializeInstructionAsync,
} from "../src/lib/qlc/generated"
import { QLC_DECIMALS, findNoBurnAuthority, formatQlc } from "../src/lib/qlc/qlcProgram"
import { REJECTED_ID_HASHES, report, sha256, type Check } from "./qlc-build-preflight"
import {
  CLUSTERS,
  DEVNET_LIMITS,
  DEVNET_SETUP,
  QLC_METADATA,
  assertCluster,
  checkMintTlv,
  checkQlcMint,
  limitChecks,
  metadataUrlChecks,
  payerChecks,
  readUpgradeAuthority,
  setupStage,
  type ClusterName,
  type Limits,
  type QlcMintExpectation,
} from "./qlc-policy"
import { messageHash, mintCoSign, sameExceptBlockhash, startOwnerSigningServer, verifyTx1Transaction, type PreparedTx1 } from "./qlc-tx1-phantom"

/**
 * Devnet owner-execution gate, opened by the reviewed Task 09I change: the Ledger TX2 signer path is reviewed and
 * accepted (Task 09A, tools/qlc-tx2-signer), the Phantom TX1 signing path is reviewed (Task 09H), the Devnet metadata
 * is live and the Ledger admin is funded. The open gate signs and sends nothing: devnet TX1 still needs
 * `create-mint --execute`, every plan and readiness check passing, the owner's typed SEND and the owner's explicit
 * authorization of that exact step. Changing it is a reviewed code change, never a flag.
 */
export const DEVNET_INITIALIZE_SIGNING_APPROVED = true
const LAMPORTS_PER_SIGNATURE = 5_000
const COMMANDS = ["plan", "create-mint", "initialize"] as const
type Command = (typeof COMMANDS)[number]

export interface SetupInputs {
  cluster: ClusterName
  mint: Address
  admin: Address
  operator: Address
  payer: Address
  limits: Limits
}

/** The QLC mint transaction (TX1): exactly the approved extensions; signers = payer + mint identity only. */
export function createMintInstructions(input: {
  payer: TransactionSigner
  mint: TransactionSigner
  admin: Address
  mintAuthority: Address
  freezeAuthority: Address
  noBurnAuthority: Address
  lamports: bigint
  space: number
}): Instruction[] {
  const { payer, mint, admin } = input
  const metadata = { name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: QLC_METADATA.uri }
  return [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: input.lamports, space: input.space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializeMetadataPointerInstruction({ mint: mint.address, authority: admin, metadataAddress: mint.address }),
    getInitializeDefaultAccountStateInstruction({ mint: mint.address, state: AccountState.Frozen }),
    getInitializePermissionedBurnInstruction({ mint: mint.address, authority: input.noBurnAuthority }),
    getInitializePausableConfigInstruction({ mint: mint.address, authority: admin }),
    getInitializeTransferHookInstruction({ mint: mint.address, authority: admin, programId: null }),
    // The mint identity is the mint authority only inside this transaction: it signs the metadata
    // initialization, then the last instruction hands the mint authority to the program for good.
    getInitializeMint2Instruction({ mint: mint.address, decimals: QLC_DECIMALS, mintAuthority: mint.address, freezeAuthority: input.freezeAuthority }),
    getInitializeTokenMetadataInstruction({ metadata: mint.address, updateAuthority: admin, mint: mint.address, mintAuthority: mint, ...metadata }),
    getSetAuthorityInstruction({ owned: mint.address, owner: mint, authorityType: AuthorityType.MintTokens, newAuthority: input.mintAuthority }),
  ]
}

/** Mint account space at creation (fixed extensions) and the rent for its final size (with the metadata). */
export function mintSizes(admin: Address, mint: Address, noBurnAuthority: Address): { space: number; finalSize: number } {
  const fixed = [
    extension("MetadataPointer", { authority: admin, metadataAddress: mint }),
    extension("DefaultAccountState", { state: AccountState.Frozen }),
    extension("PermissionedBurn", { authority: noBurnAuthority }),
    extension("PausableConfig", { authority: admin, paused: false }),
    extension("TransferHook", { authority: admin, programId: address("11111111111111111111111111111111") }),
  ]
  const tokenMetadata = extension("TokenMetadata", { updateAuthority: admin, mint, name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: QLC_METADATA.uri, additionalMetadata: new Map() })
  return { space: getMintSize(fixed), finalSize: getMintSize([...fixed, tokenMetadata]) }
}

/** Devnet inputs must be exactly the owner-approved identities and limits. */
export function inputChecks(inputs: SetupInputs, upgradeAuthority: Address | null): Check[] {
  const devnet = inputs.cluster === "devnet"
  const rejected = [inputs.mint, inputs.admin, inputs.operator, inputs.payer].filter((value) => REJECTED_ID_HASHES.has(sha256(value)))
  return [
    { name: `input: mint = owner mint identity ${DEVNET_SETUP.mint} (devnet)`, ok: !devnet || inputs.mint === DEVNET_SETUP.mint, detail: inputs.mint },
    { name: `input: admin = program upgrade authority${devnet ? ` = owner Ledger ${DEVNET_SETUP.admin}` : ""}`, ok: inputs.admin === upgradeAuthority && (!devnet || inputs.admin === DEVNET_SETUP.admin), detail: `${inputs.admin} (upgrade authority ${upgradeAuthority})` },
    { name: `input: operator = ${devnet ? DEVNET_SETUP.operator : "given operator"}`, ok: !devnet || inputs.operator === DEVNET_SETUP.operator, detail: inputs.operator },
    { name: `input: payer = owner-approved TX1 setup payer ${DEVNET_SETUP.payer} (devnet)`, ok: !devnet || inputs.payer === DEVNET_SETUP.payer, detail: inputs.payer },
    { name: "input: all roles distinct (mint, admin, operator, payer)", ok: new Set([inputs.mint, inputs.admin, inputs.operator, inputs.payer]).size === 4 },
    { name: "input: no rejected identity", ok: rejected.length === 0, detail: rejected.length ? "REJECTED identity — STOP" : undefined },
    ...payerChecks(inputs.payer),
    ...limitChecks(inputs.limits, inputs.cluster),
  ]
}

/** Strict arguments: unknown, repeated or value-less flags are errors, never ignored. */
export function parseArgs(argv: string[]): { command: Command; values: Record<string, string>; execute: boolean; errors: string[] } {
  const errors: string[] = []
  const [first, ...rest] = argv
  const command = (COMMANDS as readonly string[]).includes(first) ? (first as Command) : "plan"
  const args = command === first ? rest : argv
  const allowed = ["--cluster", "--payer", "--mint", "--admin", "--operator", "--payer-keypair", "--payer-wallet", "--mint-keypair", "--admin-keypair", "--max-delivery", "--max-charge", "--window-secs", "--window-cap"]
  const values: Record<string, string> = {}
  let execute = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute") execute = true
    else if (!allowed.includes(args[i])) errors.push(`unknown argument ${JSON.stringify(args[i])}`)
    else if (args[i + 1] === undefined || args[i + 1].startsWith("--")) errors.push(`${args[i]} has no value`)
    else if (args[i] in values) errors.push(`${args[i]} given more than once`)
    else values[args[i]] = args[++i]
  }
  if (values["--payer-wallet"] !== undefined && values["--payer-wallet"] !== "phantom") errors.push('--payer-wallet accepts only "phantom"')
  if (values["--payer-wallet"] !== undefined && values["--payer-keypair"] !== undefined) errors.push("use either --payer-keypair or --payer-wallet phantom, not both")
  return { command, values, execute, errors }
}

async function signerFromFile(path: string, expected: Address, role: string): Promise<KeyPairSigner> {
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]))
  if (signer.address !== expected) throw new Error(`STOP: the ${role} key file resolves to ${signer.address}, not ${expected}`)
  return signer
}

async function main(): Promise<boolean> {
  const { command, values, execute, errors } = parseArgs(process.argv.slice(2))
  const cluster = values["--cluster"] as ClusterName
  if (!CLUSTERS[cluster]) errors.push("--cluster must be localnet or devnet (mainnet is a separate launch task)")
  if (!values["--payer"]) errors.push("--payer <address> is required (explicit setup payer)")
  if (errors.length) {
    for (const error of errors) console.error(`argument: ${error}`)
    return false
  }
  const rpc = createSolanaRpc(CLUSTERS[cluster].http)
  const genesis = await assertCluster(rpc, cluster)
  const { programData, deployed, upgradeAuthority } = await readUpgradeAuthority(rpc)
  const devnet = cluster === "devnet"
  const bigint = (flag: string, fallback: bigint) => (values[flag] ? BigInt(values[flag]) : fallback)
  const inputs: SetupInputs = {
    cluster,
    mint: address(values["--mint"] ?? DEVNET_SETUP.mint),
    admin: address(values["--admin"] ?? (devnet ? DEVNET_SETUP.admin : (upgradeAuthority ?? DEVNET_SETUP.admin))),
    operator: address(values["--operator"] ?? DEVNET_SETUP.operator),
    payer: address(values["--payer"]),
    limits: {
      maxDeliveryAmount: bigint("--max-delivery", DEVNET_LIMITS.maxDeliveryAmount),
      maxChargeAmount: bigint("--max-charge", DEVNET_LIMITS.maxChargeAmount),
      mintWindowSecs: bigint("--window-secs", DEVNET_LIMITS.mintWindowSecs),
      mintWindowCap: bigint("--window-cap", DEVNET_LIMITS.mintWindowCap),
    },
  }
  const [[config], [mintAuthority], [membershipAuthority], [vaultAuthority], noBurnAuthority] = await Promise.all([
    findConfigPda(),
    findMintAuthorityPda(),
    findMembershipAuthorityPda(),
    findVaultAuthorityPda(),
    findNoBurnAuthority(),
  ])
  const [vault] = await findAssociatedTokenPda({ owner: vaultAuthority, mint: inputs.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const expected: QlcMintExpectation = { mint: inputs.mint, admin: inputs.admin, mintAuthority, freezeAuthority: membershipAuthority, noBurnAuthority, ...QLC_METADATA }

  const checks: Check[] = [
    { name: "cluster: RPC genesis matches --cluster", ok: true, detail: `${cluster} ${genesis}` },
    { name: `program: ${QELARIX_QLC_PROGRAM_ADDRESS} deployed`, ok: deployed },
    ...inputChecks(inputs, upgradeAuthority),
  ]

  // On-chain state decides the next step; a second mint is never created.
  const [mintInfo, maybeConfig, payerInfo, adminInfo] = await Promise.all([
    rpc.getAccountInfo(inputs.mint, { encoding: "base64" }).send(),
    fetchMaybeConfig(rpc, config),
    rpc.getBalance(inputs.payer).send(),
    rpc.getBalance(inputs.admin).send(),
  ])
  const mintAccount = mintInfo.value ? { owner: mintInfo.value.owner as string, data: Buffer.from(mintInfo.value.data[0], "base64") } : null
  let mintChecks: Check[] = []
  if (mintAccount && mintAccount.owner === TOKEN_2022_PROGRAM_ADDRESS) {
    mintChecks = [...checkMintTlv(mintAccount.owner, mintAccount.data, expected)]
    try {
      mintChecks.push(...checkQlcMint(getMintDecoder().decode(mintAccount.data), expected))
    } catch {
      mintChecks.push({ name: "mint: decodable Token-2022 mint", ok: false })
    }
  }
  const stage = setupStage({ mintAccount, mintValid: mintChecks.length > 0 && mintChecks.every((c) => c.ok), configMint: maybeConfig.exists ? maybeConfig.data.qlcMint : null, mint: inputs.mint })
  checks.push({ name: `state: next step = ${stage.stage}`, ok: stage.stage !== "stop", detail: stage.reason }, ...mintChecks)
  const metadataLive = devnet ? await metadataUrlChecks() : []

  // Costs, by who pays them.
  const { space, finalSize } = mintSizes(inputs.admin, inputs.mint, noBurnAuthority)
  const vaultSize = getTokenSize([extension("ImmutableOwner", {}), extension("TransferHookAccount", { transferring: false }), extension("PausableAccount", {})])
  const [mintRent, configRent, vaultRent] = await Promise.all([finalSize, getConfigSize(), vaultSize].map((size) => rpc.getMinimumBalanceForRentExemption(BigInt(size)).send()))
  const tx1Cost = mintRent + BigInt(2 * LAMPORTS_PER_SIGNATURE)
  const tx2Cost = configRent + vaultRent + BigInt(LAMPORTS_PER_SIGNATURE)

  const blockhash = (await rpc.getLatestBlockhash().send()).value
  const buildWith = (feePayer: TransactionSigner, instructions: Instruction[], lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }) =>
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
  const build = (feePayer: TransactionSigner, instructions: Instruction[]) => buildWith(feePayer, instructions, blockhash)
  const simulate = async (wire: string, addresses: Address[]) =>
    (await rpc.simulateTransaction(wire as never, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { addresses, encoding: "base64" } }).send()).value

  // TX1, unsigned (noop signers): simulated and its resulting mint checked against the policy.
  const payerNoop = createNoopSigner(inputs.payer)
  const mintNoop = createNoopSigner(inputs.mint)
  const tx1Instructions = createMintInstructions({ payer: payerNoop, mint: mintNoop, admin: inputs.admin, mintAuthority, freezeAuthority: membershipAuthority, noBurnAuthority, lamports: mintRent, space })
  const tx1Message = build(payerNoop, tx1Instructions)
  const tx1Compiled = compileTransaction(tx1Message)
  if (stage.stage === "create-mint") {
    const result = await simulate(getBase64EncodedWireTransaction(tx1Compiled), [inputs.mint])
    const simulated = result.accounts?.[0]
    checks.push({ name: "TX1 simulation (sigVerify off, nothing signed or sent) succeeds", ok: !result.err && Boolean(simulated), detail: result.err ? `${JSON.stringify(result.err)} ${(result.logs ?? []).slice(-3).join(" | ")}` : `${result.unitsConsumed} CU` })
    if (simulated) {
      const data = Buffer.from(simulated.data[0], "base64")
      checks.push(...checkMintTlv(simulated.owner, data, expected).map((c) => ({ ...c, name: `TX1 result ${c.name}` })))
      checks.push(...checkQlcMint(getMintDecoder().decode(data), expected).map((c) => ({ ...c, name: `TX1 result ${c.name}` })))
    }
  }

  // TX2, unsigned: the admin signs and pays (program constraint). Simulated once the mint exists.
  const adminNoop = createNoopSigner(inputs.admin)
  const initialize = await getInitializeInstructionAsync({ admin: adminNoop, qlcMint: inputs.mint, programData, operator: inputs.operator, ...inputs.limits })
  const tx2Wire = getBase64EncodedWireTransaction(compileTransaction(build(adminNoop, [initialize])))
  if (stage.stage === "initialize") {
    const result = await simulate(tx2Wire, [config, vault])
    const ok = !result.err && Boolean(result.accounts?.[0] && result.accounts?.[1])
    checks.push({ name: "TX2 simulation (sigVerify off, nothing signed or sent) succeeds", ok, detail: result.err ? `${JSON.stringify(result.err)} ${(result.logs ?? []).slice(-3).join(" | ")}` : `${result.unitsConsumed} CU` })
    if (ok) {
      const configData = getConfigDecoder().decode(Buffer.from(result.accounts![0]!.data[0], "base64"))
      const vaultData = getTokenDecoder().decode(Buffer.from(result.accounts![1]!.data[0], "base64"))
      checks.push(
        {
          name: "TX2 result: config admin, operator, mint, vault and limits exactly as approved; not paused",
          ok:
            configData.admin === inputs.admin &&
            configData.operator === inputs.operator &&
            configData.qlcMint === inputs.mint &&
            configData.vault === vault &&
            configData.maxDeliveryAmount === inputs.limits.maxDeliveryAmount &&
            configData.maxChargeAmount === inputs.limits.maxChargeAmount &&
            configData.mintWindowSecs === inputs.limits.mintWindowSecs &&
            configData.mintWindowCap === inputs.limits.mintWindowCap &&
            !configData.paused,
        },
        { name: "TX2 result: vault owned by the vault authority, admitted (thawed)", ok: vaultData.owner === vaultAuthority && vaultData.mint === inputs.mint && vaultData.state === AccountState.Initialized },
      )
    }
  } else if (stage.stage === "create-mint") {
    checks.push({ name: "TX2 simulation", ok: true, info: true, detail: "possible only after TX1 has created the mint (the program reads it)" })
  }

  checks.push(
    { name: `cost TX1 (payer ${inputs.payer})`, ok: true, info: true, detail: `${tx1Cost} lamports: mint rent ${mintRent} (${finalSize} bytes) + 2 signatures; payer balance ${payerInfo.value}` },
    { name: `cost TX2 (admin ${inputs.admin}, program constraint payer = admin)`, ok: true, info: true, detail: `${tx2Cost} lamports: config rent ${configRent} (${getConfigSize()} bytes) + vault rent ${vaultRent} (${vaultSize} bytes) + 1 signature; admin balance ${adminInfo.value}` },
    { name: "plan", ok: true, info: true, detail: `mint ${inputs.mint}, mint authority ${mintAuthority}, freeze authority ${membershipAuthority}, no-burn ${noBurnAuthority}, config ${config}, vault ${vault}; limits ${formatQlc(inputs.limits.maxDeliveryAmount)} / ${formatQlc(inputs.limits.maxChargeAmount)} / ${formatQlc(inputs.limits.mintWindowCap)} QLC per ${inputs.limits.mintWindowSecs} s` },
  )

  const plannedOk = checks.every((c) => c.ok)
  // Owner execution readiness: every check, funding, and (devnet) an approved signing path for TX2.
  const readiness: Check[] = [
    ...metadataLive.map((c) => ({ ...c, name: `readiness: ${c.name}` })),
    { name: "readiness: payer can fund TX1", ok: stage.stage !== "create-mint" || payerInfo.value >= tx1Cost, detail: `${payerInfo.value} ≥ ${tx1Cost}` },
    { name: "readiness: admin can fund TX2 (program constraint)", ok: stage.stage === "initialized" || adminInfo.value >= tx2Cost, detail: `${adminInfo.value} ≥ ${tx2Cost}` },
    {
      name: "readiness: owner-execution gate open (DEVNET_INITIALIZE_SIGNING_APPROVED)",
      ok: !devnet || DEVNET_INITIALIZE_SIGNING_APPROVED,
      detail:
        devnet && !DEVNET_INITIALIZE_SIGNING_APPROVED
          ? "BLOCKED: gate closed. TX2 signer reviewed (Task 09A, the Ledger TX2 signer runbook (Notion)); owner execution awaits explicit owner authorization (live metadata verified, Ledger admin funded)"
          : undefined,
    },
  ]

  if (command === "plan" || !execute) {
    const ready = plannedOk && readiness.every((c) => c.ok)
    report(
      `QLC setup ${command} on ${cluster} (read-only: nothing signed or sent)`,
      [...checks, ...readiness.map((c) => ({ ...c, ok: true, info: !c.ok ? true : c.info, name: `${c.ok ? "" : "BLOCKED "}${c.name}` }))],
      ready ? "Plan verified. Owner execution may proceed step by step (OWNER MUTATION — DO NOT RUN without explicit approval)." : "Plan verified, but owner execution is BLOCKED (see the BLOCKED readiness lines).",
    )
    return plannedOk && (command === "plan" || ready)
  }

  // ---- OWNER MUTATION — DO NOT RUN (executed only by PixiMan, one step at a time, after review). ----
  console.log("OWNER MUTATION — this command signs and sends a transaction.")
  if (!plannedOk || !readiness.every((c) => c.ok)) {
    report(`QLC setup ${command} on ${cluster}`, [...checks, ...readiness], "")
    return false
  }
  const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(CLUSTERS[cluster].ws) })
  if (command === "create-mint") {
    if (stage.stage !== "create-mint") throw new Error(`STOP: next step is ${stage.stage}, not create-mint (${stage.reason})`)
    const phantom = values["--payer-wallet"] === "phantom"
    if (!values["--mint-keypair"] || (!phantom && !values["--payer-keypair"])) {
      throw new Error("create-mint --execute needs --mint-keypair (owner file) and either --payer-keypair (owner file) or --payer-wallet phantom")
    }
    const mint = await signerFromFile(values["--mint-keypair"], inputs.mint, "mint identity")
    const signWithKeyFiles = async () => {
      const payer = await signerFromFile(values["--payer-keypair"], inputs.payer, "payer")
      return signTransactionMessageWithSigners(build(payer, createMintInstructions({ payer, mint, admin: inputs.admin, mintAuthority, freezeAuthority: membershipAuthority, noBurnAuthority, lamports: mintRent, space })))
    }
    const signWithPhantom = async () => {
      // Phantom payer: a fresh blockhash, the same reviewed instructions, re-verified and re-simulated before the mint
      // co-signs; Phantom signs on the local owner page; the owner types SEND here.
      const prepare = async (): Promise<PreparedTx1> => {
        const fresh = (await rpc.getLatestBlockhash().send()).value
        const unsigned = compileTransaction(buildWith(payerNoop, tx1Instructions, fresh))
        if (!sameExceptBlockhash(new Uint8Array(tx1Compiled.messageBytes), new Uint8Array(unsigned.messageBytes))) {
          throw new Error("STOP: the refreshed TX1 differs from the reviewed TX1 beyond the blockhash")
        }
        if ((await rpc.getAccountInfo(inputs.mint, { encoding: "base64" }).send()).value) throw new Error("STOP: the mint address is no longer unused")
        const result = await simulate(getBase64EncodedWireTransaction(unsigned), [inputs.mint])
        const simulated = result.accounts?.[0]
        if (result.err || !simulated) throw new Error(`STOP: the refreshed TX1 simulation failed: ${JSON.stringify(result.err)}`)
        const data = Buffer.from(simulated.data[0], "base64")
        const policy = [...checkMintTlv(simulated.owner, data, expected), ...checkQlcMint(getMintDecoder().decode(data), expected)]
        if (!policy.every((c) => c.ok)) throw new Error(`STOP: the refreshed TX1 result fails the policy: ${policy.filter((c) => !c.ok).map((c) => c.name).join("; ")}`)
        const tx1Expected = { messageBytes: new Uint8Array(unsigned.messageBytes), payer: inputs.payer, mint: inputs.mint }
        const wire = await mintCoSign(unsigned, tx1Expected, mint)
        const hash = messageHash(tx1Expected.messageBytes)
        console.log(`Prepared TX1 (mint co-signed). Message Hash: ${hash}; valid until block height ${fresh.lastValidBlockHeight}`)
        return { wire, expected: tx1Expected, messageHash: hash, blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight }
      }
      const session = await startOwnerSigningServer({ payer: inputs.payer, mint: inputs.mint, prepare })
      console.log(`Open this page in the browser with Phantom on the approved payer account ${inputs.payer} (Phantom testnet mode: devnet):`)
      console.log(`  ${session.url}`)
      const { wire, prepared } = await session.signed
      await session.close()
      // Final re-check before the single send: still the reviewed message with both signatures, blockhash valid, mint unused.
      const problems = await verifyTx1Transaction(wire, prepared.expected, { payer: true, mint: true })
      if (problems.length) throw new Error(`STOP: ${problems.join("; ")}`)
      const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send()
      if (height > prepared.lastValidBlockHeight) throw new Error(`STOP: the blockhash expired (block height ${height} > ${prepared.lastValidBlockHeight}); nothing was sent. Rerun the command`)
      if ((await rpc.getAccountInfo(inputs.mint, { encoding: "base64" }).send()).value) throw new Error("STOP: the mint address is no longer unused; nothing was sent")
      const decoded = getTransactionDecoder().decode(wire)
      console.log(`Verified: Message Hash ${prepared.messageHash}; payer ${inputs.payer} and mint ${inputs.mint} signatures valid; TX1 ${getSignatureFromTransaction(decoded)}`)
      const terminal = createInterface({ input: process.stdin, output: process.stdout })
      const answer = (await terminal.question("Type SEND to submit TX1 once (anything else aborts): ")).trim()
      terminal.close()
      if (answer !== "SEND") throw new Error("STOP: not confirmed; nothing was sent")
      const transaction = { ...decoded, lifetimeConstraint: { blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight } }
      assertIsSendableTransaction(transaction)
      return transaction
    }
    const signed = phantom ? await signWithPhantom() : await signWithKeyFiles()
    assertIsTransactionWithBlockhashLifetime(signed)
    console.log(`TX1 ${getSignatureFromTransaction(signed)}: sending`)
    await send(signed, { commitment: "confirmed" })
    const created = await rpc.getAccountInfo(inputs.mint, { encoding: "base64" }).send()
    const data = Buffer.from(created.value!.data[0], "base64")
    return report(`QLC mint created on ${cluster}`, [...checkMintTlv(created.value!.owner, data, expected), ...checkQlcMint(getMintDecoder().decode(data), expected)], "Mint verified. Next: initialize (separately authorized).")
  }
  if (devnet) throw new Error("STOP: initialize on devnet is signed only by the owner with the Ledger TX2 signer (tools/qlc-tx2-signer, the Ledger TX2 signer runbook (Notion)); this script never signs it")
  if (stage.stage !== "initialize") throw new Error(`STOP: next step is ${stage.stage}, not initialize (${stage.reason})`)
  if (!values["--admin-keypair"]) throw new Error("initialize --execute on localnet needs --admin-keypair")
  const admin = await signerFromFile(values["--admin-keypair"], inputs.admin, "admin")
  const signed = await signTransactionMessageWithSigners(build(admin, [await getInitializeInstructionAsync({ admin, qlcMint: inputs.mint, programData, operator: inputs.operator, ...inputs.limits })]))
  assertIsTransactionWithBlockhashLifetime(signed)
  await send(signed, { commitment: "confirmed" })
  console.log(`TX2 ${getSignatureFromTransaction(signed)}: program initialized. Verify with npm run qlc:verify.`)
  return true
}

if (process.argv[1]?.endsWith("qlc-setup.ts")) {
  main()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      // Preflight failures carry the program logs; they are the only way to see why a step was refused.
      const logs = (err as { context?: { logs?: string[] } })?.context?.logs
      if (logs?.length) console.error(logs.join("\n"))
      process.exit(1)
    })
}
