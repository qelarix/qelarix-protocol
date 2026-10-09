// Keyless, read-only, fail-closed checks for the QLC program build and deploy path.
// It never reads a private key or an .env file, never signs and never sends a transaction.
//
//   npm run qlc:build:preflight    before a build (toolchain, devnet, program id, rejected ids, guard file)
//   npm run qlc:build:verify       re-checks the binary and Anchor IDL against the manifest of the last qlc:build
//                                  (only npm run qlc:build records the manifest: binary + IDL hashes of one run)
//   npm run qlc:deploy:readiness   read-only: is the current binary a verified build of the current sources?
//   npm run qlc:cluster:check      cluster safety only; run it immediately before every state-changing step
//
// The per-step deploy gate and the keyless verifier build on these checks: scripts/qlc-deploy-preflight.ts.
//
// Exit code 1 on any failure. A passing result never authorizes a deploy.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

// Version lock. The non-key guard file was audited only for these tool versions (cargo-build-sbf 4.1.0
// generates <program>-keypair.json only when it is missing; Anchor 1.2.0 reads it only without
// --ignore-keys). Changing any value, or installing different tools, requires a new security review.
export const APPROVED = {
  solanaCli: "solana-cli 4.1.2 (src:182084b8;",
  anchorCli: "anchor-cli 1.2.0",
  cargoBuildSbf: "cargo-build-sbf 4.1.0",
  platformTools: "v1.57",
  sbpfArch: "v3",
  sbpfEFlags: 3,
  rustToolchain: "1.99.0",
  anchorTomlSolana: "4.1.2",
  anchorTomlAnchor: "1.2.0",
} as const

export const PROGRAM_ID = "EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa"
export const DEVNET = { rpc: "https://api.devnet.solana.com", genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }
// SBPF v3 is deployable only while this devnet feature is active (agave runtime: max SBPF version = V3).
export const SBPF_V3_FEATURE = "5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC"
// SIMD-0500 disables deployment of SBPF v0, v1 and v2; it does not affect v3 output.
const SIMD_0500_FEATURE = "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g"

// Rejected identities (program 6c8V…iD6E, admin 2XuL…1Ggg, operator 6zRs…83o5), stored as SHA-256 so the
// identities themselves never appear in tracked files.
export const REJECTED_ID_HASHES = new Set([
  "5f2b01446e5718212b4326c60dfad2767751717190a47b63d0aaa5823b56c69a",
  "ea25d8fdf2d4ab7ca7b0872dcefb00a9fa6dcabe3be3746ab8636fc4b8be6d0b",
  "576134efe7c3a4fb02400053bc417664a684dea471521fbb5e19723e0390387b",
])

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOLANA_DIR = join(ROOT, "solana")
const DEPLOY_DIR = join(SOLANA_DIR, "target/deploy")
export const GUARD = {
  path: join(DEPLOY_DIR, "qelarix_qlc-keypair.json"),
  content: "QELARIX_NON_KEY_GUARD_DO_NOT_USE_AS_KEYPAIR\n",
  mode: 0o444,
}
export const PROGRAM_SO = join(DEPLOY_DIR, "qelarix_qlc.so")
const MANIFEST = join(DEPLOY_DIR, "qelarix_qlc.build-manifest.json")
// Locked cluster-safety model: every Qelarix Solana CLI command uses this config (-C) plus --url devnet.
const DEVNET_CLI_CONFIG = join(SOLANA_DIR, "devnet-cli.yml")
const DISABLED_KEYPAIR = "/dev/null/qelarix-default-keypair-disabled.json"
const IDL = join(SOLANA_DIR, "target/idl/qelarix_qlc.json")
const IDL_TYPES = join(SOLANA_DIR, "target/types/qelarix_qlc.ts")
const CLIENT_DIR = join(ROOT, "src/lib/qlc/generated")
const PROGRAM_SOURCES = [
  join(SOLANA_DIR, "programs/qelarix-qlc/src"),
  join(SOLANA_DIR, "programs/qelarix-qlc/Cargo.toml"),
  join(SOLANA_DIR, "Cargo.toml"),
  join(SOLANA_DIR, "Cargo.lock"),
  join(SOLANA_DIR, "Anchor.toml"),
  join(SOLANA_DIR, "rust-toolchain.toml"),
]
// Never scanned: owner-protected folders and dependency or build output trees.
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "ui-cinema-studio", "ui-influencer", "ui-viral-mode"])

/** The pinned toolchain: the audited Agave release first on PATH, so Anchor never switches the installed Solana version. */
export function toolEnv(): NodeJS.ProcessEnv {
  const bin = join(homedir(), ".local/share/solana/install/releases/4.1.2/solana-release/bin")
  return { ...process.env, PATH: [bin, join(homedir(), ".cargo/bin"), process.env.PATH ?? ""].join(":") }
}

export interface Check {
  name: string
  ok: boolean
  detail?: string
  /** Informational lines do not fail the stage. */
  info?: boolean
}

function run(cmd: string, args: string[], cwd = ROOT): string {
  return execFileSync(cmd, args, { cwd, env: toolEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Files under a path, skipping protected and dependency folders and any directory `skipDir` rejects. */
function listFiles(path: string, skipDir: (dir: string) => boolean = () => false): string[] {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return [path]
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => {
      const child = join(path, entry.name)
      if (!entry.isDirectory()) return entry.isFile() ? [child] : []
      return SKIP_DIRS.has(entry.name) || skipDir(child) ? [] : listFiles(child, skipDir)
    })
    .sort()
}

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(DEVNET.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.result === undefined) throw new Error(body.error?.message ?? `${method} failed`)
  return body.result
}

/** Feature account state: missing = not activated, activated_at None = pending, Some(slot) = active. */
export async function featureStatus(id: string): Promise<{ state: "active" | "pending" | "inactive"; slot?: number }> {
  const { value } = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [id, { encoding: "base64" }])
  if (!value) return { state: "inactive" }
  const data = Buffer.from(value.data[0], "base64")
  return data[0] === 1 ? { state: "active", slot: Number(data.readBigUInt64LE(1)) } : { state: "pending" }
}

function toolchainChecks(): Check[] {
  const version = (cmd: string, args: string[]) => {
    try {
      return run(cmd, args)
    } catch {
      return "not found"
    }
  }
  const solana = version("solana", ["--version"])
  const anchor = version("anchor", ["--version"])
  const cargoBuildSbf = version("cargo", ["build-sbf", "--version"]).split("\n")[0]
  const rustToolchains = version("rustup", ["toolchain", "list"])
  const anchorToml = readFileSync(join(SOLANA_DIR, "Anchor.toml"), "utf8")
  const tomlValue = (key: string) => anchorToml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1]
  const archEnv = process.env.ANCHOR_BUILD_SBF_ARCH
  const reviewNote = "toolchain differs from the audited matrix: a new security/tooling review is required"
  return [
    { name: "toolchain: Solana CLI = 4.1.2 (182084b8)", ok: solana.startsWith(APPROVED.solanaCli), detail: solana.startsWith(APPROVED.solanaCli) ? solana : `${solana} — ${reviewNote}` },
    { name: "toolchain: Anchor CLI = 1.2.0", ok: anchor === APPROVED.anchorCli, detail: anchor === APPROVED.anchorCli ? anchor : `${anchor} — ${reviewNote}` },
    { name: "toolchain: cargo-build-sbf = 4.1.0", ok: cargoBuildSbf === APPROVED.cargoBuildSbf, detail: cargoBuildSbf === APPROVED.cargoBuildSbf ? cargoBuildSbf : `${cargoBuildSbf} — ${reviewNote}` },
    {
      name: `toolchain: platform-tools ${APPROVED.platformTools} installed (no download during the build)`,
      ok: existsSync(join(homedir(), ".cache/solana", APPROVED.platformTools, "platform-tools")),
    },
    { name: `toolchain: Rust ${APPROVED.rustToolchain} installed (solana/rust-toolchain.toml)`, ok: rustToolchains.includes(`${APPROVED.rustToolchain}-`) },
    {
      name: "toolchain: Anchor.toml [toolchain] matches the pinned tools (Anchor does not run agave-install)",
      ok: tomlValue("solana_version") === APPROVED.anchorTomlSolana && tomlValue("anchor_version") === APPROVED.anchorTomlAnchor,
      detail: `solana_version ${tomlValue("solana_version")}, anchor_version ${tomlValue("anchor_version")}`,
    },
    { name: "environment: ANCHOR_BUILD_SBF_ARCH unset or v3", ok: archEnv === undefined || archEnv === APPROVED.sbpfArch, detail: archEnv ?? "unset" },
    { name: "environment: RUSTUP_TOOLCHAIN unset (the IDL build installs nothing)", ok: process.env.RUSTUP_TOOLCHAIN === undefined, detail: process.env.RUSTUP_TOOLCHAIN ?? "unset" },
  ]
}

async function devnetChecks(): Promise<Check[]> {
  const checks: Check[] = []
  try {
    const genesis = await rpc<string>("getGenesisHash", [])
    checks.push({ name: "devnet: RPC genesis = devnet", ok: genesis === DEVNET.genesis, detail: `${DEVNET.rpc} → ${genesis}` })
    const version = await rpc<{ "solana-core": string }>("getVersion", [])
    checks.push({ name: "devnet: runtime version", ok: true, info: true, detail: version["solana-core"] })
    const v3 = await featureStatus(SBPF_V3_FEATURE)
    checks.push({
      name: "SBPF gate: devnet accepts SBPF v3 deployments (enable_sbpf_v3_deployment_and_execution active)",
      ok: v3.state === "active",
      detail: v3.state === "active" ? `active since slot ${v3.slot}` : `${v3.state} — BLOCKED`,
    })
    const simd0500 = await featureStatus(SIMD_0500_FEATURE)
    checks.push({ name: "SBPF gate: SIMD-0500 (disables SBPF v0–v2 deployment; v3 unaffected)", ok: true, info: true, detail: simd0500.state })
  } catch (err) {
    checks.push({ name: "devnet: reachable for the SBPF gate", ok: false, detail: `${err instanceof Error ? err.message : err} — BLOCKED (compatibility not proven)` })
  }
  try {
    const config = run("solana", ["config", "get"])
    const url = config.match(/RPC URL:\s*(\S+)/)?.[1] ?? "unknown"
    checks.push({
      name: "environment: global Solana CLI default (never relied upon; Qelarix commands use -C solana/devnet-cli.yml --url devnet)",
      ok: true,
      info: true,
      detail: /mainnet/.test(url) ? `${url} — WARNING: default is mainnet` : url,
    })
  } catch {
    checks.push({ name: "environment: global Solana CLI default", ok: true, info: true, detail: "not readable" })
  }
  return checks
}

function programIdChecks(): Check[] {
  const lib = readFileSync(join(SOLANA_DIR, "programs/qelarix-qlc/src/lib.rs"), "utf8")
  const anchorToml = readFileSync(join(SOLANA_DIR, "Anchor.toml"), "utf8")
  const section = (name: string) => anchorToml.match(new RegExp(`\\[programs\\.${name}\\][^\\[]*?qelarix_qlc\\s*=\\s*"([^"]+)"`))?.[1]
  const idlAddress = existsSync(IDL) ? (JSON.parse(readFileSync(IDL, "utf8")) as { address?: string }).address : undefined
  const clientFiles = listFiles(CLIENT_DIR).filter((file) => file.endsWith(".ts"))
  const clientAddresses = new Set(
    clientFiles.flatMap((file) => Array.from(readFileSync(file, "utf8").matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})" as Address</g), (m) => m[1])),
  )
  // Well-known Solana programs the client references as account defaults; every other address must be ours.
  const wellKnown = new Set([
    "11111111111111111111111111111111",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  ])
  const ownAddresses = Array.from(clientAddresses).filter((address) => !wellKnown.has(address))
  const constant = readFileSync(join(CLIENT_DIR, "programs/qelarixQlc.ts"), "utf8").match(/QELARIX_QLC_PROGRAM_ADDRESS =\s*"([^"]+)"/)?.[1]
  const same = (value: string | undefined) => value === PROGRAM_ID
  return [
    { name: "program id: declare_id!", ok: same(lib.match(/declare_id!\("([^"]+)"\)/)?.[1]) },
    { name: "program id: Anchor.toml [programs.devnet]", ok: same(section("devnet")), detail: section("devnet") },
    { name: "program id: Anchor.toml [programs.localnet]", ok: same(section("localnet")), detail: section("localnet") },
    { name: "program id: IDL address (target/idl)", ok: same(idlAddress), detail: idlAddress ?? "missing" },
    { name: "program id: QELARIX_QLC_PROGRAM_ADDRESS", ok: same(constant), detail: constant },
    {
      name: "program id: every non-system address literal in the generated client",
      ok: ownAddresses.length === 1 && ownAddresses[0] === PROGRAM_ID,
      detail: ownAddresses.join(", "),
    },
  ]
}

export function rejectedIdentityChecks(): Check[] {
  const exclude = Array.from(SKIP_DIRS, (dir) => `:!${dir}`)
  const tracked = run("git", ["ls-files", "-z", "--", ".", ...exclude]).split("\0")
  const untracked = run("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...exclude]).split("\0")
  const isEnvFile = (file: string) => /(^|\/)\.env(\.[^/]*)?$/.test(file) && !file.endsWith(".example")
  const candidates = [...tracked, ...untracked].filter((file) => file && !isEnvFile(file)).map((file) => join(ROOT, file))
  const localArtifacts = [IDL, IDL_TYPES].filter(existsSync)
  const hits: string[] = []
  for (const file of Array.from(new Set(candidates.concat(localArtifacts)))) {
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > 5_000_000) continue
    const text = readFileSync(file, "utf8")
    if (text.includes("\0")) continue
    for (const match of Array.from(text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g))) {
      if (REJECTED_ID_HASHES.has(sha256(match[0]))) hits.push(`${relative(ROOT, file)}: ${match[0].slice(0, 4)}…${match[0].slice(-4)}`)
    }
  }
  return [
    {
      name: "rejected identities: none in tracked/untracked files, IDL or types (.env files and owner folders are never read)",
      ok: hits.length === 0,
      detail: hits.length ? hits.join("; ") : `${candidates.length + localArtifacts.length} files scanned`,
    },
  ]
}

/** File names that would be keys. Detection is by name only, so no key content is ever read. */
function keyFileNames(): string[] {
  // Rust build output is skipped except target/deploy, where build tools place program keypairs.
  const target = join(SOLANA_DIR, "target")
  const skipDir = (dir: string) => dir.startsWith(`${target}/`) && dir !== DEPLOY_DIR && !dir.startsWith(`${DEPLOY_DIR}/`)
  return listFiles(ROOT, skipDir).filter((file) => /(-keypair|-upgrade-buffer)\.json$|(^|\/)id\.json$/.test(file))
}

export function guardChecks(): Check[] {
  const checks: Check[] = []
  const stat = existsSync(GUARD.path) ? lstatSync(GUARD.path) : null
  checks.push({ name: "guard: exists as a regular file (not a symlink)", ok: Boolean(stat?.isFile() && !stat.isSymbolicLink()) })
  if (stat?.isFile()) {
    const content = readFileSync(GUARD.path, "utf8")
    let parsesAsKeypair = false
    try {
      const parsed: unknown = JSON.parse(content)
      parsesAsKeypair = Array.isArray(parsed)
    } catch {
      parsesAsKeypair = false
    }
    checks.push(
      { name: "guard: exact content QELARIX_NON_KEY_GUARD_DO_NOT_USE_AS_KEYPAIR", ok: content === GUARD.content, detail: `${stat.size} bytes, sha256 ${sha256(content)}` },
      { name: "guard: not parseable as a keypair, no byte array", ok: !parsesAsKeypair && !/\[\s*\d+\s*(,\s*\d+\s*){31,}\]/.test(content) },
      { name: "guard: mode 444 (read-only for everyone)", ok: (stat.mode & 0o777) === GUARD.mode, detail: (stat.mode & 0o777).toString(8) },
    )
  }
  const unexpected = keyFileNames().filter((file) => file !== GUARD.path)
  checks.push({
    name: "key files: no *-keypair.json, *-upgrade-buffer.json or id.json other than the guard",
    ok: unexpected.length === 0,
    detail: unexpected.length ? unexpected.map((file) => relative(ROOT, file)).join(", ") : undefined,
  })
  return checks
}

function sourcesDigest(): { digest: string; newest: number } {
  const hash = createHash("sha256")
  let newest = 0
  for (const file of PROGRAM_SOURCES.flatMap((source) => listFiles(source))) {
    hash.update(relative(ROOT, file)).update("\0").update(readFileSync(file)).update("\0")
    newest = Math.max(newest, statSync(file).mtimeMs)
  }
  return { digest: hash.digest("hex"), newest }
}

/** SBPF version from the ELF header (agave/solana-sbpf: e_flags 0..4 = V0..V4). */
function elfInfo(so: Buffer): { valid: boolean; eMachine: number; eFlags: number } {
  const valid = so.length > 64 && so.readUInt32BE(0) === 0x7f454c46 && so[4] === 2 && so[5] === 1
  return { valid, eMachine: valid ? so.readUInt16LE(18) : -1, eFlags: valid ? so.readUInt32LE(48) : -1 }
}

export interface Manifest {
  programId: string
  so: { sha256: string; size: number; builtAt: string }
  /** The Anchor IDL written by the same `npm run qlc:build` run (provenance for the published IDL). */
  idl?: { path: string; sha256: string; size: number; builtAt: string }
  /** The `npm run qlc:build` run that wrote both artifacts. */
  build?: { command: string; startedAt: string }
  sbpf: { eFlags: number; version: string }
  sourcesDigest: string
  toolchain: { solanaCli: string; anchorCli: string; cargoBuildSbf: string; platformTools: string; arch: string }
  devnet: { genesis: string; sbpfV3Feature: string }
  verifiedAt: string
}

export function readManifest(): Manifest | null {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest
  } catch {
    return null
  }
}

/** Is the current binary the verified build of the current sources with the audited toolchain? */
export function artifactChecks(mode: "report" | "require"): Check[] {
  if (!existsSync(PROGRAM_SO)) return [{ name: "artifact: program binary present", ok: mode === "report", info: mode === "report", detail: "missing" }]
  const so = readFileSync(PROGRAM_SO)
  const manifest = readManifest()
  const { digest } = sourcesDigest()
  const verified = manifest !== null && manifest.programId === PROGRAM_ID && manifest.so.sha256 === sha256(so) && manifest.sourcesDigest === digest
  return [
    {
      name: "artifact: current binary is a verified build of the current sources (stale or unverified binaries are never deployable)",
      ok: verified || mode === "report",
      info: mode === "report",
      detail: verified ? `sha256 ${manifest.so.sha256}` : `UNVERIFIED — sha256 ${sha256(so)}; run npm run qlc:build`,
    },
    idlArtifactCheck(manifest, mode),
  ]
}

/** The Anchor IDL is the one the same verified build recorded (hash, not timestamps). */
function idlArtifactCheck(manifest: Manifest | null, mode: "report" | "require"): Check {
  const current = existsSync(IDL) ? sha256(readFileSync(IDL)) : null
  const recorded = manifest?.idl?.sha256
  const ok = Boolean(current && recorded && current === recorded)
  return {
    name: "artifact: Anchor IDL is the one recorded by the same verified build (sha256)",
    ok: ok || mode === "report",
    info: mode === "report",
    detail: ok ? `sha256 ${recorded}` : !current ? "IDL missing" : !recorded ? "no IDL hash in the manifest — run npm run qlc:build" : `MISMATCH — current ${current}, recorded ${recorded}`,
  }
}

/**
 * Checks a finished build. Only `npm run qlc:build` passes `buildStartedAt`: then both the binary and the Anchor
 * IDL must have been written by that run, and the manifest records both hashes. A standalone
 * `npm run qlc:build:verify` re-checks the artifacts against the recorded manifest and never writes it.
 */
function postBuildChecks(devnet: Check[], buildStartedAt?: number): Check[] {
  if (!existsSync(PROGRAM_SO)) return [{ name: "build: program binary present", ok: false, detail: "missing" }]
  if (!existsSync(IDL)) return [{ name: "build: Anchor IDL present", ok: false, detail: relative(ROOT, IDL) }]
  const so = readFileSync(PROGRAM_SO)
  const idl = readFileSync(IDL)
  const stat = statSync(PROGRAM_SO)
  const idlStat = statSync(IDL)
  const { digest, newest } = sourcesDigest()
  const elf = elfInfo(so)
  const idlFresh = idlStat.mtimeMs >= newest
  const checks: Check[] = [
    { name: "build: binary path", ok: true, info: true, detail: relative(ROOT, PROGRAM_SO) },
    { name: "build: binary newer than every program source", ok: stat.mtimeMs > newest, detail: `${stat.mtime.toISOString()} (newest source ${new Date(newest).toISOString()})` },
    { name: "build: IDL newer than every program source", ok: idlFresh },
    { name: "build: valid 64-bit little-endian ELF (SBF)", ok: elf.valid && (elf.eMachine === 247 || elf.eMachine === 263), detail: `e_machine ${elf.eMachine}` },
    { name: `SBPF gate: binary is SBPF ${APPROVED.sbpfArch} (ELF e_flags ${APPROVED.sbpfEFlags})`, ok: elf.eFlags === APPROVED.sbpfEFlags, detail: `e_flags ${elf.eFlags}` },
    { name: "build: sha256 / size", ok: true, info: true, detail: `${sha256(so)} / ${so.length} bytes` },
    { name: "build: Anchor IDL sha256 / size", ok: true, info: true, detail: `${sha256(idl)} / ${idl.length} bytes` },
  ]
  if (buildStartedAt === undefined) {
    // Standalone verification: the artifacts must still be the ones the last qlc:build recorded.
    const manifest = readManifest()
    checks.push({
      name: "build: binary and Anchor IDL are the ones recorded by the last npm run qlc:build",
      ok: manifest?.so.sha256 === sha256(so) && manifest.idl?.sha256 === sha256(idl) && manifest.sourcesDigest === digest,
      detail: manifest?.idl ? undefined : "no IDL hash recorded — run npm run qlc:build",
    })
    return checks
  }
  // 1 s tolerance for file-system timestamp granularity.
  const since = buildStartedAt - 1_000
  checks.push(
    { name: "build: binary written by this build run", ok: stat.mtimeMs >= since, detail: stat.mtime.toISOString() },
    { name: "build: Anchor IDL written by this build run", ok: idlStat.mtimeMs >= since, detail: idlStat.mtime.toISOString() },
  )
  if (checks.every((check) => check.ok) && devnet.every((check) => check.ok)) {
    const manifest: Manifest = {
      programId: PROGRAM_ID,
      so: { sha256: sha256(so), size: so.length, builtAt: stat.mtime.toISOString() },
      idl: { path: relative(ROOT, IDL), sha256: sha256(idl), size: idl.length, builtAt: idlStat.mtime.toISOString() },
      build: { command: "npm run qlc:build", startedAt: new Date(buildStartedAt).toISOString() },
      sbpf: { eFlags: elf.eFlags, version: `v${elf.eFlags}` },
      sourcesDigest: digest,
      toolchain: { solanaCli: APPROVED.solanaCli, anchorCli: APPROVED.anchorCli, cargoBuildSbf: APPROVED.cargoBuildSbf, platformTools: APPROVED.platformTools, arch: APPROVED.sbpfArch },
      devnet: { genesis: DEVNET.genesis, sbpfV3Feature: SBPF_V3_FEATURE },
      verifiedAt: new Date().toISOString(),
    }
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
    checks.push({ name: "build: manifest recorded", ok: true, info: true, detail: relative(ROOT, MANIFEST) })
  }
  return checks
}

/** The dedicated devnet CLI config, no usable default signer, and devnet genesis both through the config and with --url devnet. */
function clusterChecks(): Check[] {
  const text = existsSync(DEVNET_CLI_CONFIG) ? readFileSync(DEVNET_CLI_CONFIG, "utf8") : ""
  const field = (key: string) => text.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, "m"))?.[1]
  const cli = (args: string[]) => {
    try {
      return { ok: true, out: run("solana", ["-C", DEVNET_CLI_CONFIG, ...args]) }
    } catch {
      return { ok: false, out: "" }
    }
  }
  // A missing or mistyped -C file makes the CLI fall back to its default config (mainnet), so the config's
  // RPC is queried only when the file exists and points at devnet.
  const configIsDevnet = field("json_rpc_url") === DEVNET.rpc
  const config = cli(["config", "get"])
  const viaConfig = configIsDevnet ? cli(["genesis-hash"]) : { ok: false, out: "" }
  const viaFlag = cli(["genesis-hash", "--url", "devnet"])
  const signer = cli(["address"])
  let globalKeypair = "unknown"
  try {
    globalKeypair = run("solana", ["config", "get"]).match(/Keypair Path:\s*(\S+)/)?.[1] ?? "unknown"
  } catch {
    globalKeypair = "unknown"
  }
  return [
    { name: "cluster: solana/devnet-cli.yml points at devnet", ok: field("json_rpc_url") === DEVNET.rpc, detail: field("json_rpc_url") ?? "missing" },
    { name: "cluster: its default keypair path is the disabled sentinel", ok: field("keypair_path") === DISABLED_KEYPAIR, detail: field("keypair_path") ?? "missing" },
    { name: "cluster: the sentinel can never exist (/dev/null is not a directory)", ok: !existsSync(DISABLED_KEYPAIR) && !statSync("/dev/null").isDirectory() },
    {
      name: "cluster: Solana CLI reads the dedicated config as devnet with the disabled keypair",
      ok: config.ok && config.out.includes(`RPC URL: ${DEVNET.rpc}`) && config.out.includes(`Keypair Path: ${DISABLED_KEYPAIR}`),
    },
    { name: "cluster: devnet genesis through the dedicated config", ok: viaConfig.out === DEVNET.genesis, detail: viaConfig.out || "unreachable — BLOCKED" },
    { name: "cluster: devnet genesis with explicit --url devnet", ok: viaFlag.out === DEVNET.genesis, detail: viaFlag.out || "unreachable — BLOCKED" },
    {
      name: "cluster: no default signer (a command without an explicit signer fails)",
      ok: !signer.ok,
      detail: signer.ok ? `a default signer resolved to ${signer.out} — STOP` : "no default signer",
    },
    { name: "cluster: ~/.config/solana/id.json absent (existence check only)", ok: !existsSync(join(homedir(), ".config/solana/id.json")) },
    {
      name: "cluster: global CLI default keypair path is not usable (existence check only)",
      ok: globalKeypair !== "unknown" && !existsSync(globalKeypair),
      detail: globalKeypair,
    },
  ]
}

export type Stage = "prebuild" | "postbuild" | "readiness" | "cluster"

/** Audited toolchain, live devnet SBPF gate, program id, no rejected ids, guard file, verified binary and cluster safety. */
export async function readinessChecks(): Promise<Check[]> {
  const devnet = await devnetChecks()
  return [...toolchainChecks(), ...devnet, ...programIdChecks(), ...rejectedIdentityChecks(), ...guardChecks(), ...artifactChecks("require"), ...clusterChecks()]
}

/** Prints every check; false (after a BLOCKED line) when any failed. */
export function report(title: string, checks: Check[], passed: string): boolean {
  console.log(title)
  for (const check of checks) {
    const label = check.info ? "INFO" : check.ok ? "PASS" : "FAIL"
    console.log(`${label}  ${check.name}${check.detail ? `  — ${check.detail}` : ""}`)
  }
  const failed = checks.filter((check) => !check.ok)
  if (failed.length) {
    console.log(`BLOCKED: ${failed.length} check(s) failed. Nothing may be built or deployed until they pass.`)
    return false
  }
  console.log(passed)
  return true
}

export async function runStage(stage: Stage, options: { buildStartedAt?: number } = {}): Promise<boolean> {
  let checks: Check[]
  if (stage === "readiness") checks = await readinessChecks()
  else if (stage === "cluster") checks = clusterChecks()
  else {
    const devnet = await devnetChecks()
    checks = [...toolchainChecks(), ...devnet, ...programIdChecks(), ...rejectedIdentityChecks(), ...guardChecks()]
    checks.push(...(stage === "prebuild" ? artifactChecks("report") : postBuildChecks(devnet, options.buildStartedAt)))
  }
  const passed = {
    prebuild: "Preflight passed. This does not authorize a deploy.",
    postbuild: "Build verification passed. This does not authorize a deploy.",
    readiness: "VERIFIED BUILD: ready for owner review only. A deploy still requires the owner-approved deploy procedure and explicit authorization.",
    cluster: "Cluster check passed: devnet only, no default signer. It authorizes nothing; run it immediately before every state-changing step.",
  }
  return report(`QLC ${stage} checks (program ${PROGRAM_ID})`, checks, passed[stage])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stageArg = process.argv[process.argv.indexOf("--stage") + 1] as Stage
  if (!["prebuild", "postbuild", "readiness", "cluster"].includes(stageArg)) {
    console.error("--stage must be prebuild, postbuild, readiness or cluster")
    process.exit(1)
  }
  runStage(stageArg)
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
