// Offline checks for the QLC setup workflow (scripts/qlc-setup.ts + scripts/qlc-policy.ts + scripts/qlc-verify.ts):
// the exact Token-2022 policy (raw TLV and decoded, including malformed TLV), the mint transaction's signers and
// instructions, the owner-approved inputs and TX1 payer, the resume state machine, the devnet owner-execution gate,
// the metadata checks, the verifier's accounting invariant and its strict arguments. Synthetic mints are encoded
// with the official @solana-program/token-2022 encoder. No network, no keys, no chain.
//
//   npm run check:qlc-setup
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  some,
  type Address,
} from "@solana/kit"
import {
  AccountState,
  INITIALIZE_DEFAULT_ACCOUNT_STATE_DISCRIMINATOR,
  INITIALIZE_METADATA_POINTER_DISCRIMINATOR,
  INITIALIZE_MINT2_DISCRIMINATOR,
  INITIALIZE_PAUSABLE_CONFIG_DISCRIMINATOR,
  INITIALIZE_PERMISSIONED_BURN_DISCRIMINATOR,
  INITIALIZE_TOKEN_METADATA_DISCRIMINATOR,
  INITIALIZE_TRANSFER_HOOK_DISCRIMINATOR,
  SET_AUTHORITY_DISCRIMINATOR,
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getMintDecoder,
  getMintEncoder,
  type ExtensionArgs,
} from "@solana-program/token-2022"
import { findMembershipAuthorityPda, findMintAuthorityPda } from "../src/lib/qlc/generated"
import { findNoBurnAuthority } from "../src/lib/qlc/qlcProgram"
import { REJECTED_ID_HASHES, ROOT, sha256, type Check } from "./qlc-build-preflight"
import { DEVNET_INITIALIZE_SIGNING_APPROVED, createMintInstructions, inputChecks, mintSizes, parseArgs, type SetupInputs } from "./qlc-setup"
import { parseVerifyArgs } from "./qlc-verify"
import {
  DEVNET_LIMITS,
  DEVNET_SETUP,
  QLC_METADATA,
  accountingChecks,
  checkMintTlv,
  checkQlcMint,
  metadataJsonChecks,
  metadataUrlChecks,
  setupStage,
  type QlcMintExpectation,
} from "./qlc-policy"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
function expectPass(name: string, checks: Check[]) {
  const failed = checks.filter((c) => !c.ok)
  check(name, failed.length === 0, failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; "))
}
function expectFail(name: string, checks: Check[], fragment: string) {
  const failed = checks.filter((c) => !c.ok)
  check(
    `fails closed: ${name}`,
    failed.some((c) => c.name.includes(fragment) || c.detail?.includes(fragment)),
    failed.length ? `blocked by: ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail.slice(0, 120)})` : ""}`).join("; ")}` : "nothing failed",
  )
}

const SYSTEM = address("11111111111111111111111111111111")
/** Owner-approved TX1 setup payer (Deploy_Fee_Payer). */
const PAYER = "C7pkmggd8mNoc1n9XitK6QP4HzdVGGhFTUrbUfFmo7Hp"
/** Deploy_CLI_Signer_DEV: program deploys only, never the TX1 payer. */
const DEPLOY_CLI_SIGNER = "GJPDitCMWnH3bPYFUJRWwyXdXmErBhwrS5EoYz6JZwmz"
const OTHER = address("Stake11111111111111111111111111111111111111")

async function main() {
  const mint = address(DEVNET_SETUP.mint)
  const admin = address(DEVNET_SETUP.admin)
  const [[mintAuthority], [freezeAuthority], noBurnAuthority] = await Promise.all([findMintAuthorityPda(), findMembershipAuthorityPda(), findNoBurnAuthority()])
  const expected: QlcMintExpectation = { mint, admin, mintAuthority, freezeAuthority, noBurnAuthority, ...QLC_METADATA }

  type Variant = Partial<{ decimals: number; supply: bigint; mintAuthority: Address; freezeAuthority: Address; initialized: boolean; extensions: ExtensionArgs[]; drop: string[]; add: ExtensionArgs[] }>
  const approvedExtensions = (): ExtensionArgs[] => [
    extension("MetadataPointer", { authority: some(admin), metadataAddress: some(mint) }),
    extension("DefaultAccountState", { state: AccountState.Frozen }),
    extension("PermissionedBurn", { authority: some(noBurnAuthority) }),
    extension("PausableConfig", { authority: some(admin), paused: false }),
    extension("TransferHook", { authority: admin, programId: SYSTEM }),
    extension("TokenMetadata", { updateAuthority: some(admin), mint, name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: QLC_METADATA.uri, additionalMetadata: new Map() }),
  ]
  const encode = (v: Variant = {}) => {
    const extensions = (v.extensions ?? approvedExtensions()).filter((e) => !(v.drop ?? []).includes(e.__kind)).concat(v.add ?? [])
    return Buffer.from(
      getMintEncoder().encode({
        mintAuthority: some(v.mintAuthority ?? mintAuthority),
        supply: v.supply ?? BigInt(0),
        decimals: v.decimals ?? 2,
        isInitialized: v.initialized ?? true,
        freezeAuthority: some(v.freezeAuthority ?? freezeAuthority),
        extensions: some(extensions),
      }),
    )
  }
  const both = (data: Buffer, owner: string = TOKEN_2022_PROGRAM_ADDRESS): Check[] => {
    const raw = checkMintTlv(owner, data, expected)
    let decoded: Check[]
    try {
      decoded = checkQlcMint(getMintDecoder().decode(data), expected)
    } catch {
      decoded = [{ name: "decoded: undecodable", ok: false }]
    }
    return [...raw, ...decoded]
  }
  const replaceExtension = (kind: string, replacement: ExtensionArgs) => approvedExtensions().map((e) => (e.__kind === kind ? replacement : e))

  console.log("— exact Token-2022 policy (raw TLV + decoded)")
  const good = encode()
  expectPass("the approved QLC mint passes both independent checks", both(good))
  check("raw and decoded checks both run (independent decoders)", checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, good, expected).length >= 4 && checkQlcMint(getMintDecoder().decode(good), expected).length >= 10)
  const variants: [string, Variant, string][] = [
    ["decimals 9", { decimals: 9 }, "decimals"],
    ["supply already minted", { supply: BigInt(5) }, "supply"],
    ["mint authority kept by the admin", { mintAuthority: admin }, "mint authority"],
    ["freeze authority kept by the admin", { freezeAuthority: admin }, "freeze authority"],
    ["mint not initialized", { initialized: false }, "initialized"],
    ["extra PermanentDelegate", { add: [extension("PermanentDelegate", { delegate: admin })] }, "PermanentDelegate"],
    ["extra MintCloseAuthority", { add: [extension("MintCloseAuthority", { closeAuthority: admin })] }, "MintCloseAuthority"],
    ["extra NonTransferable", { add: [extension("NonTransferable", {})] }, "NonTransferable"],
    ["extra InterestBearingConfig", { add: [extension("InterestBearingConfig", { rateAuthority: admin, initializationTimestamp: BigInt(0), preUpdateAverageRate: 0, lastUpdateTimestamp: BigInt(0), currentRate: 0 })] }, "InterestBearing"],
    ["missing PausableConfig", { drop: ["PausableConfig"] }, "PausableConfig"],
    ["missing PermissionedBurn", { drop: ["PermissionedBurn"] }, "PermissionedBurn"],
    ["missing DefaultAccountState", { drop: ["DefaultAccountState"] }, "DefaultAccountState"],
    ["DefaultAccountState Initialized (accounts not frozen)", { extensions: replaceExtension("DefaultAccountState", extension("DefaultAccountState", { state: AccountState.Initialized })) }, "Frozen"],
    ["burn authority = admin (burning possible)", { extensions: replaceExtension("PermissionedBurn", extension("PermissionedBurn", { authority: some(admin) })) }, "PermissionedBurn"],
    ["mint paused", { extensions: replaceExtension("PausableConfig", extension("PausableConfig", { authority: some(admin), paused: true })) }, "Pausable"],
    ["pause authority = someone else", { extensions: replaceExtension("PausableConfig", extension("PausableConfig", { authority: some(OTHER), paused: false })) }, "Pausable"],
    ["transfer hook program active", { extensions: replaceExtension("TransferHook", extension("TransferHook", { authority: admin, programId: OTHER })) }, "TransferHook"],
    ["transfer hook authority = someone else", { extensions: replaceExtension("TransferHook", extension("TransferHook", { authority: OTHER, programId: SYSTEM })) }, "TransferHook"],
    ["metadata pointer elsewhere", { extensions: replaceExtension("MetadataPointer", extension("MetadataPointer", { authority: some(admin), metadataAddress: some(OTHER) })) }, "MetadataPointer"],
    ["metadata pointer authority = someone else", { extensions: replaceExtension("MetadataPointer", extension("MetadataPointer", { authority: some(OTHER), metadataAddress: some(mint) })) }, "MetadataPointer"],
    [
      "metadata uri changed",
      { extensions: replaceExtension("TokenMetadata", extension("TokenMetadata", { updateAuthority: some(admin), mint, name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: "https://evil.example/qlc.json", additionalMetadata: new Map() })) },
      "TokenMetadata",
    ],
    [
      "metadata update authority = someone else",
      { extensions: replaceExtension("TokenMetadata", extension("TokenMetadata", { updateAuthority: some(OTHER), mint, name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: QLC_METADATA.uri, additionalMetadata: new Map() })) },
      "TokenMetadata",
    ],
    [
      "extra metadata field",
      { extensions: replaceExtension("TokenMetadata", extension("TokenMetadata", { updateAuthority: some(admin), mint, name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: QLC_METADATA.uri, additionalMetadata: new Map([["tradable", "yes"]]) })) },
      "TokenMetadata",
    ],
    ["metadata without an update authority", { extensions: replaceExtension("TokenMetadata", extension("TokenMetadata", { updateAuthority: none(), mint, name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: QLC_METADATA.uri, additionalMetadata: new Map() })) }, "TokenMetadata"],
  ]
  for (const [name, variant, fragment] of variants) {
    const result = both(encode(variant))
    expectFail(name, result, fragment)
    check(`  … the raw TLV check alone also refuses: ${name}`, checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, encode(variant), expected).some((c) => !c.ok))
  }
  expectFail("account owned by another program", both(good, SYSTEM), "owned by Token-2022")
  const unknown = Buffer.concat([good, Buffer.from([99, 0, 1, 0, 0])])
  expectFail("unknown extension type appended to the TLV area", checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, unknown, expected), "forbidden extension")
  const duplicated = (() => {
    // Append a second DefaultAccountState TLV entry (type 6, length 1, Frozen).
    return Buffer.concat([good, Buffer.from([6, 0, 1, 0, 2])])
  })()
  expectFail("duplicated extension", checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, duplicated, expected), "duplicate")
  const tokenAccountType = Buffer.from(good)
  tokenAccountType[165] = 2
  expectFail("token account instead of a mint", checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, tokenAccountType, expected), "mint account type")
  const truncated = good.subarray(0, good.length - 10)
  expectFail("truncated TLV area", checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, truncated, expected), "truncated")

  console.log("— raw TLV: canonical lengths and padding (parity with the Rust signer's checker)")
  const entriesOf = (data: Buffer) => {
    const out: [number, Buffer][] = []
    for (let o = 166; o + 4 <= data.length; ) {
      const type = data.readUInt16LE(o)
      const length = data.readUInt16LE(o + 2)
      if (type === 0) break
      out.push([type, data.subarray(o + 4, o + 4 + length)])
      o += 4 + length
    }
    return out
  }
  const rebuild = (list: [number, Buffer][]) =>
    Buffer.concat([
      good.subarray(0, 166),
      ...list.map(([type, value]) => {
        const header = Buffer.alloc(4)
        header.writeUInt16LE(type, 0)
        header.writeUInt16LE(value.length, 2)
        return Buffer.concat([header, value])
      }),
    ])
  const goodEntries = entriesOf(good)
  check("TLV rebuild helper reproduces the encoder's bytes", rebuild(goodEntries).equals(good))
  const raw = (data: Buffer) => checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, data, expected)
  for (const [type, name] of [
    [6, "DefaultAccountState"],
    [28, "PermissionedBurn"],
    [26, "PausableConfig"],
    [14, "TransferHook"],
    [18, "MetadataPointer"],
  ] as const) {
    const resized = (delta: number) => rebuild(goodEntries.map(([t, v]) => [t, t === type ? (delta > 0 ? Buffer.concat([v, Buffer.alloc(delta)]) : v.subarray(0, v.length + delta)) : v]))
    expectFail(`${name} payload one byte short`, raw(resized(-1)), "has length")
    expectFail(`${name} payload one byte overlong (zero byte appended)`, raw(resized(1)), "has length")
  }
  expectPass("zero padding after a type-0 terminator is accepted (raw)", raw(Buffer.concat([good, Buffer.alloc(8)])))
  expectFail("non-zero byte after a type-0 terminator", raw(Buffer.concat([good, Buffer.from([0, 0, 0, 0, 0, 1])])), "non-zero bytes after the TLV terminator")
  expectFail("non-zero padding right after the terminator header", raw(Buffer.concat([good, Buffer.from([0, 0, 5, 0])])), "non-zero bytes after the TLV terminator")
  expectFail("1–3 trailing bytes after the last extension", raw(Buffer.concat([good, Buffer.from([1, 2])])), "trailing bytes")
  expectFail("bytes after the token metadata's empty additional list", raw(rebuild(goodEntries.map(([t, v]) => [t, t === 19 ? Buffer.concat([v, Buffer.from([7])]) : v]))), "TokenMetadata")
  const used = encode({ supply: BigInt(500) })
  const afterUse = { ...expected, supply: BigInt(500) }
  expectPass("verifier after use: supply equal to the program's total minted passes", [...checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, used, afterUse), ...checkQlcMint(getMintDecoder().decode(used), afterUse)])
  expectFail("verifier after use: supply differs from the program's total minted", [...checkMintTlv(TOKEN_2022_PROGRAM_ADDRESS, used, { ...expected, supply: BigInt(400) }), ...checkQlcMint(getMintDecoder().decode(used), { ...expected, supply: BigInt(400) })], "supply")

  console.log("— mint transaction (TX1): signers, authorities, instructions")
  const payer = createNoopSigner(address(PAYER))
  const mintSigner = createNoopSigner(mint)
  const { space, finalSize } = mintSizes(admin, mint, noBurnAuthority)
  check("mint size: 516 bytes after metadata with the Devnet uri (equals the devnet simulation)", finalSize === 516 && space < finalSize, `space ${space}, final ${finalSize}`)
  const ixs = createMintInstructions({ payer, mint: mintSigner, admin, mintAuthority, freezeAuthority, noBurnAuthority, lamports: BigInt(3_230_880), space })
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: BigInt(0) }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  )
  const signers = Object.keys(compileTransaction(message).signatures)
  check("TX1 signers are exactly the payer (fee payer) and the mint identity", signers.length === 2 && signers[0] === PAYER && signers.includes(mint), signers.join(", "))
  check("TX1 never needs the Ledger admin's signature", !signers.includes(admin))
  check("TX1 uses only the System and Token-2022 programs", ixs.every((ix) => ix.programAddress === SYSTEM || ix.programAddress === TOKEN_2022_PROGRAM_ADDRESS))
  const kinds = ixs.map((ix) => (ix.programAddress === SYSTEM ? "createAccount" : Buffer.from(ix.data ?? []).subarray(0, ix.data?.[0] === INITIALIZE_TOKEN_METADATA_DISCRIMINATOR[0] ? 8 : 1).toString("hex")))
  const tag = (value: number) => Buffer.from([value]).toString("hex")
  const order = [
    "createAccount",
    tag(INITIALIZE_METADATA_POINTER_DISCRIMINATOR),
    tag(INITIALIZE_DEFAULT_ACCOUNT_STATE_DISCRIMINATOR),
    tag(INITIALIZE_PERMISSIONED_BURN_DISCRIMINATOR),
    tag(INITIALIZE_PAUSABLE_CONFIG_DISCRIMINATOR),
    tag(INITIALIZE_TRANSFER_HOOK_DISCRIMINATOR),
    tag(INITIALIZE_MINT2_DISCRIMINATOR),
    Buffer.from(INITIALIZE_TOKEN_METADATA_DISCRIMINATOR).toString("hex"),
    tag(SET_AUTHORITY_DISCRIMINATOR),
  ]
  check("TX1 instruction order: create, 5 extension inits, InitializeMint2, TokenMetadata, SetAuthority", JSON.stringify(kinds) === JSON.stringify(order), JSON.stringify(kinds))
  const mint2 = Buffer.from(ixs[6].data ?? [])
  check("InitializeMint2: decimals 2, transient mint authority = mint identity, freeze authority = program membership PDA", mint2[1] === 2 && mint2.subarray(2, 34).equals(Buffer.from(encodeAddress(mint))) && mint2[34] === 1 && mint2.subarray(35, 67).equals(Buffer.from(encodeAddress(freezeAuthority))))
  const setAuthority = Buffer.from(ixs[8].data ?? [])
  check("last instruction hands the mint authority (type 0) to the program mint-authority PDA", setAuthority[1] === 0 && setAuthority[2] === 1 && setAuthority.subarray(3, 35).equals(Buffer.from(encodeAddress(mintAuthority))))
  const source = readFileSync(join(ROOT, "scripts/qlc-setup.ts"), "utf8")
  check("setup source never generates a keypair", !/generateKeyPair/.test(source))
  check(
    "devnet owner-execution gate open (reviewed Task 09I: TX2 signer 09A, Phantom TX1 path 09H, live metadata, funded admin)",
    DEVNET_INITIALIZE_SIGNING_APPROVED === true,
  )

  console.log("— owner-approved inputs and payer separation")
  const inputs: SetupInputs = { cluster: "devnet", mint, admin, operator: address(DEVNET_SETUP.operator), payer: address(PAYER), limits: { ...DEVNET_LIMITS } }
  expectPass("devnet: locked mint, Ledger admin, operator, limits and the approved TX1 payer C7pk…", inputChecks(inputs, admin))
  expectFail("Deploy_CLI_Signer_DEV GJPD… as TX1 payer (not the approved payer)", inputChecks({ ...inputs, payer: address(DEPLOY_CLI_SIGNER) }, admin), "owner-approved TX1 setup payer")
  expectFail("Deploy_CLI_Signer_DEV GJPD… as payer on localnet too (reserved role)", inputChecks({ ...inputs, cluster: "localnet", payer: address(DEPLOY_CLI_SIGNER) }, admin), "deploy CLI signer")
  expectFail("any other devnet payer", inputChecks({ ...inputs, payer: OTHER }, admin), "owner-approved TX1 setup payer")
  expectFail("a different mint address (second mint)", inputChecks({ ...inputs, mint: OTHER }, admin), "owner mint identity")
  expectFail("admin is not the on-chain upgrade authority", inputChecks(inputs, OTHER), "upgrade authority")
  expectFail("another operator", inputChecks({ ...inputs, operator: OTHER }, admin), "operator")
  for (const [role, value] of [
    ["the Ledger admin", DEVNET_SETUP.admin],
    ["the mint identity", DEVNET_SETUP.mint],
    ["the operator", DEVNET_SETUP.operator],
    ["the treasury wallet", "AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw"],
    ["the owner wallet", "4M9QBi82P75sBUE7yEyDQHSRDreP1s2GnPaQGwazbqqm"],
  ] as const) {
    expectFail(`payer = ${role}`, inputChecks({ ...inputs, payer: address(value) }, admin), "payer")
  }
  expectFail("stale default max charge 50000 (500.00 QLC)", inputChecks({ ...inputs, limits: { ...DEVNET_LIMITS, maxChargeAmount: BigInt(50_000) } }, admin), "owner-approved values")
  expectFail("limit not a multiple of 0.05 QLC", inputChecks({ ...inputs, limits: { ...DEVNET_LIMITS, maxChargeAmount: BigInt(10_001) } }, admin), "multiples of 0.05")
  expectFail("mint window outside 60 s … 30 days", inputChecks({ ...inputs, limits: { ...DEVNET_LIMITS, mintWindowSecs: BigInt(30) } }, admin), "window")
  expectFail("operator = admin (roles not distinct)", inputChecks({ ...inputs, cluster: "localnet", operator: admin }, admin), "distinct")
  REJECTED_ID_HASHES.add(sha256(PAYER))
  expectFail("rejected identity", inputChecks(inputs, admin), "rejected")
  REJECTED_ID_HASHES.delete(sha256(PAYER))

  console.log("— strict arguments")
  const parsed = parseArgs(["create-mint", "--cluster", "devnet", "--payer", PAYER, "--execute"])
  check("create-mint command, values and --execute parsed", parsed.command === "create-mint" && parsed.execute && parsed.values["--payer"] === PAYER && parsed.errors.length === 0)
  check("no command → read-only plan", parseArgs(["--cluster", "devnet", "--payer", PAYER]).command === "plan" && !parseArgs(["--cluster", "devnet", "--payer", PAYER]).execute)
  check("unknown flag refused (e.g. --keypair, --url)", parseArgs(["--cluster", "devnet", "--keypair", "x"]).errors.some((e) => e.includes("unknown")))
  check("flag without a value refused", parseArgs(["--cluster", "--payer", PAYER]).errors.some((e) => e.includes("no value")))
  check("repeated flag refused", parseArgs(["--payer", PAYER, "--payer", PAYER]).errors.some((e) => e.includes("more than once")))

  console.log("— verifier: strict arguments")
  const verifyArgs = parseVerifyArgs(["--cluster", "devnet", "--member", PAYER, "--member", DEPLOY_CLI_SIGNER])
  check("verifier: --cluster and repeatable --member parsed", verifyArgs.errors.length === 0 && verifyArgs.values["--cluster"] === "devnet" && verifyArgs.members.length === 2)
  for (const [name, argv, fragment] of [
    ["unknown flag", ["--cluster", "devnet", "--url", "x"], "unknown argument"],
    ["repeated singleton flag", ["--cluster", "devnet", "--cluster", "localnet"], "more than once"],
    ["repeated --mint", ["--cluster", "localnet", "--mint", PAYER, "--mint", PAYER], "more than once"],
    ["missing value", ["--cluster", "devnet", "--member"], "no value"],
    ["flag as value", ["--cluster", "--admin", PAYER], "no value"],
    ["no cluster", [], "--cluster must be"],
    ["mainnet cluster", ["--cluster", "mainnet-beta"], "--cluster must be"],
  ] as const) {
    const parsedVerify = parseVerifyArgs([...argv])
    check(`verifier refuses: ${name}`, parsedVerify.errors.some((e) => e.includes(fragment)), parsedVerify.errors.join("; "))
  }

  console.log("— verifier: accounting invariant (supply, Program Vault, config totals)")
  const n = (v: number) => BigInt(v)
  const state = (o: Partial<Record<"supply" | "vault" | "totalMinted" | "totalDelivered" | "totalCharged" | "totalRefunded", number>>) => ({
    supply: n(o.supply ?? 0),
    vault: n(o.vault ?? 0),
    totalMinted: n(o.totalMinted ?? 0),
    totalDelivered: n(o.totalDelivered ?? 0),
    totalCharged: n(o.totalCharged ?? 0),
    totalRefunded: n(o.totalRefunded ?? 0),
  })
  // Program semantics, step by step from initialize: deliver 1000 (all minted), charge 300, refund 100, deliver 150
  // (vault holds 200 → 150 from the vault, 0 minted), deliver 100 (50 from the vault, 50 minted).
  const steps = [
    ["after initialize", state({})],
    ["deliver 1000 (minted)", state({ supply: 1000, totalMinted: 1000, totalDelivered: 1000 })],
    ["charge 300 (to the vault)", state({ supply: 1000, vault: 300, totalMinted: 1000, totalDelivered: 1000, totalCharged: 300 })],
    ["refund 100 (from the vault)", state({ supply: 1000, vault: 200, totalMinted: 1000, totalDelivered: 1000, totalCharged: 300, totalRefunded: 100 })],
    ["deliver 150 (from the vault)", state({ supply: 1000, vault: 50, totalMinted: 1000, totalDelivered: 1150, totalCharged: 300, totalRefunded: 100 })],
    ["deliver 100 (50 vault + 50 minted)", state({ supply: 1050, vault: 0, totalMinted: 1050, totalDelivered: 1250, totalCharged: 300, totalRefunded: 100 })],
    ["direct transfer of 25 into the vault outside the program (X = 25)", state({ supply: 1050, vault: 25, totalMinted: 1050, totalDelivered: 1250, totalCharged: 300, totalRefunded: 100 })],
  ] as const
  for (const [name, s] of steps) expectPass(`accounting holds: ${name}`, accountingChecks(s))
  check("accounting reports X = direct inflows", accountingChecks(steps[6][1])[3].detail?.includes("X = 25") === true, accountingChecks(steps[6][1])[3].detail)
  const base = steps[5][1]
  expectFail("supply ≠ totalMinted (unaccounted mint)", accountingChecks({ ...base, supply: base.supply + n(5) }), "mint supply")
  expectFail("vault below the accounted inventory (QLC left the vault unaccounted)", accountingChecks({ ...base, vault: base.vault, totalCharged: base.totalCharged + n(5) }), "X (direct inflows outside the program) ≥ 0")
  expectFail("inflated totalRefunded", accountingChecks({ ...steps[3][1], totalRefunded: n(400) }), "totalRefunded ≤ totalCharged")
  expectFail("totalMinted above totalDelivered", accountingChecks({ ...base, supply: n(2000), totalMinted: n(2000) }), "totalMinted ≤ totalDelivered")

  console.log("— resume / recovery state machine (no second mint)")
  const stage = (mintAccount: { owner: string } | null, mintValid: boolean, configMint: string | null) => setupStage({ mintAccount, mintValid, configMint, mint })
  check("mint address unused → create the mint", stage(null, false, null).stage === "create-mint")
  check("mint created, program not initialized → initialize only (rerun never recreates the mint)", stage({ owner: TOKEN_2022_PROGRAM_ADDRESS }, true, null).stage === "initialize")
  check("mint exists but fails the policy → stop for an owner decision", stage({ owner: TOKEN_2022_PROGRAM_ADDRESS }, false, null).stage === "stop")
  check("mint address used by a non-token account → stop", stage({ owner: SYSTEM }, false, null).stage === "stop")
  check("program initialized with this mint → verify only", stage({ owner: TOKEN_2022_PROGRAM_ADDRESS }, true, mint).stage === "initialized")
  check("program initialized with another mint → stop", stage({ owner: TOKEN_2022_PROGRAM_ADDRESS }, true, OTHER).stage === "stop")

  console.log("— metadata URL checks")
  const local = readFileSync(join(ROOT, "public/qlc.json"), "utf8")
  expectPass("repository public/qlc.json carries the locked name, symbol and image URL", metadataJsonChecks(local))
  expectFail("wrong symbol", metadataJsonChecks(JSON.stringify({ ...JSON.parse(local), symbol: "QLX" })), "metadata")
  expectFail("not JSON", metadataJsonChecks("<html>"), "metadata")
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
  const site = (overrides: Record<string, { status: number; contentType: string; body: Buffer }>) => async (url: string) => {
    if (overrides[url]) return overrides[url]
    if (url === QLC_METADATA.uri) return { status: 200, contentType: "application/json", body: Buffer.from(local) }
    return { status: 200, contentType: "image/png", body: png }
  }
  expectPass("live site serving both files passes", await metadataUrlChecks(site({})))
  expectFail("qlc.json 404", await metadataUrlChecks(site({ [QLC_METADATA.uri]: { status: 404, contentType: "text/plain", body: Buffer.from("Not Found") } })), "served")
  expectFail("qlc.png 404", await metadataUrlChecks(site({ [QLC_METADATA.image]: { status: 404, contentType: "text/plain", body: Buffer.from("Not Found") } })), "qlc.png")
  expectFail("image is not a PNG", await metadataUrlChecks(site({ [QLC_METADATA.image]: { status: 200, contentType: "image/png", body: Buffer.from("GIF89a....") } })), "qlc.png")
  expectFail("network error", await metadataUrlChecks(async () => { throw new Error("offline") }), "served")

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll QLC setup checks passed")
  process.exit(failures ? 1 : 0)
}

const encodeAddress = (value: Address) => getAddressEncoder().encode(value)

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
