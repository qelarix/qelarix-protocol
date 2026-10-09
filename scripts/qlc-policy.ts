// The approved QLC on-chain setup policy (QLC Source of Truth + Task 08 owner inputs) as named, fail-closed
// checks. Shared by the setup script (before the irreversible mint), the read-only verifier (after it) and the
// offline checks, so all of them judge against exactly the same expectations. Keyless.
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, unwrapOption, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit"
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, type Extension, type Mint } from "@solana-program/token-2022"
import { QELARIX_QLC_PROGRAM_ADDRESS } from "../src/lib/qlc/generated"
import { QLC_DECIMALS, SYSTEM_PROGRAM_ADDRESS, isQlcStep } from "../src/lib/qlc/qlcProgram"
import { REJECTED_ID_HASHES, sha256, type Check } from "./qlc-build-preflight"
import { DEPLOY_IDENTITIES } from "./qlc-deploy-preflight"

export const CLUSTERS = {
  localnet: { http: "http://127.0.0.1:8899", ws: "ws://127.0.0.1:8900", genesis: null },
  devnet: { http: "https://api.devnet.solana.com", ws: "wss://api.devnet.solana.com", genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
} as const
export type ClusterName = keyof typeof CLUSTERS
// devnet, mainnet-beta, testnet: a "localnet" RPC must not be any of them.
const KNOWN_PUBLIC_GENESIS = ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"]
const BPF_LOADER_UPGRADEABLE = address("BPFLoaderUpgradeab1e11111111111111111111111")

/** Owner-approved devnet identities (public addresses only). */
export const DEVNET_SETUP = {
  /** Task 08: the owner's dedicated offline mint identity. The setup never creates another mint. */
  mint: "7CLTFoNMNY8otRNA9zU7G84VPwxCCP4rWVvsZj2vp1Tk",
  /** Ledger: program upgrade authority, config admin, pause / transfer-hook / metadata authority. */
  admin: DEPLOY_IDENTITIES.upgradeAuthority,
  /** Low-privilege relayer named in the program config. */
  operator: "4GEGAVHQCwshpv3yC25Xs7ACmWvNpcjTneT56XVD8McL",
  /** Owner-approved TX1 setup payer (Deploy_Fee_Payer): pays the TX1 fee and the mint-account rent only. */
  payer: "C7pkmggd8mNoc1n9XitK6QP4HzdVGGhFTUrbUfFmo7Hp",
} as const

/** Roles that may never pay for the setup (Wallet Architecture: permanent role separation). */
export const RESERVED_ROLES: Record<string, string> = {
  [DEVNET_SETUP.mint]: "QLC mint identity",
  [DEVNET_SETUP.admin]: "program upgrade authority / admin (Ledger)",
  [DEVNET_SETUP.operator]: "operator / relayer",
  AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw: "QLC treasury wallet",
  "4M9QBi82P75sBUE7yEyDQHSRDreP1s2GnPaQGwazbqqm": "owner wallet",
  GJPDitCMWnH3bPYFUJRWwyXdXmErBhwrS5EoYz6JZwmz: "deploy CLI signer (program deploys only; not the TX1 payer)",
  [QELARIX_QLC_PROGRAM_ADDRESS]: "QLC program",
}

/** Devnet limits approved by the owner (2026-10-03; max charge raised to 1,200.00 by G3 on 2026-10-09), in QLC base units: 10,000.00 / 1,200.00 / 24 h / 20,000.00. */
export const DEVNET_LIMITS = { maxDeliveryAmount: BigInt(1_000_000), maxChargeAmount: BigInt(120_000), mintWindowSecs: BigInt(86_400), mintWindowCap: BigInt(2_000_000) }
export type Limits = typeof DEVNET_LIMITS
// solana/programs/qelarix-qlc/src/constants.rs
export const MIN_MINT_WINDOW_SECS = BigInt(60)
export const MAX_MINT_WINDOW_SECS = BigInt(30 * 24 * 60 * 60)
/**
 * Locked metadata identity (Task 08). The mint stores name/symbol/uri; the JSON at the uri names the image.
 * Devnet host (owner lock, Task 09D): qelarix.vercel.app, the live Qelarix platform, until a separate reviewed
 * final-domain cutover after the Devnet phase.
 */
export const QLC_METADATA = { name: "Qelarix Credit", symbol: "QLC", uri: "https://qelarix.vercel.app/qlc.json", image: "https://qelarix.vercel.app/qlc.png" } as const

const isRejected = (value: string) => REJECTED_ID_HASHES.has(sha256(value))

/** Refuses any RPC whose genesis does not belong to the named cluster (mainnet is never accepted). */
export async function assertCluster(rpc: Rpc<SolanaRpcApi>, name: ClusterName): Promise<string> {
  const expected = CLUSTERS[name].genesis
  const genesis = await rpc.getGenesisHash().send()
  if (expected ? genesis !== expected : KNOWN_PUBLIC_GENESIS.includes(genesis)) {
    throw new Error(`RPC genesis ${genesis} does not match --cluster ${name}`)
  }
  return genesis
}

/** The QLC program's ProgramData address and current upgrade authority (null = not deployed or immutable). */
export async function readUpgradeAuthority(rpc: Rpc<SolanaRpcApi>): Promise<{ programData: Address; deployed: boolean; upgradeAuthority: Address | null }> {
  const [programData] = await getProgramDerivedAddress({ programAddress: BPF_LOADER_UPGRADEABLE, seeds: [getAddressEncoder().encode(QELARIX_QLC_PROGRAM_ADDRESS)] })
  const account = await rpc.getAccountInfo(programData, { encoding: "base64", dataSlice: { offset: 0, length: 45 } }).send()
  if (!account.value) return { programData, deployed: false, upgradeAuthority: null }
  const bytes = Buffer.from(account.value.data[0], "base64")
  return { programData, deployed: true, upgradeAuthority: bytes[12] === 1 ? getAddressDecoder().decode(bytes.subarray(13, 45)) : null }
}

export interface QlcMintExpectation {
  mint: Address
  /** Pause, transfer-hook, metadata-pointer and metadata update authority. */
  admin: Address
  /** Program-derived authorities: mint authority and freeze (membership) authority. */
  mintAuthority: Address
  freezeAuthority: Address
  noBurnAuthority: Address
  name: string
  symbol: string
  uri: string
  /** Expected supply: 0 before and right after setup; the program's total minted afterwards. */
  supply?: bigint
}

// Exactly these, each once. Everything else (PermanentDelegate, TransferFee, NonTransferable,
// ConfidentialTransfer, InterestBearing, ScaledUiAmount, MintCloseAuthority, ...) is forbidden.
const QLC_EXTENSIONS = ["DefaultAccountState", "PermissionedBurn", "PausableConfig", "TransferHook", "MetadataPointer", "TokenMetadata"] as const

type ExtensionOf<K extends Extension["__kind"]> = Extract<Extension, { __kind: K }>

/** The decoded mint (@solana-program/token-2022) against the policy. */
export function checkQlcMint(mint: Mint, expected: QlcMintExpectation): Check[] {
  const extensions = unwrapOption(mint.extensions) ?? []
  const find = <K extends Extension["__kind"]>(kind: K) => extensions.find((e): e is ExtensionOf<K> => e.__kind === kind)
  const kinds = extensions.map((e) => e.__kind)
  const defaultState = find("DefaultAccountState")
  const burn = find("PermissionedBurn")
  const pausable = find("PausableConfig")
  const hook = find("TransferHook")
  const pointer = find("MetadataPointer")
  const metadata = find("TokenMetadata")
  const mintAuthority = unwrapOption(mint.mintAuthority)
  const freezeAuthority = unwrapOption(mint.freezeAuthority)
  return [
    { name: "mint: initialized, decimals = 2", ok: mint.isInitialized && mint.decimals === QLC_DECIMALS, detail: String(mint.decimals) },
    { name: `mint: supply = ${expected.supply ?? BigInt(0)}`, ok: mint.supply === (expected.supply ?? BigInt(0)), detail: mint.supply.toString() },
    { name: "mint: mint authority = program (mint-authority PDA)", ok: mintAuthority === expected.mintAuthority, detail: String(mintAuthority) },
    { name: "mint: freeze authority = program (membership PDA)", ok: freezeAuthority === expected.freezeAuthority, detail: String(freezeAuthority) },
    {
      name: "mint: exactly the approved extensions, each once (no PermanentDelegate, TransferFee, NonTransferable, ConfidentialTransfer, InterestBearing, ScaledUiAmount, MintCloseAuthority, Group*)",
      ok: kinds.length === QLC_EXTENSIONS.length && QLC_EXTENSIONS.every((kind) => kinds.filter((k) => k === kind).length === 1),
      detail: kinds.join(", "),
    },
    { name: "mint: DefaultAccountState = Frozen (new accounts start frozen)", ok: defaultState?.state === AccountState.Frozen },
    {
      name: "mint: PermissionedBurn authority = no-burn address (burning impossible for everyone)",
      ok: burn !== undefined && unwrapOption(burn.authority) === expected.noBurnAuthority,
      detail: String(burn && unwrapOption(burn.authority)),
    },
    { name: "mint: Pausable authority = admin, not paused", ok: pausable !== undefined && unwrapOption(pausable.authority) === expected.admin && !pausable.paused },
    { name: "mint: TransferHook reserved and inactive (authority = admin, no hook program)", ok: hook !== undefined && hook.authority === expected.admin && hook.programId === SYSTEM_PROGRAM_ADDRESS },
    {
      name: "mint: MetadataPointer = the mint itself, authority = admin",
      ok: pointer !== undefined && unwrapOption(pointer.metadataAddress) === expected.mint && unwrapOption(pointer.authority) === expected.admin,
    },
    {
      name: "mint: TokenMetadata name / symbol / uri, update authority = admin, no additional fields",
      ok:
        metadata !== undefined &&
        metadata.mint === expected.mint &&
        unwrapOption(metadata.updateAuthority) === expected.admin &&
        metadata.name === expected.name &&
        metadata.symbol === expected.symbol &&
        metadata.uri === expected.uri &&
        metadata.additionalMetadata.size === 0,
      detail: metadata ? `${metadata.name} / ${metadata.symbol} / ${metadata.uri}` : "missing",
    },
  ]
}

// Token-2022 extension type numbers (spl-token-2022 ExtensionType); the program's mint_policy.rs uses the same.
const EXT = { defaultAccountState: 6, transferHook: 14, metadataPointer: 18, tokenMetadata: 19, pausable: 26, permissionedBurn: 28 }
// Canonical value lengths of the fixed-size extensions (Token-2022 Pod layouts): DefaultAccountState u8; PermissionedBurn
// OptionalNonZeroPubkey; Pausable authority + bool; TransferHook authority + program; MetadataPointer authority + address.
const FIXED_LENGTH: Record<number, number> = { 6: 1, 28: 32, 26: 33, 14: 64, 18: 64 }
const EXT_NAMES: Record<number, string> = {
  1: "TransferFeeConfig", 3: "MintCloseAuthority", 4: "ConfidentialTransferMint", 6: "DefaultAccountState", 9: "NonTransferable",
  10: "InterestBearingConfig", 12: "PermanentDelegate", 14: "TransferHook", 16: "ConfidentialTransferFee", 18: "MetadataPointer",
  19: "TokenMetadata", 20: "GroupPointer", 21: "TokenGroup", 22: "GroupMemberPointer", 23: "TokenGroupMember",
  24: "ConfidentialMintBurn", 25: "ScaledUiAmountConfig", 26: "PausableConfig", 28: "PermissionedBurn",
}
const MINT_BASE = 82
const ACCOUNT_TYPE_OFFSET = 165
const EXTENSIONS_START = 166

/**
 * The raw account bytes against the policy, independent of any decoder library: a Token-2022 mint account
 * whose TLV area holds exactly the six approved extensions (the same rule as the program's
 * `verify_mint_extensions`, plus the authority values the program leaves to the setup). Same strictness as the
 * Rust signer's checker (tools/qlc-tx2-signer/src/policy.rs): canonical fixed extension lengths, only zero padding
 * after a type-0 terminator, no trailing bytes, nothing after the token metadata.
 */
export function checkMintTlv(owner: string, data: Buffer, expected: QlcMintExpectation): Check[] {
  const key = (bytes: Buffer, offset: number) => (bytes.length >= offset + 32 ? getAddressDecoder().decode(bytes.subarray(offset, offset + 32)) : null)
  const zero = SYSTEM_PROGRAM_ADDRESS
  const isMint = data.length > EXTENSIONS_START && data[ACCOUNT_TYPE_OFFSET] === 1
  const checks: Check[] = [
    { name: "raw: owned by Token-2022", ok: owner === TOKEN_2022_PROGRAM_ADDRESS, detail: owner },
    { name: "raw: mint account type, extension area present", ok: isMint, detail: `${data.length} bytes` },
  ]
  if (!isMint) return checks
  const mintAuthority = data.readUInt32LE(0) === 1 ? key(data, 4) : null
  const freezeAuthority = data.readUInt32LE(46) === 1 ? key(data, 50) : null
  checks.push(
    {
      name: `raw: base mint (initialized, decimals 2, supply ${expected.supply ?? BigInt(0)}, PDA mint and freeze authorities, zero padding)`,
      ok:
        data[45] === 1 &&
        data[44] === QLC_DECIMALS &&
        data.readBigUInt64LE(36) === (expected.supply ?? BigInt(0)) &&
        mintAuthority === expected.mintAuthority &&
        freezeAuthority === expected.freezeAuthority &&
        data.subarray(MINT_BASE, ACCOUNT_TYPE_OFFSET).every((b) => b === 0),
      detail: `decimals ${data[44]}, supply ${data.readBigUInt64LE(36)}, mint authority ${mintAuthority}, freeze authority ${freezeAuthority}`,
    },
  )
  const seen: number[] = []
  const problems: string[] = []
  let offset = EXTENSIONS_START
  let terminated = false
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset)
    const length = data.readUInt16LE(offset + 2)
    if (type === 0) {
      // Everything after a terminator must be zero padding.
      if (data.subarray(offset).some((b) => b !== 0)) problems.push("non-zero bytes after the TLV terminator")
      terminated = true
      break
    }
    const value = data.subarray(offset + 4, offset + 4 + length)
    if (value.length !== length) {
      problems.push(`truncated ${EXT_NAMES[type] ?? type}`)
      terminated = true
      break
    }
    seen.push(type)
    if (FIXED_LENGTH[type] !== undefined && length !== FIXED_LENGTH[type]) {
      problems.push(`${EXT_NAMES[type]} has length ${length} (canonical ${FIXED_LENGTH[type]})`)
      offset += 4 + length
      continue
    }
    switch (type) {
      case EXT.defaultAccountState:
        if (value[0] !== 2) problems.push("DefaultAccountState is not Frozen")
        break
      case EXT.permissionedBurn:
        if (key(value, 0) !== expected.noBurnAuthority) problems.push("PermissionedBurn authority is not the no-burn address")
        break
      case EXT.pausable:
        if (key(value, 0) !== expected.admin || value[32] !== 0) problems.push("Pausable authority is not the admin, or the mint is paused")
        break
      case EXT.transferHook:
        if (key(value, 0) !== expected.admin || key(value, 32) !== zero) problems.push("TransferHook authority is not the admin, or a hook program is set")
        break
      case EXT.metadataPointer:
        if (key(value, 0) !== expected.admin || key(value, 32) !== expected.mint) problems.push("MetadataPointer does not point at the mint under the admin")
        break
      case EXT.tokenMetadata: {
        const metadata = parseTokenMetadata(value)
        if (
          !metadata ||
          metadata.updateAuthority !== expected.admin ||
          metadata.mint !== expected.mint ||
          metadata.name !== expected.name ||
          metadata.symbol !== expected.symbol ||
          metadata.uri !== expected.uri ||
          metadata.additional !== 0
        ) {
          problems.push("TokenMetadata does not match")
        }
        break
      }
      default:
        problems.push(`forbidden extension ${EXT_NAMES[type] ?? `type ${type}`}`)
    }
    offset += 4 + length
  }
  if (!terminated && offset !== data.length) problems.push("trailing bytes after the last extension")
  const required = Object.values(EXT)
  const missing = required.filter((type) => !seen.includes(type)).map((type) => EXT_NAMES[type])
  const duplicate = seen.filter((type, i) => seen.indexOf(type) !== i).map((type) => EXT_NAMES[type] ?? type)
  checks.push({
    name: "raw: TLV holds exactly DefaultAccountState(Frozen), PermissionedBurn(no-burn), Pausable(admin, unpaused), TransferHook(admin, none), MetadataPointer(mint), TokenMetadata",
    ok: problems.length === 0 && missing.length === 0 && duplicate.length === 0,
    detail: [...problems, ...missing.map((m) => `missing ${m}`), ...duplicate.map((d) => `duplicate ${d}`)].join("; ") || seen.map((t) => EXT_NAMES[t]).join(", "),
  })
  return checks
}

/** spl-token-metadata-interface TokenMetadata: update authority, mint, name, symbol, uri, additional metadata. */
function parseTokenMetadata(value: Buffer): { updateAuthority: string; mint: string; name: string; symbol: string; uri: string; additional: number } | null {
  try {
    let offset = 64
    const text = () => {
      const length = value.readUInt32LE(offset)
      const out = value.subarray(offset + 4, offset + 4 + length)
      if (out.length !== length) throw new Error("truncated")
      offset += 4 + length
      return out.toString("utf8")
    }
    const name = text()
    const symbol = text()
    const uri = text()
    const additional = value.readUInt32LE(offset)
    // Nothing may follow the (empty) additional-metadata list.
    if (additional === 0 && value.length !== offset + 4) return null
    return {
      updateAuthority: getAddressDecoder().decode(value.subarray(0, 32)),
      mint: getAddressDecoder().decode(value.subarray(32, 64)),
      name,
      symbol,
      uri,
      additional,
    }
  } catch {
    return null
  }
}

export interface Accounting {
  /** Authoritative mint supply (base units). */
  supply: bigint
  /** Program Vault token balance. */
  vault: bigint
  totalMinted: bigint
  totalDelivered: bigint
  totalCharged: bigint
  totalRefunded: bigint
}

/**
 * The QLC accounting invariant, derived from the program (solana/programs/qelarix-qlc/src/instructions):
 *   initialize: supply 0 (checked), vault created empty, every total 0.
 *   deliver(amount): from_vault = min(vault, amount) moves vault → member; minted = amount − from_vault is minted to
 *     the member; totalMinted += minted; totalDelivered += amount.
 *   charge(amount): member → vault; totalCharged += amount.     refund: vault → member; totalRefunded += receipt amount.
 *   Nothing else mints, moves vault QLC or changes these totals; burning is impossible (PermissionedBurn = no-burn);
 *   the mint authority is the program PDA; the vault's owner is the vault-authority PDA (no delegate, no close
 *   authority), and a member token account can never be the vault (members sign registration; a PDA cannot).
 * Hence, by induction over instructions:
 *   supply = totalMinted
 *   vault  = totalMinted + totalCharged − totalDelivered − totalRefunded + X
 * where X ≥ 0 is QLC transferred into the (thawed) vault outside the program, which only ever adds inventory.
 * Also totalMinted ≤ totalDelivered (minted ≤ amount per delivery) and totalRefunded ≤ totalCharged (each charge
 * receipt is refunded at most once, for its own amount).
 */
export function accountingChecks(a: Accounting): Check[] {
  const unaccounted = a.vault + a.totalDelivered + a.totalRefunded - a.totalMinted - a.totalCharged
  return [
    { name: "accounting: mint supply = config.totalMinted (no burn, program-only minting)", ok: a.supply === a.totalMinted, detail: `${a.supply} / ${a.totalMinted}` },
    { name: "accounting: totalMinted ≤ totalDelivered", ok: a.totalMinted <= a.totalDelivered, detail: `${a.totalMinted} ≤ ${a.totalDelivered}` },
    { name: "accounting: totalRefunded ≤ totalCharged", ok: a.totalRefunded <= a.totalCharged, detail: `${a.totalRefunded} ≤ ${a.totalCharged}` },
    {
      name: "accounting: vault = totalMinted + totalCharged − totalDelivered − totalRefunded + X, with X (direct inflows outside the program) ≥ 0",
      ok: unaccounted >= BigInt(0),
      detail: `vault ${a.vault}; X = ${unaccounted}${unaccounted > BigInt(0) ? " (QLC sent to the vault outside the program)" : ""}`,
    },
  ]
}

/** Limits the program accepts (validate_limits) and the owner approved. */
export function limitChecks(limits: Limits, cluster: ClusterName): Check[] {
  const stepped = [limits.maxDeliveryAmount, limits.maxChargeAmount, limits.mintWindowCap].every((value) => isQlcStep(value))
  const window = limits.mintWindowSecs >= MIN_MINT_WINDOW_SECS && limits.mintWindowSecs <= MAX_MINT_WINDOW_SECS
  const approved = (Object.keys(DEVNET_LIMITS) as (keyof Limits)[]).every((key) => limits[key] === DEVNET_LIMITS[key])
  return [
    { name: "limits: amounts are positive multiples of 0.05 QLC; window within 60 s … 30 days", ok: stepped && window },
    {
      name: "limits: devnet uses the owner-approved values (10,000.00 per delivery, 100.00 per charge, 20,000.00 per 24 h)",
      ok: cluster !== "devnet" || approved,
      detail: Object.entries(limits).map(([k, v]) => `${k} ${v}`).join(", "),
    },
  ]
}

/** The setup payer funds the mint account and fees; it must never be an authority or another Qelarix role. */
export function payerChecks(payer: string): Check[] {
  return [
    {
      name: "payer: explicit, not an authority or another Qelarix role, not rejected",
      ok: payer.length > 0 && !RESERVED_ROLES[payer] && !isRejected(payer),
      detail: !payer ? "missing" : RESERVED_ROLES[payer] ? `${payer} is the ${RESERVED_ROLES[payer]}` : isRejected(payer) ? "REJECTED identity" : payer,
    },
  ]
}

export type SetupStage = "create-mint" | "initialize" | "initialized" | "stop"

/**
 * What the next step is, from the on-chain state, never creating a second mint:
 * mint absent → create it; mint valid and program uninitialized → initialize only; program initialized →
 * verify only; anything else (address used by another account, a mint that fails the policy, a config that
 * names another mint) → stop for an owner decision.
 */
export function setupStage(input: { mintAccount: { owner: string } | null; mintValid: boolean; configMint: string | null; mint: string }): { stage: SetupStage; reason: string } {
  const { mintAccount, mintValid, configMint, mint } = input
  if (configMint !== null) {
    return configMint === mint
      ? { stage: "initialized", reason: "program already initialized with this mint: verify only" }
      : { stage: "stop", reason: `program already initialized with another mint ${configMint}` }
  }
  if (!mintAccount) return { stage: "create-mint", reason: "mint address unused: the mint transaction creates it" }
  if (mintAccount.owner !== TOKEN_2022_PROGRAM_ADDRESS) return { stage: "stop", reason: `mint address is in use by an account owned by ${mintAccount.owner}` }
  return mintValid
    ? { stage: "initialize", reason: "mint exists and matches the policy: only the program initialization remains (no second mint)" }
    : { stage: "stop", reason: "a mint exists at this address but fails the policy; it can never be changed (owner decision required)" }
}

/** The metadata JSON served at the uri: the locked identity and the image URL. */
export function metadataJsonChecks(text: string | null): Check[] {
  let json: Record<string, unknown> | null = null
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    json = null
  }
  return [
    {
      name: `metadata: ${QLC_METADATA.uri} is JSON with name "${QLC_METADATA.name}", symbol "${QLC_METADATA.symbol}", image ${QLC_METADATA.image}`,
      ok: json !== null && json.name === QLC_METADATA.name && json.symbol === QLC_METADATA.symbol && json.image === QLC_METADATA.image,
      detail: json ? `${String(json.name)} / ${String(json.symbol)} / ${String(json.image)}` : "not served or not JSON",
    },
  ]
}

type Fetcher = (url: string) => Promise<{ status: number; contentType: string; body: Buffer }>

export const httpFetch: Fetcher = async (url) => {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) })
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", body: Buffer.from(await response.arrayBuffer()) }
}

/** Live, read-only HTTP checks of the metadata JSON and image (required before owner execution readiness). */
export async function metadataUrlChecks(fetcher: Fetcher = httpFetch): Promise<Check[]> {
  const get = async (url: string) => {
    try {
      return await fetcher(url)
    } catch (err) {
      return { status: 0, contentType: "", body: Buffer.alloc(0), error: err instanceof Error ? err.message : String(err) }
    }
  }
  const [json, image] = await Promise.all([get(QLC_METADATA.uri), get(QLC_METADATA.image)])
  const png = image.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return [
    { name: `metadata: ${QLC_METADATA.uri} served (HTTP 200, JSON)`, ok: json.status === 200 && json.contentType.includes("json"), detail: `HTTP ${json.status} ${json.contentType}` },
    ...metadataJsonChecks(json.status === 200 ? json.body.toString("utf8") : null),
    { name: `metadata: ${QLC_METADATA.image} served (HTTP 200, PNG)`, ok: image.status === 200 && image.contentType.includes("image/png") && png, detail: `HTTP ${image.status} ${image.contentType}` },
  ]
}
