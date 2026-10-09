// Independent TypeScript cross-check for the owner-run Ledger TX2 signer (tools/qlc-tx2-signer). Keyless.
//
//   npx tsx scripts/qlc-tx2-check.ts message --file <path>     verify a TX2 message printed by the signer, print its hash
//   npx tsx scripts/qlc-tx2-check.ts fixtures --check          verify the signer's test fixtures (read-only; owner review)
//   npx tsx scripts/qlc-tx2-check.ts selftest                  offline proof of what `message` accepts and refuses
//   npx tsx scripts/qlc-tx2-check.ts runtime-vault --check     read-only devnet simulation: the vault the runtime creates
//
// `fixtures` and `runtime-vault` without --check rewrite fixture files: implementation-time local changes only.
//
// `message` verifies CONTENT only: exactly the reviewed transaction for whatever blockhash it carries. It does not
// prove the blockhash is recent or that the transaction can still land; freshness is the signer's job (it refreshes,
// re-verifies and re-simulates right before the Ledger is asked). The file must hold the message as strict, canonical
// base64 (optionally one trailing newline); anything else is refused, never normalized.
//
// `message` decodes the message with @solana/kit, requires exactly the reviewed QLC initialize instruction
// (built with the Codama client from the locked devnet inputs) with the admin Ledger as the only signer and
// fee payer, and prints base58(SHA-256(message)): the "Message Hash" the Ledger shows in blind-signing mode.
// It is a second implementation, so a compromised or buggy signer cannot silently change what is signed.
//
// Account order: the signer compiles with the Solana SDK (`solana-message`, as the Agave CLI does), which sorts
// each account group by raw 32-byte value; @solana/kit's own compiler sorts by base58 text and would produce
// different (equally valid) bytes. This script therefore re-implements the SDK order and serializes with kit's
// encoder, so both implementations must agree byte for byte.
//
// `fixtures` encodes, with the Codama client and the official Token-2022 encoders, the expected instruction and
// message, the expected post-initialize config and vault accounts, and the approved mint plus policy-violating
// variants. The Rust tests compare the signer's independent Rust implementation against them.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compileTransactionMessage,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  some,
  type Address,
  type Blockhash,
} from "@solana/kit"
import {
  AccountState,
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstruction,
  getMintEncoder,
  getTokenEncoder,
  type ExtensionArgs,
} from "@solana-program/token-2022"
import {
  CONFIG_DISCRIMINATOR,
  INITIALIZE_DISCRIMINATOR,
  QELARIX_QLC_PROGRAM_ADDRESS,
  findConfigPda,
  findMembershipAuthorityPda,
  findMintAuthorityPda,
  findSpendAuthorityPda,
  findVaultAuthorityPda,
  getConfigEncoder,
  getInitializeInstructionAsync,
} from "../src/lib/qlc/generated"
import { findNoBurnAuthority } from "../src/lib/qlc/qlcProgram"
import { ROOT } from "./qlc-build-preflight"
import { CLUSTERS, DEVNET_LIMITS, DEVNET_SETUP, QLC_METADATA, assertCluster } from "./qlc-policy"
import { createMintInstructions, mintSizes } from "./qlc-setup"

const FIXTURE = join(ROOT, "tools/qlc-tx2-signer/tests/fixtures/tx2.json")
const RUNTIME_VAULT = join(ROOT, "tools/qlc-tx2-signer/tests/fixtures/vault-runtime.json")
/** Solana's packet limit: no transaction, and so no message, can be larger. */
const MAX_MESSAGE_BYTES = 1232
const SYSTEM = address("11111111111111111111111111111111")
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111")
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
const OTHER = address("Stake11111111111111111111111111111111111111")
const hex = (bytes: ArrayLike<number>) => Buffer.from(Array.from(bytes)).toString("hex")
const messageHash = (bytes: Uint8Array) => getAddressDecoder().decode(createHash("sha256").update(bytes).digest())
// Fixed, recognisable placeholder blockhash for the fixture message: base58(SHA-256("qlc-tx2-fixture")).
const FIXTURE_BLOCKHASH = getAddressDecoder().decode(createHash("sha256").update("qlc-tx2-fixture").digest()) as string as Blockhash

async function expectedInstruction() {
  const admin = createNoopSigner(address(DEVNET_SETUP.admin))
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [getAddressEncoder().encode(QELARIX_QLC_PROGRAM_ADDRESS)] })
  const instruction = await getInitializeInstructionAsync({
    admin,
    qlcMint: address(DEVNET_SETUP.mint),
    programData,
    operator: address(DEVNET_SETUP.operator),
    ...DEVNET_LIMITS,
  })
  return { admin, programData, instruction }
}

/**
 * The legacy message as the Solana SDK compiles it (solana-message `CompiledKeys`): fee payer first, then writable
 * signers, read-only signers, writable non-signers, read-only non-signers, each group in raw 32-byte order.
 */
function compile(admin: ReturnType<typeof createNoopSigner>, instruction: Awaited<ReturnType<typeof expectedInstruction>>["instruction"], blockhash: Blockhash) {
  const metas = new Map<string, { signer: boolean; writable: boolean }>()
  const add = (key: string, signer: boolean, writable: boolean) => {
    const meta = metas.get(key) ?? { signer: false, writable: false }
    metas.set(key, { signer: meta.signer || signer, writable: meta.writable || writable })
  }
  add(admin.address, true, true)
  for (const account of instruction.accounts) add(account.address, account.role >= 2, account.role === 1 || account.role === 3)
  add(instruction.programAddress, false, false)
  const raw = (key: string) => Buffer.from(getAddressEncoder().encode(address(key)))
  const others = Array.from(metas.keys()).filter((key) => key !== admin.address).sort((a, b) => Buffer.compare(raw(a), raw(b)))
  const group = (signer: boolean, writable: boolean) => others.filter((key) => metas.get(key)!.signer === signer && metas.get(key)!.writable === writable)
  const keys = [admin.address, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)].map((key) => address(key))
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode({
      version: "legacy",
      header: {
        numSignerAccounts: 1 + group(true, true).length + group(true, false).length,
        numReadonlySignerAccounts: group(true, false).length,
        numReadonlyNonSignerAccounts: group(false, false).length,
      },
      staticAccounts: keys,
      lifetimeToken: blockhash,
      instructions: [
        {
          programAddressIndex: keys.indexOf(instruction.programAddress),
          accountIndices: instruction.accounts.map((account) => keys.indexOf(account.address)),
          data: instruction.data,
        },
      ],
    }),
  )
}

/**
 * Strict, canonical base64 → bytes. Node's decoder silently skips invalid characters and accepts sloppy padding, so
 * the text is validated first and must re-encode to itself exactly. One trailing newline is tolerated.
 */
export function decodeMessageText(text: string): Uint8Array {
  const b64 = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error("REFUSED: the message file is not strict base64 (only A-Z a-z 0-9 + / and canonical = padding, no spaces, at most one trailing newline)")
  }
  const bytes = Buffer.from(b64, "base64")
  if (bytes.toString("base64") !== b64) throw new Error("REFUSED: the message file is not canonical base64 (it does not re-encode to itself)")
  if (bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES) throw new Error(`REFUSED: message size ${bytes.length} bytes is outside 1 … ${MAX_MESSAGE_BYTES}`)
  return new Uint8Array(bytes)
}

/** Decodes a compiled message; only legacy messages are ever acceptable for TX2. */
function decodeLegacy(bytes: Uint8Array) {
  const decoded = getCompiledTransactionMessageDecoder().decode(bytes)
  if (decoded.version !== "legacy") throw new Error(`REFUSED: message version ${String(decoded.version)} (expected legacy)`)
  return decoded
}

/** Verifies an owner TX2 message independently and returns its Ledger "Message Hash". */
async function checkMessage(bytes: Uint8Array): Promise<string> {
  const decoded = decodeLegacy(bytes)
  const { admin, instruction } = await expectedInstruction()
  const keys = decoded.staticAccounts
  const failures: string[] = []
  if (decoded.header.numSignerAccounts !== 1 || decoded.header.numReadonlySignerAccounts !== 0) failures.push("signers: exactly one writable signer required")
  if (keys[0] !== admin.address) failures.push(`fee payer ${keys[0]} (expected the admin Ledger ${admin.address})`)
  if (decoded.instructions.length !== 1) failures.push(`${decoded.instructions.length} instructions (expected exactly 1)`)
  const ix = decoded.instructions[0]
  if (ix) {
    const isWritable = (i: number) =>
      i < decoded.header.numSignerAccounts - decoded.header.numReadonlySignerAccounts ||
      (i >= decoded.header.numSignerAccounts && i < keys.length - decoded.header.numReadonlyNonSignerAccounts)
    if (keys[ix.programAddressIndex] !== QELARIX_QLC_PROGRAM_ADDRESS) failures.push(`program ${keys[ix.programAddressIndex]}`)
    const actual = (ix.accountIndices ?? []).map((i) => ({ address: keys[i], signer: i < decoded.header.numSignerAccounts, writable: isWritable(i) }))
    const expected = instruction.accounts.map((a) => ({ address: a.address, signer: a.role >= 2, writable: a.role === 1 || a.role === 3 }))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push("instruction accounts differ from the reviewed initialize accounts (order, address, signer or writable)")
    if (hex(ix.data ?? new Uint8Array()) !== hex(instruction.data)) failures.push("instruction data differs from the reviewed initialize data")
  }
  // Every key must be used by the instruction (or be the fee payer): no smuggled accounts.
  const used = new Set([0, ix?.programAddressIndex, ...(ix?.accountIndices ?? [])])
  if (keys.some((_, i) => !used.has(i))) failures.push("message lists accounts the instruction does not use")
  // Re-encode with the same blockhash: the bytes must be exactly the canonical message.
  const canonical = compile(admin, instruction, decoded.lifetimeToken as Blockhash)
  if (hex(canonical) !== hex(bytes)) failures.push("message bytes differ from the canonical TX2 message for this blockhash")
  if (failures.length) throw new Error(`REFUSED: ${failures.join("; ")}`)
  return messageHash(bytes)
}

async function fixtures() {
  const { admin, programData, instruction } = await expectedInstruction()
  const mint = address(DEVNET_SETUP.mint)
  const [[config, configBump], [mintAuthority, mintAuthorityBump], [membership, membershipBump], [vaultAuthority, vaultBump], [spendAuthority, spendBump], noBurn] = await Promise.all([
    findConfigPda(),
    findMintAuthorityPda(),
    findMembershipAuthorityPda(),
    findVaultAuthorityPda(),
    findSpendAuthorityPda(),
    findNoBurnAuthority(),
  ])
  const [vault] = await findAssociatedTokenPda({ owner: vaultAuthority, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const messageBytes = compile(admin, instruction, FIXTURE_BLOCKHASH)

  const configAccount = getConfigEncoder().encode({
    admin: admin.address,
    operator: address(DEVNET_SETUP.operator),
    qlcMint: mint,
    vault,
    ...DEVNET_LIMITS,
    mintWindowStart: BigInt(1_790_000_000),
    mintedInWindow: BigInt(0),
    paused: false,
    totalMinted: BigInt(0),
    totalDelivered: BigInt(0),
    totalCharged: BigInt(0),
    totalRefunded: BigInt(0),
    bump: configBump,
    mintAuthorityBump,
    membershipBump,
    vaultBump,
    spendBump,
  })
  const vaultAccount = getTokenEncoder().encode({
    mint,
    owner: vaultAuthority,
    amount: BigInt(0),
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: BigInt(0),
    closeAuthority: none(),
    // The order the deployed runtime produces (fixtures/vault-runtime.json); the signer's check is order-independent.
    extensions: some([extension("ImmutableOwner", {}), extension("PausableAccount", {}), extension("TransferHookAccount", { transferring: false })]),
  })

  const adminAddress = admin.address
  const approved = (): ExtensionArgs[] => [
    extension("MetadataPointer", { authority: some(adminAddress), metadataAddress: some(mint) }),
    extension("DefaultAccountState", { state: AccountState.Frozen }),
    extension("PermissionedBurn", { authority: some(noBurn) }),
    extension("PausableConfig", { authority: some(adminAddress), paused: false }),
    extension("TransferHook", { authority: adminAddress, programId: SYSTEM }),
    extension("TokenMetadata", { updateAuthority: some(adminAddress), mint, name: QLC_METADATA.name, symbol: QLC_METADATA.symbol, uri: QLC_METADATA.uri, additionalMetadata: new Map() }),
  ]
  const metadata = (overrides: Partial<{ updateAuthority: Address | null; uri: string; extra: boolean }>) =>
    extension("TokenMetadata", {
      updateAuthority: overrides.updateAuthority === null ? none() : some(overrides.updateAuthority ?? adminAddress),
      mint,
      name: QLC_METADATA.name,
      symbol: QLC_METADATA.symbol,
      uri: overrides.uri ?? QLC_METADATA.uri,
      additionalMetadata: overrides.extra ? new Map([["tradable", "yes"]]) : new Map(),
    })
  type Variant = Partial<{ decimals: number; supply: bigint; mintAuthority: Address; freezeAuthority: Address; initialized: boolean; drop: string; add: ExtensionArgs; replace: ExtensionArgs }>
  const encodeMint = (v: Variant) => {
    let extensions = approved()
    if (v.drop) extensions = extensions.filter((e) => e.__kind !== v.drop)
    if (v.replace) extensions = extensions.map((e) => (e.__kind === v.replace!.__kind ? v.replace! : e))
    if (v.add) extensions = [...extensions, v.add]
    return hex(
      getMintEncoder().encode({
        mintAuthority: some(v.mintAuthority ?? mintAuthority),
        supply: v.supply ?? BigInt(0),
        decimals: v.decimals ?? 2,
        isInitialized: v.initialized ?? true,
        freezeAuthority: some(v.freezeAuthority ?? membership),
        extensions: some(extensions),
      }),
    )
  }
  const variants: [string, Variant][] = [
    ["decimals 9", { decimals: 9 }],
    ["supply already minted", { supply: BigInt(5) }],
    ["mint authority kept by the admin", { mintAuthority: adminAddress }],
    ["freeze authority kept by the admin", { freezeAuthority: adminAddress }],
    ["not initialized", { initialized: false }],
    ["extra PermanentDelegate", { add: extension("PermanentDelegate", { delegate: adminAddress }) }],
    ["extra MintCloseAuthority", { add: extension("MintCloseAuthority", { closeAuthority: adminAddress }) }],
    ["extra NonTransferable", { add: extension("NonTransferable", {}) }],
    ["missing PausableConfig", { drop: "PausableConfig" }],
    ["missing PermissionedBurn", { drop: "PermissionedBurn" }],
    ["missing DefaultAccountState", { drop: "DefaultAccountState" }],
    ["missing TransferHook", { drop: "TransferHook" }],
    ["missing MetadataPointer", { drop: "MetadataPointer" }],
    ["missing TokenMetadata", { drop: "TokenMetadata" }],
    ["DefaultAccountState Initialized", { replace: extension("DefaultAccountState", { state: AccountState.Initialized }) }],
    ["burn authority = admin", { replace: extension("PermissionedBurn", { authority: some(adminAddress) }) }],
    ["mint paused", { replace: extension("PausableConfig", { authority: some(adminAddress), paused: true }) }],
    ["pause authority = other", { replace: extension("PausableConfig", { authority: some(OTHER), paused: false }) }],
    ["transfer hook program active", { replace: extension("TransferHook", { authority: adminAddress, programId: OTHER }) }],
    ["transfer hook authority = other", { replace: extension("TransferHook", { authority: OTHER, programId: SYSTEM }) }],
    ["metadata pointer elsewhere", { replace: extension("MetadataPointer", { authority: some(adminAddress), metadataAddress: some(OTHER) }) }],
    ["metadata pointer authority = other", { replace: extension("MetadataPointer", { authority: some(OTHER), metadataAddress: some(mint) }) }],
    ["metadata uri changed", { replace: metadata({ uri: "https://evil.example/qlc.json" }) }],
    ["metadata update authority = other", { replace: metadata({ updateAuthority: OTHER }) }],
    ["metadata without update authority", { replace: metadata({ updateAuthority: null }) }],
    ["extra metadata field", { replace: metadata({ extra: true }) }],
  ]
  return {
    generatedBy: "npm run qlc:tx2:check -- fixtures (Codama client + @solana-program/token-2022 encoders)",
    addresses: {
      program: QELARIX_QLC_PROGRAM_ADDRESS,
      admin: adminAddress,
      operator: DEVNET_SETUP.operator,
      mint,
      config,
      vault,
      mintAuthority,
      membershipAuthority: membership,
      vaultAuthority,
      spendAuthority,
      programData,
      noBurnAuthority: noBurn,
      token2022: TOKEN_2022_PROGRAM_ADDRESS,
      associatedToken: ATA,
      system: SYSTEM,
      loader: LOADER,
    },
    initialize: {
      discriminatorHex: hex(INITIALIZE_DISCRIMINATOR),
      dataHex: hex(instruction.data),
      accounts: instruction.accounts.map((a) => ({ address: a.address, signer: a.role >= 2, writable: a.role === 1 || a.role === 3 })),
    },
    message: { blockhash: FIXTURE_BLOCKHASH, hex: hex(messageBytes), hash: messageHash(messageBytes) },
    config: { discriminatorHex: hex(CONFIG_DISCRIMINATOR), mintWindowStart: 1_790_000_000, accountHex: hex(new Uint8Array(configAccount)) },
    vault: { accountHex: hex(new Uint8Array(vaultAccount)) },
    mints: [{ name: "approved QLC mint", ok: true, hex: encodeMint({}) }, ...variants.map(([name, v]) => ({ name, ok: false, hex: encodeMint(v) }))],
  }
}

/**
 * Read-only devnet simulation (signature verification off, nothing signed or sent) of TX1 plus the associated token
 * account the program's initialize creates for the vault authority, in one transaction: the exact vault bytes the
 * deployed Token-2022 and Associated Token Account programs produce for this mint (before the program thaws it).
 */
async function runtimeVault() {
  const rpc = createSolanaRpc(CLUSTERS.devnet.http)
  const genesis = await assertCluster(rpc, "devnet")
  const mint = address(DEVNET_SETUP.mint)
  if ((await rpc.getAccountInfo(mint, { encoding: "base64" }).send()).value) throw new Error("STOP: the mint exists; this capture simulates its creation and needs the address unused")
  const payer = createNoopSigner(address(DEVNET_SETUP.payer))
  const admin = address(DEVNET_SETUP.admin)
  const [[mintAuthority], [membership], [vaultAuthority], noBurn] = await Promise.all([findMintAuthorityPda(), findMembershipAuthorityPda(), findVaultAuthorityPda(), findNoBurnAuthority()])
  const [vault] = await findAssociatedTokenPda({ owner: vaultAuthority, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const { space, finalSize } = mintSizes(admin, mint, noBurn)
  const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(finalSize)).send()
  const instructions = [
    ...createMintInstructions({ payer, mint: createNoopSigner(mint), admin, mintAuthority, freezeAuthority: membership, noBurnAuthority: noBurn, lamports, space }),
    getCreateAssociatedTokenInstruction({ payer, ata: vault, owner: vaultAuthority, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
  ]
  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const wire = getBase64EncodedWireTransaction(compileTransaction(message))
  const result = (
    await rpc
      .simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { addresses: [vault], encoding: "base64" } })
      .send()
  ).value
  const account = result.accounts?.[0]
  if (result.err || !account) throw new Error(`simulation failed: ${JSON.stringify(result.err)} ${(result.logs ?? []).slice(-3).join(" | ")}`)
  const bytes = Buffer.from(account.data[0], "base64")
  const order: number[] = []
  for (let offset = 166; offset + 4 <= bytes.length; ) {
    const type = bytes.readUInt16LE(offset)
    if (type === 0) break
    order.push(type)
    offset += 4 + bytes.readUInt16LE(offset + 2)
  }
  return {
    capturedFrom: "devnet simulateTransaction (sigVerify off, replaceRecentBlockhash, nothing signed or sent): TX1 + CreateAssociatedToken(vault authority, QLC mint, Token-2022) in one transaction",
    genesis,
    owner: account.owner,
    length: bytes.length,
    extensionOrder: order,
    note: "Simulated vault before initialize thaws it: state byte 108 = 2 (Frozen); initialize only changes it to 1. TLV area unchanged.",
    accountHex: bytes.toString("hex"),
  }
}

async function selftest(): Promise<boolean> {
  let failures = 0
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failures++
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
  }
  const accepts = async (bytes: Uint8Array) => checkMessage(bytes).then((hash) => hash, () => null)
  const refuses = async (name: string, bytes: Uint8Array) => {
    const error = await checkMessage(bytes).then(() => null, (e: Error) => e.message)
    check(`refuses: ${name}`, error !== null, error ?? "accepted")
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"))
  check("fixtures are current", `${JSON.stringify(await fixtures(), null, 2)}\n` === readFileSync(FIXTURE, "utf8"))
  const { admin, instruction } = await expectedInstruction()
  const good = new Uint8Array(Buffer.from(fixture.message.hex, "hex"))
  check("accepts the canonical TX2 message; hash equals the Rust signer's", (await accepts(good)) === fixture.message.hash, fixture.message.hash)
  const refreshed = compile(admin, instruction, address("Stake11111111111111111111111111111111111111") as string as Blockhash)
  const refreshedHash = await accepts(refreshed)
  check("accepts the same message with another blockhash, with a different hash", refreshedHash !== null && refreshedHash !== fixture.message.hash, String(refreshedHash))
  const kitOrder = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayerSigner(admin, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: FIXTURE_BLOCKHASH, lastValidBlockHeight: BigInt(0) }, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
  )
  await refuses("same instruction, @solana/kit account order (not the SDK order the signer uses)", new Uint8Array(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(kitOrder))))
  const flipped = new Uint8Array(good)
  flipped[flipped.length - 1] ^= 1
  await refuses("one instruction-data byte changed", flipped)
  const otherPayer = compile(createNoopSigner(address("Stake11111111111111111111111111111111111111")), instruction, FIXTURE_BLOCKHASH)
  await refuses("another fee payer", otherPayer)
  const extra = decodeLegacy(good)
  await refuses(
    "a second instruction",
    new Uint8Array(getCompiledTransactionMessageEncoder().encode({ ...extra, instructions: [...extra.instructions, extra.instructions[0]] })),
  )
  const swapped = { ...extra, instructions: [{ ...extra.instructions[0], accountIndices: [...(extra.instructions[0].accountIndices ?? [])] }] }
  const indices = swapped.instructions[0].accountIndices!
  ;[indices[3], indices[4]] = [indices[4], indices[3]]
  await refuses("two instruction accounts swapped", new Uint8Array(getCompiledTransactionMessageEncoder().encode(swapped)))

  // Strict base64 input for `message --file`.
  const canonical = Buffer.from(good).toString("base64")
  const decodes = (text: string) => {
    try {
      return hex(decodeMessageText(text)) === hex(good)
    } catch {
      return false
    }
  }
  const textRefused = (name: string, text: string) => {
    let error: string | null = null
    try {
      decodeMessageText(text)
    } catch (e) {
      error = (e as Error).message
    }
    check(`refuses message text: ${name}`, error !== null, error ?? "accepted")
  }
  check("accepts canonical base64, with or without one trailing newline", decodes(canonical) && decodes(`${canonical}\n`) && decodes(`${canonical}\r\n`))
  textRefused("embedded whitespace", `${canonical.slice(0, 40)} ${canonical.slice(40)}`)
  textRefused("two trailing newlines", `${canonical}\n\n`)
  textRefused("leading whitespace", ` ${canonical}`)
  textRefused("invalid character", `${canonical.slice(0, 10)}*${canonical.slice(11)}`)
  textRefused("missing padding", canonical.replace(/=+$/, ""))
  textRefused("base64url alphabet", canonical.replace(/\+/g, "-").replace(/\//g, "_"))
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const lastData = canonical.replace(/=+$/, "").length - 1
  const sloppy = canonical.slice(0, lastData) + alphabet[alphabet.indexOf(canonical[lastData]) | 1] + canonical.slice(lastData + 1)
  textRefused("non-zero padding bits (Node would decode it to the same bytes)", sloppy)
  textRefused("empty", "")
  textRefused("larger than a Solana packet", Buffer.alloc(MAX_MESSAGE_BYTES + 1, 1).toString("base64"))
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll TX2 cross-check self-tests passed")
  return failures === 0
}

async function main(): Promise<boolean> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === "fixtures") {
    const unknown = rest.filter((a) => a !== "--check")
    if (unknown.length) throw new Error(`unknown argument ${unknown[0]}`)
    const text = `${JSON.stringify(await fixtures(), null, 2)}\n`
    if (rest.includes("--check")) {
      const current = readFileSync(FIXTURE, "utf8")
      const ok = current === text
      console.log(ok ? "PASS  signer fixtures are current" : "FAIL  signer fixtures are stale (regenerate only as a reviewed implementation change)")
      return ok
    }
    writeFileSync(FIXTURE, text)
    console.log(`wrote ${FIXTURE}`)
    return true
  }
  if (command === "selftest") return selftest()
  if (command === "runtime-vault") {
    const unknown = rest.filter((a) => a !== "--check")
    if (unknown.length) throw new Error(`unknown argument ${unknown[0]}`)
    const captured = await runtimeVault()
    if (rest.includes("--check")) {
      const stored = JSON.parse(readFileSync(RUNTIME_VAULT, "utf8"))
      const ok = stored.accountHex === captured.accountHex && JSON.stringify(stored.extensionOrder) === JSON.stringify(captured.extensionOrder)
      console.log(`${ok ? "PASS" : "FAIL"}  runtime vault (${captured.length} bytes, extension order ${captured.extensionOrder.join(", ")}) ${ok ? "equals" : "differs from"} the stored regression fixture`)
      return ok
    }
    writeFileSync(RUNTIME_VAULT, `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), ...captured }, null, 2)}\n`)
    console.log(`wrote ${RUNTIME_VAULT} (extension order ${captured.extensionOrder.join(", ")})`)
    return true
  }
  if (command === "message") {
    if (rest.length !== 2 || rest[0] !== "--file") throw new Error("usage: message --file <path to the base64 message printed by the signer>")
    const hash = await checkMessage(decodeMessageText(readFileSync(rest[1], "utf8")))
    console.log("PASS  exactly the reviewed QLC initialize (TX2): one instruction, admin Ledger is the only signer and fee payer")
    console.log("NOTE  content only: this does not prove the blockhash is recent or that the transaction can still land")
    console.log(`Message Hash (must equal the Ledger screen, every character): ${hash}`)
    return true
  }
  throw new Error("usage: qlc-tx2-check.ts message --file <path> | fixtures [--check] | selftest | runtime-vault [--check]")
}

if (process.argv[1]?.endsWith("qlc-tx2-check.ts")) main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
