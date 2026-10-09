// Keyless, read-only tooling for the QLC program's canonical Program Metadata on devnet (seeds "idl" and
// "security", program ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S). It never reads a key, never talks to a
// hardware wallet, never signs and never sends a transaction. Runbook: the QLC metadata runbook (Notion).
//
//   npm run qlc:metadata:idl [-- --check]   Codama IDL with a hash-chained provenance from the deployed build
//   npm run qlc:metadata:security           review solana/metadata/security.json (no invented claims)
//   npm run qlc:metadata:plan               metadata PDAs, payload sizes, live rent, Ledger balance, readiness
//   npm run qlc:metadata:inspect -- --seed idl|security --file <export>   owner-prepared export = exact official plan
//   npm run qlc:metadata:verify -- --seed idl|security                    on-chain canonical metadata = local file
//
// Exit code 1 on any failure. A passing result authorizes nothing.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync, inflateSync } from "node:zlib"
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  createTransactionPlanner,
  fillTransactionMessageProvisoryResourceLimits,
  flattenTransactionPlan,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getLinearMessagePackerInstructionPlan,
  getMessagePackerInstructionPlanFromInstructions,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  isSingleTransactionPlan,
  parallelInstructionPlan,
  pipe,
  sequentialInstructionPlan,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionPlan,
} from "@solana/kit"
import { getTransferSolInstruction } from "@solana-program/system"
import { createFromRoot, getValidationItemsVisitor, visit } from "codama"
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor"
import { renderVisitor } from "@codama/renderers-js"
import {
  DEVNET,
  PROGRAM_ID,
  PROGRAM_SO,
  REJECTED_ID_HASHES,
  ROOT,
  artifactChecks,
  readManifest,
  rejectedIdentityChecks,
  report,
  rpc,
  sha256,
  type Check,
  type Manifest,
} from "./qlc-build-preflight"
import { DEPLOY_IDENTITIES, programDataAddressOf } from "./qlc-deploy-preflight"

export const PMP_PROGRAM = "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S"
export const LEDGER = DEPLOY_IDENTITIES.upgradeAuthority
const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111"
const SYSTEM_PROGRAM = "11111111111111111111111111111111"
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"
// Well-known programs the IDL references; any other address in the IDL must be the program itself.
const IDL_ADDRESSES = new Set([PROGRAM_ID, SYSTEM_PROGRAM, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"])
// The binary deployed to devnet in Task 07 (verified byte-for-byte on chain).
export const DEPLOYED_SO_SHA256 = "168e3edf4474eda9808c45d511134a51c0e85bc59ee41b6b5ed19a1a330fc8b6"
// The conversion is only reproducible with these exact versions (package.json pins them).
const CODAMA_VERSIONS: Record<string, string> = { codama: "1.11.0", "@codama/nodes-from-anchor": "1.5.6", "@codama/renderers-js": "2.5.0" }

export const SEEDS = ["idl", "security"] as const
export type Seed = (typeof SEEDS)[number]
export const METADATA_FILES: Record<Seed, string> = {
  idl: join(ROOT, "solana/metadata/idl.json"),
  security: join(ROOT, "solana/metadata/security.json"),
}
export const PROVENANCE_FILE = join(ROOT, "solana/metadata/idl.provenance.json")
const ANCHOR_IDL = join(ROOT, "solana/target/idl/qelarix_qlc.json")
const CLIENT_DIR = join(ROOT, "src/lib/qlc/generated")

// Program Metadata layouts (program/src/state, program/src/instruction.rs @ b618644 = js@0.10.0).
export const HEADER_LEN = 96
const REALLOC_LIMIT = 10_240
const ACCOUNT_METADATA = 2
// The canonical encoding the runbook uses: utf8 text, zlib compression, JSON, data stored on chain.
const EXPECTED_FORMAT = { encoding: 1, compression: 2, format: 1, dataSource: 0 }
const PMP_IX = { write: 0, initialize: 1, allocate: 7, extend: 8 }
const PMP_IX_NAMES = ["Write", "Initialize", "SetAuthority", "SetData", "SetImmutable", "Trim", "Close", "Allocate", "Extend"]
const LAMPORTS_PER_SIGNATURE = 5_000
// The export is decoded and compared with any blockhash; this placeholder stands in for it.
const PLACEHOLDER_BLOCKHASH = blockhash("11111111111111111111111111111111")

export const seedBytes = (seed: string) => {
  const bytes = Buffer.alloc(16)
  bytes.write(seed, "utf8")
  return bytes
}
const isRejected = (value: string) => REJECTED_ID_HASHES.has(sha256(value))
const pubkeyAt = (data: Buffer, offset: number) => getAddressDecoder().decode(data.subarray(offset, offset + 32))
const u16 = (n: number) => Buffer.from([n & 0xff, n >> 8])
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

/** Canonical metadata PDA: [program, seed (16 bytes)] under the Program Metadata program. */
export async function metadataAddress(seed: Seed): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PMP_PROGRAM),
    seeds: [getAddressEncoder().encode(address(PROGRAM_ID)), seedBytes(seed)],
  })
  return pda
}

/** What the CLI stores: the file text as utf8, zlib-compressed (estimate; the exact bytes come from the export). */
export const packedLength = (text: string) => deflateSync(Buffer.from(text, "utf8")).length

// ---------------------------------------------------------------------------------------------- IDL

/** Deterministic Codama IDL (pretty JSON) from the Anchor IDL of the verified build. */
export function codamaIdl(anchorText: string): string {
  return `${JSON.stringify(createFromRoot(rootNodeFromAnchor(JSON.parse(anchorText))).getRoot(), null, 2)}\n`
}

/** An 8-byte discriminator compiled into SBF code, either raw or split across an lddw instruction pair. */
export function inBinary(so: Buffer, discriminator: number[]): boolean {
  const bytes = Buffer.from(discriminator)
  if (so.includes(bytes)) return true
  const [low, high] = [bytes.subarray(0, 4), bytes.subarray(4)]
  for (let i = so.indexOf(low); i >= 4; i = so.indexOf(low, i + 1)) {
    if (so[i - 4] === 0x18 && so.readUInt32LE(i + 4) === 0 && so.subarray(i + 8, i + 12).equals(high)) return true
  }
  return false
}

/**
 * The hash chain from the deployed program to the Anchor IDL: the local binary is the deployed binary, and the
 * Anchor IDL is byte-for-byte the IDL that the same `npm run qlc:build` run wrote and recorded in the manifest
 * next to that binary. Timestamps are not evidence; hashes are.
 */
export function provenanceChecks(manifest: Manifest | null, anchorText: string, so: Buffer): Check[] {
  const started = manifest?.build ? Date.parse(manifest.build.startedAt) : NaN
  return [
    { name: "provenance: safe-build manifest present for the program", ok: manifest?.programId === PROGRAM_ID, detail: manifest ? undefined : "missing — run npm run qlc:build" },
    {
      name: `provenance: local binary = manifest binary = deployed binary (sha256 ${DEPLOYED_SO_SHA256})`,
      ok: sha256(so) === DEPLOYED_SO_SHA256 && manifest?.so.sha256 === DEPLOYED_SO_SHA256,
      detail: `local ${sha256(so)}, manifest ${manifest?.so.sha256 ?? "none"}`,
    },
    {
      name: "provenance: Anchor IDL = the IDL recorded by that same build (sha256)",
      ok: Boolean(manifest?.idl) && manifest?.idl?.sha256 === sha256(anchorText),
      detail: `local ${sha256(anchorText)}, manifest ${manifest?.idl?.sha256 ?? "none — run npm run qlc:build"}`,
    },
    {
      name: "provenance: binary and Anchor IDL were both written by one npm run qlc:build run",
      ok:
        manifest?.build?.command === "npm run qlc:build" &&
        Number.isFinite(started) &&
        Date.parse(manifest.so.builtAt) >= started - 1_000 &&
        Date.parse(manifest.idl?.builtAt ?? "") >= started - 1_000,
      detail: manifest?.build ? `run started ${manifest.build.startedAt}` : "no build record",
    },
  ]
}

/** The conversion toolchain is the pinned one (reproducibility of idl.json). */
export function codamaVersionChecks(read: (name: string) => string | null = installedVersion): Check[] {
  return Object.entries(CODAMA_VERSIONS).map(([name, version]) => ({
    name: `provenance: ${name} ${version} installed (pinned conversion toolchain)`,
    ok: read(name) === version,
    detail: read(name) ?? "missing",
  }))
}

function installedVersion(name: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")) as { version: string }).version
  } catch {
    return null
  }
}

/** Content-addressed provenance record committed next to idl.json (no timestamps, so reproducible rebuilds keep it). */
export function provenanceRecord(manifest: Manifest, anchorText: string, so: Buffer, codamaText: string): string {
  const anchor = JSON.parse(anchorText) as { metadata: { spec: string } }
  const root = JSON.parse(codamaText) as { version: string }
  return `${JSON.stringify(
    {
      programId: PROGRAM_ID,
      deployedBinary: { sha256: sha256(so), size: so.length },
      build: { command: "npm run qlc:build", sourcesDigest: manifest.sourcesDigest, toolchain: manifest.toolchain },
      anchorIdl: { sha256: sha256(anchorText), size: Buffer.byteLength(anchorText), spec: anchor.metadata.spec },
      conversion: CODAMA_VERSIONS,
      codamaIdl: { path: relative(ROOT, METADATA_FILES.idl), sha256: sha256(codamaText), size: Buffer.byteLength(codamaText), standardVersion: root.version },
    },
    null,
    2,
  )}\n`
}

type AnchorItem = { name: string; discriminator: number[] }
type AnchorIdl = { address: string; metadata: { spec: string; version: string }; instructions: AnchorItem[]; accounts?: AnchorItem[]; events?: AnchorItem[] }

/** The IDL content describes the deployed program: Anchor discriminators compiled into the binary, valid Codama. */
export function idlChecks(anchorText: string, so: Buffer, codamaText: string): Check[] {
  const anchor = JSON.parse(anchorText) as AnchorIdl
  const root = JSON.parse(codamaText) as {
    kind: string
    standard: string
    version: string
    program: { name: string; publicKey: string; version: string; instructions: { name: string; arguments: { name: string; defaultValue?: { data?: string } }[] }[] }
  }
  const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  const anchorRule = (prefix: string, item: AnchorItem) => sha256(`${prefix}:${item.name}`).slice(0, 16) === Buffer.from(item.discriminator).toString("hex")
  const groups: [string, string, AnchorItem[]][] = [
    ["instruction", "global", anchor.instructions],
    ["account", "account", anchor.accounts ?? []],
    ["event", "event", anchor.events ?? []],
  ]
  const checks: Check[] = [
    { name: "IDL: Anchor IDL address = program id", ok: anchor.address === PROGRAM_ID, detail: anchor.address },
    { name: "IDL: Anchor IDL spec 0.1.0 (Anchor >= 0.30 format)", ok: anchor.metadata?.spec === "0.1.0", detail: anchor.metadata?.spec },
  ]
  for (const [kind, prefix, items] of groups) {
    const missing = items.filter((item) => !anchorRule(prefix, item) || !inBinary(so, item.discriminator)).map((item) => item.name)
    checks.push({
      name: `IDL: every ${kind} discriminator follows the Anchor rule and is compiled into the deployed binary`,
      ok: items.length > 0 && missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(", ")}` : `${items.length} of ${items.length}`,
    })
  }
  const control = Array.from(Buffer.from(sha256("global:qelarix_not_an_instruction").slice(0, 16), "hex"))
  checks.push({ name: "IDL: negative control (a discriminator the program lacks is not found)", ok: !inBinary(so, control) })
  const codamaDiscriminators = new Map(
    root.program.instructions.map((ix) => [ix.name, ix.arguments.find((arg) => arg.name === "discriminator")?.defaultValue?.data]),
  )
  const mismatched = anchor.instructions.filter((ix) => codamaDiscriminators.get(camel(ix.name)) !== Buffer.from(ix.discriminator).toString("hex"))
  const items = visit(createFromRoot(rootNodeFromAnchor(anchor as never)).getRoot(), getValidationItemsVisitor())
  const problems = items.filter((item) => item.level === "error" || item.level === "warn")
  const addresses = Array.from(new Set(Array.from(codamaText.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g), (m) => m[1])))
  const foreign = addresses.filter((value) => !IDL_ADDRESSES.has(value) || isRejected(value))
  checks.push(
    { name: "Codama: root node, standard codama", ok: root.kind === "rootNode" && root.standard === "codama", detail: `version ${root.version}` },
    {
      name: `Codama: program qelarixQlc at ${PROGRAM_ID}, version ${anchor.metadata.version}`,
      ok: root.program.publicKey === PROGRAM_ID && root.program.name === "qelarixQlc" && root.program.version === anchor.metadata.version,
      detail: `${root.program.name} ${root.program.publicKey} ${root.program.version}`,
    },
    {
      name: "Codama: same instructions and discriminators as the Anchor IDL",
      ok: root.program.instructions.length === anchor.instructions.length && mismatched.length === 0,
      detail: mismatched.length ? `mismatch: ${mismatched.map((ix) => ix.name).join(", ")}` : `${anchor.instructions.length} instructions`,
    },
    { name: "Codama: validators report no errors or warnings", ok: problems.length === 0, detail: problems.map((p) => p.message).join("; ") || undefined },
    { name: "Codama: only the program id and well-known programs as addresses; no rejected identity", ok: foreign.length === 0, detail: foreign.join(", ") || undefined },
    { name: "Codama: deterministic (two conversions are identical)", ok: codamaIdl(anchorText) === codamaText },
  )
  return checks
}

/** The committed client in src/lib/qlc/generated is exactly what Codama renders from this IDL. */
async function clientMatches(anchorText: string): Promise<Check> {
  const out = mkdtempSync(join(tmpdir(), "qlc-client-"))
  try {
    await createFromRoot(rootNodeFromAnchor(JSON.parse(anchorText))).accept(
      renderVisitor(out, { generatedFolder: "generated", deleteFolderBeforeRendering: false, syncPackageJson: false, kitImportStrategy: "rootOnly", formatCode: true }),
    )
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]))
    const rendered = files(join(out, "generated")).map((file) => relative(join(out, "generated"), file)).sort()
    const committed = files(CLIENT_DIR).map((file) => relative(CLIENT_DIR, file)).sort()
    // solana/scripts/codama.mjs prefixes every generated file with an eslint-disable line.
    const differing = rendered.filter((file) => `/* eslint-disable */\n${readFileSync(join(out, "generated", file), "utf8")}` !== readFileSync(join(CLIENT_DIR, file), "utf8"))
    const same = rendered.join() === committed.join() && differing.length === 0
    return {
      name: "client: committed src/lib/qlc/generated is exactly the Codama render of this IDL",
      ok: same,
      detail: same ? `${committed.length} files identical` : `differs: ${[...differing, ...committed.filter((f) => !rendered.includes(f))].join(", ")}`,
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

async function idlCommand(argv: string[]): Promise<boolean> {
  const check = argv.includes("--check")
  const checks: Check[] = [...artifactChecks("require")]
  if (!existsSync(ANCHOR_IDL) || !existsSync(PROGRAM_SO)) {
    checks.push({ name: "IDL: Anchor IDL and binary present", ok: false, detail: "run npm run qlc:build" })
    return report("QLC canonical IDL (keyless)", checks, "")
  }
  const anchorText = readFileSync(ANCHOR_IDL, "utf8")
  const so = readFileSync(PROGRAM_SO)
  const manifest = readManifest()
  const text = codamaIdl(anchorText)
  checks.push(...provenanceChecks(manifest, anchorText, so), ...codamaVersionChecks(), ...idlChecks(anchorText, so, text), await clientMatches(anchorText))
  const outputs: [string, string | null][] = [
    [METADATA_FILES.idl, text],
    [PROVENANCE_FILE, manifest ? provenanceRecord(manifest, anchorText, so, text) : null],
  ]
  for (const [file, content] of outputs) {
    if (check) {
      const committed = existsSync(file) ? readFileSync(file, "utf8") : null
      checks.push({ name: `file: ${relative(ROOT, file)} is current`, ok: content !== null && committed === content, detail: committed === null ? "missing" : committed === content ? undefined : "stale — run npm run qlc:metadata:idl" })
    } else if (content !== null && checks.every((c) => c.ok)) {
      writeFileSync(file, content)
      checks.push({ name: `file: written ${relative(ROOT, file)}`, ok: true, info: true })
    }
  }
  checks.push({ name: "payload", ok: true, info: true, detail: `${Buffer.byteLength(text)} bytes, ${packedLength(text)} zlib, sha256 ${sha256(text)}` })
  return report("QLC canonical IDL (keyless: Codama standard, provenance-chained to the deployed build)", checks, "IDL ready for owner review. Uploading it is a separate owner mutation.")
}

// ---------------------------------------------------------------------------------------- security

// Keys the Explorer's @solana/security-txt parser recognizes (neodyme spec + Program Metadata extras).
const SECURITY_KEYS = new Set([
  "name", "project_url", "contacts", "policy", "preferred_languages", "encryption", "source_code", "source_release",
  "source_revision", "auditors", "acknowledgements", "expiry", "logo", "description", "notification", "sdk", "version",
])
const URL_KEYS = new Set(["project_url", "policy", "logo", "source_code", "sdk", "acknowledgements"])
// Hosts approved for metadata URLs. Adding one (for example a public source repository) is an owner decision.
const APPROVED_URL_HOSTS = new Set(["qelarix.ai"])
// Fields that need an owner decision or a published resource before they can be filled in.
export const SECURITY_OWNER_DECISIONS: Record<string, string> = {
  contacts: "public security contact (for example email:<address>) — not invented",
  policy: "URL of a published security policy (nothing is published at qelarix.ai yet)",
  logo: "stable public logo URL (qelarix.ai serves no logo URL today)",
  source_code: "public source repository (the repository is private; required for verified builds too)",
  encryption: "optional PGP key URL",
  expiry: "optional review date (YYYY-MM-DD)",
}

/** The security.txt draft: recognized keys only, string values, no placeholders, https URLs on approved hosts, no unproven claims. */
export function securityChecks(text: string): Check[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return [{ name: "security: valid JSON object", ok: false, detail: "not JSON" }]
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [{ name: "security: valid JSON object", ok: false }]
  const fields = parsed as Record<string, unknown>
  const unknown = Object.keys(fields).filter((key) => !SECURITY_KEYS.has(key))
  const values = Object.entries(fields).flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => [key, v] as const) : [[key, value] as const]))
  const notStrings = values.filter(([, value]) => typeof value !== "string" || !value.trim()).map(([key]) => key)
  const placeholders = values.filter(([, value]) => typeof value === "string" && /[<>]|\bTODO\b|\bTBD\b|example\.(com|org)|x{3,}/i.test(value)).map(([key]) => key)
  const badUrls = values
    .filter(([key]) => URL_KEYS.has(key))
    .filter(([, value]) => {
      try {
        const url = new URL(String(value))
        return url.protocol !== "https:" || !APPROVED_URL_HOSTS.has(url.hostname)
      } catch {
        return true
      }
    })
    .map(([key, value]) => `${key}=${String(value)}`)
  const contacts = (Array.isArray(fields.contacts) ? fields.contacts : fields.contacts === undefined ? [] : [fields.contacts]).map(String)
  const badContacts = contacts.filter((c) => !/^(email|link|discord|telegram|twitter|other):\S+/.test(c))
  const checks: Check[] = [
    { name: "security: valid JSON object", ok: true },
    { name: "security: only keys the Explorer parser recognizes", ok: unknown.length === 0, detail: unknown.join(", ") || undefined },
    { name: "security: every value is a non-empty string (or list of strings)", ok: notStrings.length === 0, detail: notStrings.join(", ") || undefined },
    { name: "security: no placeholder or example values", ok: placeholders.length === 0, detail: placeholders.join(", ") || undefined },
    { name: `security: URLs are https on approved hosts (${Array.from(APPROVED_URL_HOSTS).join(", ")})`, ok: badUrls.length === 0, detail: badUrls.join(", ") || undefined },
    { name: "security: contacts use <scheme>:<value>", ok: badContacts.length === 0, detail: badContacts.join(", ") || undefined },
    { name: "security: no audit claim (no audit is recorded)", ok: fields.auditors === undefined, detail: fields.auditors === undefined ? undefined : "auditors present" },
    { name: "security: name and project_url present", ok: typeof fields.name === "string" && typeof fields.project_url === "string" },
  ]
  for (const [key, reason] of Object.entries(SECURITY_OWNER_DECISIONS)) {
    if (fields[key] === undefined) checks.push({ name: `security: owner decision — ${key}`, ok: true, info: true, detail: reason })
  }
  return checks
}

function securityCommand(): boolean {
  const file = METADATA_FILES.security
  const checks = existsSync(file) ? securityChecks(readFileSync(file, "utf8")) : [{ name: `security: ${relative(ROOT, file)} present`, ok: false }]
  return report("QLC security metadata draft (keyless review)", checks, "Draft structurally valid. Every value and every owner decision above needs PixiMan's approval before upload.")
}

// ------------------------------------------------------------------------------------- chain reads

type RpcAccount = { lamports: number; owner: string; executable: boolean; data: [string, string] } | null
export type Account = { lamports: number; owner: string; executable: boolean; data: Buffer }

async function accounts(addresses: string[], slice?: { offset: number; length: number }): Promise<(Account | null)[]> {
  const config = { encoding: "base64", commitment: "confirmed", ...(slice ? { dataSlice: slice } : {}) }
  const { value } = await rpc<{ value: RpcAccount[] }>("getMultipleAccounts", [addresses, config])
  return value.map((v) => (v ? { lamports: v.lamports, owner: v.owner, executable: v.executable, data: Buffer.from(v.data[0], "base64") } : null))
}
const rentFor = (size: number) => rpc<number>("getMinimumBalanceForRentExemption", [size, { commitment: "confirmed" }])

/** Live program state: devnet genesis, the program's upgrade authority is still the Ledger, Program Metadata is deployed. */
async function programChecks(): Promise<Check[]> {
  const programData = await programDataAddressOf(PROGRAM_ID)
  // Headers only: 45 bytes covers the ProgramData state, slot and upgrade authority.
  const [genesis, [program, pmp, data]] = await Promise.all([
    rpc<string>("getGenesisHash", []),
    accounts([PROGRAM_ID, PMP_PROGRAM, programData], { offset: 0, length: 45 }),
  ])
  const authority = data && data.owner === LOADER_V3 && data.data.readUInt32LE(0) === 3 && data.data[12] === 1 ? pubkeyAt(data.data, 13) : null
  return [
    { name: "devnet: RPC genesis = devnet", ok: genesis === DEVNET.genesis, detail: genesis },
    { name: `program: ${PROGRAM_ID} deployed (executable, upgradeable loader)`, ok: Boolean(program?.executable && program.owner === LOADER_V3) },
    { name: `program: upgrade authority = ${LEDGER} (owner Ledger)`, ok: authority === LEDGER, detail: authority ?? "none" },
    { name: `Program Metadata program ${PMP_PROGRAM} deployed on devnet`, ok: Boolean(pmp?.executable && pmp.owner === LOADER_V3) },
  ]
}

export type MetadataHeader = {
  discriminator: number
  program: string
  authority: string | null
  mutable: number
  canonical: number
  seed: Buffer
  encoding: number
  compression: number
  format: number
  dataSource: number
  dataLength: number
  padding: Buffer
}

/** The 96-byte header (program/src/state/header.rs); the data follows at offset 96. */
export function decodeHeader(data: Buffer): MetadataHeader | null {
  if (data.length < HEADER_LEN) return null
  return {
    discriminator: data[0],
    program: pubkeyAt(data, 1),
    authority: data.subarray(33, 65).every((b) => b === 0) ? null : pubkeyAt(data, 33),
    mutable: data[65],
    canonical: data[66],
    seed: data.subarray(67, 83),
    encoding: data[83],
    compression: data[84],
    format: data[85],
    dataSource: data[86],
    dataLength: data.readUInt32LE(87),
    padding: data.subarray(91, HEADER_LEN),
  }
}

/**
 * A fetched canonical metadata account is exactly what the reviewed create leaves behind: a non-executable
 * Program Metadata `Metadata` account for this program, canonical, seed exact, no extra authority, mutable,
 * utf8/zlib/json/on chain, account length exactly header + declared data length, zero padding, and the
 * decompressed content byte for byte the local file.
 */
export function metadataChecks(seed: Seed, account: Account | null, localText: string, rent: number): Check[] {
  const owned = account?.owner === PMP_PROGRAM
  const header = account && owned ? decodeHeader(account.data) : null
  const checks: Check[] = [
    { name: `${seed}: canonical metadata account exists, owned by Program Metadata`, ok: Boolean(account && owned), detail: account ? `owner ${account.owner}` : "absent" },
  ]
  if (!account || !owned) return checks
  checks.push({ name: `${seed}: not executable`, ok: account.executable === false })
  if (!header) {
    checks.push({ name: `${seed}: at least a 96-byte header`, ok: false, detail: `${account.data.length} bytes` })
    return checks
  }
  const layoutOk = account.data.length === HEADER_LEN + header.dataLength
  let content: string | null = null
  try {
    content = layoutOk ? inflateSync(account.data.subarray(HEADER_LEN)).toString("utf8") : null
  } catch {
    content = null
  }
  checks.push(
    { name: `${seed}: Metadata account for program ${PROGRAM_ID}`, ok: header.discriminator === ACCOUNT_METADATA && header.program === PROGRAM_ID, detail: `discriminator ${header.discriminator}, program ${header.program}` },
    { name: `${seed}: canonical (created by the upgrade authority)`, ok: header.canonical === 1, detail: String(header.canonical) },
    { name: `${seed}: seed field is exactly "${seed}" (16 bytes, zero padded)`, ok: header.seed.equals(seedBytes(seed)), detail: header.seed.toString("hex") },
    {
      name: `${seed}: no extra authority (only the upgrade authority ${LEDGER} manages it)`,
      ok: header.authority === null,
      detail: header.authority ? `authority ${header.authority}${isRejected(header.authority) ? " — REJECTED identity" : ""}` : "none",
    },
    { name: `${seed}: mutable (the Ledger can update it after a program upgrade)`, ok: header.mutable === 1, detail: String(header.mutable) },
    {
      name: `${seed}: utf8, zlib, json, stored on chain`,
      ok:
        header.encoding === EXPECTED_FORMAT.encoding &&
        header.compression === EXPECTED_FORMAT.compression &&
        header.format === EXPECTED_FORMAT.format &&
        header.dataSource === EXPECTED_FORMAT.dataSource,
      detail: `encoding ${header.encoding}, compression ${header.compression}, format ${header.format}, source ${header.dataSource}`,
    },
    {
      name: `${seed}: account length = 96-byte header + declared data length, zero header padding`,
      ok: layoutOk && header.dataLength > 0 && header.padding.every((b) => b === 0),
      detail: `${account.data.length} bytes, declared ${header.dataLength}, padding ${header.padding.toString("hex")}`,
    },
    {
      name: `${seed}: on-chain content = ${relative(ROOT, METADATA_FILES[seed])} byte for byte`,
      ok: content === localText,
      detail: content === null ? "no valid zlib payload" : `sha256 ${sha256(content)} vs local ${sha256(localText)}`,
    },
    { name: `${seed}: rent-exempt`, ok: account.lamports >= rent, detail: `${account.lamports} ≥ ${rent}` },
  )
  return checks
}

// ------------------------------------------------------------------------------ exported transactions

export type InspectContext = { seed: Seed; metadata: string; programData: string; localText: string; expectedRent: (size: number) => number }

type CompiledTx = {
  version: string | number
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number }
  staticAccounts: string[]
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[]
  addressTableLookups?: unknown[]
}

/** Base64 transactions from the CLI's `--export --export-encoding base64` output (log lines are ignored). */
export function parseExport(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length >= 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(token))
}

const decodeWire = (wire: string) => getTransactionDecoder().decode(Buffer.from(wire, "base64"))
const decodeMessage = (messageBytes: ReadonlyUint8Array) => getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as CompiledTx

/** Everything in a compiled message except its blockhash. */
function messageShape(tx: CompiledTx): string {
  return JSON.stringify({
    version: tx.version,
    header: tx.header,
    staticAccounts: tx.staticAccounts,
    instructions: tx.instructions.map((ix) => [ix.programAddressIndex, ix.accountIndices ?? [], Buffer.from(ix.data ?? []).toString("hex")]),
    lookups: tx.addressTableLookups ?? [],
  })
}

/** Realloc chunks exactly as Program Metadata js@0.10.0 getReallocChunkSizes splits account growth. */
export function reallocChunks(total: number): number[] {
  const sizes: number[] = []
  for (let remaining = total; remaining > 0; remaining -= REALLOC_LIMIT) sizes.push(Math.min(REALLOC_LIMIT, remaining))
  return sizes
}

/**
 * The transactions `program-metadata@0.10.0 write <seed> <program> <file> --export <Ledger> --priority-fees 0
 * --tx-version legacy` prints for this payload, rebuilt with the same @solana/kit 8.3.0 planner pipeline the CLI
 * uses (createMetadata.ts + kit-plugin-rpc 0.18.0 planner + cli/utils.ts export): fee payer and authority the
 * Ledger, a provisory compute-unit limit (removed at export) and a zero compute-unit price, the single-transaction
 * create when it fits, otherwise transfer + Allocate (+ Extend) + one linearly packed Write per transaction +
 * Initialize. Returns the instructions of each exported transaction.
 */
export async function officialPlan(ctx: Pick<InspectContext, "seed" | "metadata" | "programData">, payload: Uint8Array, rent: number): Promise<Instruction[][]> {
  const ledger = createNoopSigner(address(LEDGER))
  const authority = { address: ledger.address, role: AccountRole.READONLY_SIGNER, signer: ledger }
  const writable = (key: string) => ({ address: address(key), role: AccountRole.WRITABLE })
  const readonly = (key: string) => ({ address: address(key), role: AccountRole.READONLY })
  const pmp = (accounts: Instruction["accounts"], data: Buffer): Instruction => ({ programAddress: address(PMP_PROGRAM), accounts, data: new Uint8Array(data) })
  const { metadata: M, programData: PD } = ctx
  const seed = seedBytes(ctx.seed)
  const format = Buffer.from([EXPECTED_FORMAT.encoding, EXPECTED_FORMAT.compression, EXPECTED_FORMAT.format, EXPECTED_FORMAT.dataSource])
  const initialize = (data: Uint8Array | null, system: string) =>
    pmp([writable(M), authority, readonly(PROGRAM_ID), readonly(PD), readonly(system)], Buffer.concat([Buffer.from([PMP_IX.initialize]), seed, format, data ?? Buffer.alloc(0)]))
  const transfer = getTransferSolInstruction({ source: ledger, destination: address(M), amount: BigInt(rent) }) as Instruction
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(
        createTransactionMessage({ version: "legacy" }),
        (m) => setTransactionMessageFeePayerSigner(ledger, m),
        (m) => fillTransactionMessageProvisoryResourceLimits(m),
        (m) => setTransactionMessageComputeUnitPrice(BigInt(0), m),
      ),
  })
  let plan: TransactionPlan | null = null
  try {
    const inline = await planner(sequentialInstructionPlan([transfer, initialize(payload, SYSTEM_PROGRAM)]))
    if (isSingleTransactionPlan(inline)) plan = inline
  } catch {
    plan = null
  }
  if (!plan) {
    const extend = (length: number) => pmp([writable(M), authority, readonly(PROGRAM_ID), readonly(PD)], Buffer.concat([Buffer.from([PMP_IX.extend]), u16(length)]))
    const write = (offset: number, length: number) =>
      pmp([writable(M), authority, readonly(PMP_PROGRAM)], Buffer.concat([Buffer.from([PMP_IX.write]), u32(offset), payload.subarray(offset, offset + length)]))
    plan = await planner(
      sequentialInstructionPlan([
        transfer,
        pmp([writable(M), authority, readonly(PROGRAM_ID), readonly(PD), readonly(SYSTEM_PROGRAM)], Buffer.concat([Buffer.from([PMP_IX.allocate]), seed])),
        ...(HEADER_LEN + payload.length > REALLOC_LIMIT ? [getMessagePackerInstructionPlanFromInstructions(reallocChunks(payload.length).map(extend))] : []),
        parallelInstructionPlan([getLinearMessagePackerInstructionPlan({ totalLength: payload.length, getInstruction: write })]),
        initialize(null, PMP_PROGRAM),
      ]),
    )
  }
  return flattenTransactionPlan(plan).map((single) => [...setTransactionMessageComputeUnitLimit(undefined, single.message).instructions] as Instruction[])
}

/** An unsigned legacy transaction from the Ledger with these instructions and the placeholder blockhash. */
export function encodeLegacy(instructions: Instruction[], feePayer: string = LEDGER, version: "legacy" | 0 = "legacy"): string {
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: PLACEHOLDER_BLOCKHASH, lastValidBlockHeight: BigInt(0) }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  return Buffer.from(getTransactionEncoder().encode(compileTransaction(message))).toString("base64")
}

/**
 * Checks an owner-prepared export (`program-metadata write <seed> … --export <Ledger>`) before anything is
 * signed. It must be exactly the official CLI plan for exactly the reviewed file: the same transactions, in the
 * same order, with identical messages except the blockhash. The rule checks below make every deviation
 * readable: signers and fee payer, programs, accounts, instruction kinds, a strict write partition, the Extend
 * plan, the rent amount and the payload content.
 */
export async function inspectChecks(encoded: string[], ctx: InspectContext): Promise<Check[]> {
  const allowed = new Set([LEDGER, ctx.metadata, PROGRAM_ID, ctx.programData, PMP_PROGRAM, SYSTEM_PROGRAM, COMPUTE_BUDGET])
  const errors: string[] = []
  const versions: string[] = []
  const writes: { tx: number; offset: number; data: Buffer }[] = []
  const extends_: number[] = []
  const transfers: number[] = []
  const shapes: string[] = []
  let allocations = 0
  let initializations = 0
  let initializeData: Buffer | null = null
  let initializeTx = -1
  let unsigned = true
  encoded.forEach((wire, t) => {
    let tx: CompiledTx
    try {
      const decoded = decodeWire(wire)
      unsigned &&= Object.values(decoded.signatures).every((s) => s === null || s.every((b) => b === 0))
      tx = decodeMessage(decoded.messageBytes)
      shapes.push(messageShape(tx))
    } catch (err) {
      errors.push(`#${t + 1}: undecodable (${err instanceof Error ? err.message : err})`)
      shapes.push("undecodable")
      return
    }
    const keys = tx.staticAccounts
    const { numSignerAccounts: signers, numReadonlySignerAccounts: roSigners, numReadonlyNonSignerAccounts: roOthers } = tx.header
    const writable = (i: number) => (i < signers ? i < signers - roSigners : i < keys.length - roOthers)
    if (tx.version !== "legacy") versions.push(`#${t + 1}: ${tx.version}`)
    if (tx.addressTableLookups?.length) errors.push(`#${t + 1}: address lookup tables`)
    if (keys[0] !== LEDGER || signers !== 1) errors.push(`#${t + 1}: fee payer/signers ${keys.slice(0, signers).join(",")} (only ${LEDGER} may sign)`)
    const foreign = keys.filter((key) => !allowed.has(key))
    if (foreign.length) errors.push(`#${t + 1}: unexpected accounts ${foreign.join(",")}`)
    const writableOthers = keys.filter((key, i) => writable(i) && key !== LEDGER && key !== ctx.metadata)
    if (writableOthers.length) errors.push(`#${t + 1}: unexpected writable ${writableOthers.join(",")}`)
    let prices = 0
    let writesHere = 0
    for (const ix of tx.instructions) {
      const program = keys[ix.programAddressIndex]
      const accs = (ix.accountIndices ?? []).map((i) => keys[i])
      const data = Buffer.from(ix.data ?? [])
      const is = (expected: string[]) => accs.length === expected.length && accs.every((a, i) => a === expected[i])
      if (program === COMPUTE_BUDGET) {
        if (data[0] === 3 && data.length === 9 && accs.length === 0) {
          prices++
          if (data.readBigUInt64LE(1) !== BigInt(0)) errors.push(`#${t + 1}: priority fee ${data.readBigUInt64LE(1)} µlamports/CU (use --priority-fees 0)`)
        } else {
          errors.push(`#${t + 1}: compute budget instruction ${data[0]} (the export carries only a zero compute-unit price)`)
        }
      } else if (program === SYSTEM_PROGRAM) {
        if (data.length === 12 && data.readUInt32LE(0) === 2 && is([LEDGER, ctx.metadata])) transfers.push(Number(data.readBigUInt64LE(4)))
        else errors.push(`#${t + 1}: system instruction other than the rent transfer Ledger → metadata`)
      } else if (program === PMP_PROGRAM) {
        const kind = data[0]
        if (kind === PMP_IX.allocate && is([ctx.metadata, LEDGER, PROGRAM_ID, ctx.programData, SYSTEM_PROGRAM]) && data.length === 17 && data.subarray(1).equals(seedBytes(ctx.seed))) {
          allocations++
        } else if (kind === PMP_IX.write && is([ctx.metadata, LEDGER, PMP_PROGRAM]) && data.length > 5) {
          writesHere++
          writes.push({ tx: t, offset: data.readUInt32LE(1), data: data.subarray(5) })
        } else if (kind === PMP_IX.extend && is([ctx.metadata, LEDGER, PROGRAM_ID, ctx.programData]) && data.length === 3) {
          extends_.push(data.readUInt16LE(1))
        } else if (
          kind === PMP_IX.initialize &&
          (is([ctx.metadata, LEDGER, PROGRAM_ID, ctx.programData, SYSTEM_PROGRAM]) || is([ctx.metadata, LEDGER, PROGRAM_ID, ctx.programData, PMP_PROGRAM])) &&
          data.length >= 21 &&
          data.subarray(1, 17).equals(seedBytes(ctx.seed)) &&
          data[17] === EXPECTED_FORMAT.encoding &&
          data[18] === EXPECTED_FORMAT.compression &&
          data[19] === EXPECTED_FORMAT.format &&
          data[20] === EXPECTED_FORMAT.dataSource
        ) {
          initializations++
          initializeTx = t
          if (data.length > 21) initializeData = data.subarray(21)
        } else {
          errors.push(`#${t + 1}: Program Metadata ${PMP_IX_NAMES[kind] ?? kind} with unexpected accounts or data`)
        }
      } else {
        errors.push(`#${t + 1}: unexpected program ${program}`)
      }
    }
    if (prices > 1) errors.push(`#${t + 1}: ${prices} compute-unit price instructions (redundant)`)
    if (writesHere > 1) errors.push(`#${t + 1}: ${writesHere} Write instructions (the official plan packs one per transaction)`)
  })

  // Strict write partition: in transaction order, starting at 0, each write begins where the previous ended.
  const partitionErrors: string[] = []
  let end = 0
  writes.forEach((write, i) => {
    if (write.data.length === 0) partitionErrors.push(`write ${i + 1} is empty`)
    if (i > 0 && write.offset < writes[i - 1].offset) partitionErrors.push(`write ${i + 1} at offset ${write.offset} is out of order (after offset ${writes[i - 1].offset})`)
    else if (write.offset < end) partitionErrors.push(`write ${i + 1} at offset ${write.offset} overlaps or repeats bytes before ${end}`)
    else if (write.offset > end) partitionErrors.push(`write ${i + 1} at offset ${write.offset} leaves a gap after ${end}`)
    end = Math.max(end, write.offset + write.data.length)
  })
  const payload: Buffer | null = initializeData ?? (writes.length && partitionErrors.length === 0 ? Buffer.concat(writes.map((w) => w.data)) : null)
  let content: string | null = null
  try {
    content = payload ? inflateSync(payload).toString("utf8") : null
  } catch {
    content = null
  }
  const size = HEADER_LEN + (payload?.length ?? 0)
  const expectedExtends = payload && !initializeData && size > REALLOC_LIMIT ? reallocChunks(payload.length) : []
  const rent = ctx.expectedRent(size)

  // The exact official plan for this payload, compared message by message (blockhash excluded).
  let planCheck: Check
  if (!payload || content !== ctx.localText) {
    planCheck = { name: "export: exactly the official program-metadata 0.10.0 plan (kit 8.3.0)", ok: false, detail: "not comparable: payload missing or not the reviewed file" }
  } else {
    const expected = (await officialPlan(ctx, payload, rent)).map((instructions) => messageShape(decodeMessage(decodeWire(encodeLegacy(instructions)).messageBytes)))
    const first = expected.findIndex((shape, i) => shape !== shapes[i])
    const same = expected.length === shapes.length && first === -1
    planCheck = {
      name: "export: exactly the official program-metadata 0.10.0 plan (kit 8.3.0): same transactions, same order, identical messages except the blockhash",
      ok: same,
      detail: same ? `${expected.length} transaction(s)` : `expected ${expected.length} transaction(s), got ${shapes.length}${first >= 0 ? `; first difference in #${first + 1}` : ""}`,
    }
  }

  return [
    { name: "export: transactions found", ok: encoded.length > 0, detail: `${encoded.length} transaction(s) = ${encoded.length} Ledger signature(s)` },
    { name: "export: unsigned (nothing was pre-signed)", ok: unsigned },
    { name: "export: legacy messages (--tx-version legacy)", ok: versions.length === 0, detail: versions.join(", ") || undefined },
    { name: `export: only ${LEDGER} signs and pays; only expected programs, accounts and instructions, none redundant`, ok: errors.length === 0, detail: errors.join("; ") || undefined },
    {
      name: "export: writes are one exact partition of the payload in transaction order (no reordered, duplicate, overlapping, gapped or empty write)",
      ok: partitionErrors.length === 0 && (initializeData !== null || writes.length > 0),
      detail: partitionErrors.join("; ") || `${writes.length} write(s)`,
    },
    {
      name: "export: Extend exactly as Program Metadata 0.10.0 plans it (none up to 10,240-byte accounts, else 10,240-byte chunks)",
      ok: extends_.join() === expectedExtends.join(),
      detail: `${extends_.join(",") || "none"} vs ${expectedExtends.join(",") || "none"}`,
    },
    {
      name: `export: creates canonical "${ctx.seed}" metadata ${ctx.metadata} once (Initialize in the last transaction)`,
      ok: initializations === 1 && initializeTx === encoded.length - 1 && (initializeData ? allocations === 0 && writes.length === 0 : allocations === 1),
      detail: `initialize ${initializations}, allocate ${allocations}, writes ${writes.length}, extends ${extends_.length}`,
    },
    {
      name: `export: payload is ${relative(ROOT, METADATA_FILES[ctx.seed])} byte for byte`,
      ok: content === ctx.localText,
      detail: content === null ? "payload missing or not zlib" : `sha256 ${sha256(content)} vs local ${sha256(ctx.localText)}`,
    },
    { name: "export: one rent transfer of exactly the rent for header + payload", ok: transfers.length === 1 && transfers[0] === rent, detail: `${transfers.join(",") || "none"} vs ${rent} (${size} bytes)` },
    planCheck,
  ]
}

// -------------------------------------------------------------------------------------- commands

function parseFlags(argv: string[], allowed: string[]): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {}
  const errors: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (!allowed.includes(argv[i])) errors.push(`unknown argument ${JSON.stringify(argv[i])}`)
    else if (argv[i + 1] === undefined) errors.push(`${argv[i]} has no value`)
    else values[argv[i]] = argv[++i]
  }
  return { values, errors }
}

function seedArg(values: Record<string, string>, errors: string[]): Seed | null {
  const seed = values["--seed"] as Seed
  if (!SEEDS.includes(seed)) {
    errors.push("--seed must be idl or security")
    return null
  }
  if (!existsSync(METADATA_FILES[seed])) errors.push(`${relative(ROOT, METADATA_FILES[seed])} missing`)
  return seed
}

async function planCommand(): Promise<boolean> {
  const checks: Check[] = [...(await programChecks()), ...rejectedIdentityChecks()]
  const [ledger] = await accounts([LEDGER])
  const programData = await programDataAddressOf(PROGRAM_ID)
  let needed = 0
  for (const seed of SEEDS) {
    const file = METADATA_FILES[seed]
    if (!existsSync(file)) {
      checks.push({ name: `${seed}: ${relative(ROOT, file)} present`, ok: false })
      continue
    }
    const text = readFileSync(file, "utf8")
    const pda = await metadataAddress(seed)
    const [onChain] = await accounts([pda])
    const payload = deflateSync(Buffer.from(text, "utf8"))
    const size = HEADER_LEN + payload.length
    const rent = await rentFor(size)
    // The official plan for this payload (node zlib bytes; the CLI's pako bytes can differ slightly in length).
    const transactions = (await officialPlan({ seed, metadata: pda, programData }, payload, rent)).length
    needed += onChain ? 0 : rent + transactions * LAMPORTS_PER_SIGNATURE
    checks.push(
      { name: `${seed}: canonical PDA ${pda}`, ok: true, info: true, detail: onChain ? "EXISTS (an upload would update it)" : "absent (an upload creates it)" },
      { name: `${seed}: payload and rent`, ok: true, info: true, detail: `${Buffer.byteLength(text)} bytes → ${payload.length} zlib; rent ${rent} lamports; ${transactions} transaction(s) = ${transactions} Ledger signature(s)` },
    )
    if (seed === "security") {
      const decisions = securityChecks(text).filter((c) => c.info).map((c) => c.name.replace("security: owner decision — ", ""))
      checks.push({ name: "security: owner decisions still open", ok: true, info: true, detail: decisions.join(", ") || "none" })
    }
  }
  const balance = ledger?.lamports ?? 0
  checks.push({
    name: `Ledger ${LEDGER}: balance covers rent and fees (exported transactions make the Ledger the fee payer)`,
    ok: true,
    info: true,
    detail: `${balance} lamports; needs about ${needed}${balance >= needed ? "" : " — owner funding required before any upload"}`,
  })
  return report(
    "QLC Program Metadata plan (keyless, read-only devnet)",
    checks,
    "Plan only. Uploading is OWNER MUTATION — DO NOT RUN, blocked until PixiMan approves an owner signing path (D1 in the QLC metadata runbook (Notion)).",
  )
}

async function inspectCommand(argv: string[]): Promise<boolean> {
  const { values, errors } = parseFlags(argv, ["--seed", "--file"])
  const seed = seedArg(values, errors)
  if (!values["--file"] || !existsSync(values["--file"])) errors.push("--file <exported transactions> missing")
  const checks: Check[] = errors.map((error) => ({ name: "arguments", ok: false, detail: error }))
  if (seed && checks.length === 0) {
    const [metadata, programData, program] = await Promise.all([metadataAddress(seed), programDataAddressOf(PROGRAM_ID), programChecks()])
    const [onChain] = await accounts([metadata])
    const localText = readFileSync(METADATA_FILES[seed], "utf8")
    const encoded = parseExport(readFileSync(values["--file"], "utf8"))
    // Live rent for every account size the export could create (header + inline or written payload).
    const rents = new Map<number, number>()
    for (const size of exportedSizes(encoded)) rents.set(size, await rentFor(size))
    checks.push(...program, { name: `${seed}: canonical metadata absent (the export creates it)`, ok: onChain === null, detail: onChain ? "exists — an update needs its own review" : "absent" })
    checks.push(...(await inspectChecks(encoded, { seed, metadata, programData, localText, expectedRent: (size) => rents.get(size) ?? -1 })))
  }
  return report(
    "QLC Program Metadata export inspection (keyless; nothing is signed or sent)",
    checks,
    "EXPORT VERIFIED: exactly the official plan for the reviewed file. Signing and sending it is OWNER MUTATION and needs an approved owner signing path (D1) and explicit authorization.",
  )
}

/** Account sizes an export could create (header + inline payload, or header + the end of the written data). */
function exportedSizes(encoded: string[]): number[] {
  const sizes = new Set<number>()
  for (const wire of encoded) {
    try {
      const tx = decodeMessage(decodeWire(wire).messageBytes)
      for (const ix of tx.instructions) {
        if (tx.staticAccounts[ix.programAddressIndex] !== PMP_PROGRAM) continue
        const data = Buffer.from(ix.data ?? [])
        if (data[0] === PMP_IX.initialize && data.length > 21) sizes.add(HEADER_LEN + data.length - 21)
        if (data[0] === PMP_IX.write && data.length > 5) sizes.add(HEADER_LEN + data.readUInt32LE(1) + data.length - 5)
      }
    } catch {
      // Undecodable transactions fail the inspection itself.
    }
  }
  return Array.from(sizes)
}

async function verifyCommand(argv: string[]): Promise<boolean> {
  const { values, errors } = parseFlags(argv, ["--seed"])
  const seed = seedArg(values, errors)
  const checks: Check[] = errors.map((error) => ({ name: "arguments", ok: false, detail: error }))
  if (seed && checks.length === 0) {
    const metadata = await metadataAddress(seed)
    const [account] = await accounts([metadata])
    const localText = readFileSync(METADATA_FILES[seed], "utf8")
    checks.push(...(await programChecks()), { name: `${seed}: canonical PDA`, ok: true, info: true, detail: metadata })
    checks.push(...metadataChecks(seed, account, localText, account ? await rentFor(account.data.length) : 0))
    if (seed === "security") checks.push(...securityChecks(localText).filter((c) => !c.ok))
  }
  return report(
    "QLC Program Metadata verification (keyless, read-only devnet)",
    checks,
    "METADATA VERIFIED: the canonical on-chain metadata is exactly the reviewed local file, managed only by the Ledger upgrade authority.",
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2)
  const commands: Record<string, (argv: string[]) => Promise<boolean> | boolean> = {
    idl: idlCommand,
    security: () => securityCommand(),
    plan: () => planCommand(),
    inspect: inspectCommand,
    verify: verifyCommand,
  }
  if (!commands[command]) {
    console.error("usage: qlc-metadata.ts idl [--check] | security | plan | inspect --seed <seed> --file <export> | verify --seed <seed>")
    process.exit(1)
  }
  Promise.resolve(commands[command](rest))
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
