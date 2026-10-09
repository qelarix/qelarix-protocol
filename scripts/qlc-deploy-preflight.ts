// Keyless, read-only, fail-closed gate for every state-changing step of the QLC devnet program deploy, plus
// the keyless verifier for the deploy buffer and the deployed program. It never reads a private key, never
// talks to a hardware wallet, never signs and never sends a transaction.
//
// The canonical command lines (docs/qlc-devnet-deploy.md, step 4; printed by `plan`) resolve the owner's
// signer files and Ledger to public addresses with the owner's own `solana-keygen pubkey`, pass only those
// public addresses here, and run the Solana CLI command after `&&` only when this gate passes.
//
//   npm run qlc:deploy:plan                                       live rent/cost and the exact command lines
//   npm run -s qlc:deploy:preflight -- --step <step> <inputs>     gate for one step (write, resume, handoff, deploy, close)
//   npm run qlc:deploy:verify -- --buffer-authority <address>     keyless buffer verification
//   npm run qlc:deploy:verify -- --deployed [--fee-payer-before <lamports>]   keyless post-deploy verification
//
// Exit code 1 on any failure. A passing result authorizes nothing by itself.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit"
import {
  APPROVED,
  DEVNET,
  PROGRAM_ID,
  PROGRAM_SO,
  REJECTED_ID_HASHES,
  ROOT,
  SBPF_V3_FEATURE,
  artifactChecks,
  featureStatus,
  readManifest,
  readinessChecks,
  rejectedIdentityChecks,
  report,
  rpc,
  sha256,
  type Check,
} from "./qlc-build-preflight"

// Owner-created public identities for the devnet deploy. Changing any of them requires owner approval.
export const DEPLOY_IDENTITIES = {
  programId: PROGRAM_ID, // program deploy key (owner key file): fixes the program id at the first deploy
  upgradeAuthority: "B2sGhW5He2nT5zMYSoYRxrvwKdhdthphYT3G6zaUqNoG", // owner Ledger: upgrade authority
  feePayer: "GJPDitCMWnH3bPYFUJRWwyXdXmErBhwrS5EoYz6JZwmz", // Deploy_CLI_Signer_DEV: fee payer + temporary buffer authority
  buffer: "6k4gTKg6hLDHfL1y9YWbJsSQm18KE9kMHyYzmT8RxB8j", // owner deploy buffer
} as const
const { programId: P, upgradeAuthority: L, feePayer: F, buffer: B } = DEPLOY_IDENTITIES

const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111"
const SYSTEM_PROGRAM = "11111111111111111111111111111111"
// Loader v3 account layouts (bincode UpgradeableLoaderState): Buffer = u32 1 + Option<Pubkey> (37 bytes),
// Program = u32 2 + Pubkey (36), ProgramData = u32 3 + u64 slot + Option<Pubkey> (45).
const BUFFER_HEADER = 37
const PROGRAM_SIZE = 36
const PROGRAMDATA_HEADER = 45
// Bytes per write transaction: cli/src/program.rs calculate_max_chunk_size for a one-signer Write with the
// simulated compute-unit-limit instruction (1232 − 259 − 1).
const WRITE_CHUNK = 972
const LAMPORTS_PER_SIGNATURE = 5_000 // devnet base fee; the canonical commands set no priority fee
const SIGNATURES = { create: 2, write: 1, handoff: 1, deploy: 3 }
// Allowance for retried writes when the verifier reconciles the fee payer's spend.
const FEE_TOLERANCE = 50_000_000
// The Solana CLI resolves usb://ledger/<pubkey> by the device's base key, not by the account, so only the
// account-index form is accepted.
const LEDGER_URI = /^usb:\/\/ledger(\?key=\d+'?(\/\d+'?)?)?$/

export const STEPS = ["write", "resume", "handoff", "deploy", "close"] as const
export type Step = (typeof STEPS)[number]
export type Input = "programId" | "upgradeAuthority" | "feePayer" | "buffer" | "bufferAuthority"
const FLAGS: Record<Input, string> = {
  programId: "--program-id",
  upgradeAuthority: "--upgrade-authority",
  feePayer: "--fee-payer",
  buffer: "--buffer",
  bufferAuthority: "--buffer-authority",
}
// The explicit public inputs each step's command uses (all required) and the owner's signer sources it reads.
const STEP_INPUTS: Record<Step, Input[]> = {
  write: ["feePayer", "buffer"],
  resume: ["feePayer", "buffer"],
  handoff: ["feePayer", "buffer", "upgradeAuthority"],
  deploy: ["programId", "upgradeAuthority", "feePayer", "buffer"],
  close: ["feePayer", "buffer", "bufferAuthority"],
}
const STEP_SOURCES: Record<Step, string[]> = {
  write: ["QLC_CLI_SIGNER", "QLC_BUFFER_KEYPAIR"],
  resume: ["QLC_CLI_SIGNER"],
  handoff: ["QLC_CLI_SIGNER", "QLC_LEDGER_URI"],
  deploy: ["QLC_CLI_SIGNER", "QLC_PROGRAM_KEYPAIR", "QLC_LEDGER_URI"],
  close: ["QLC_CLI_SIGNER"],
}

export interface Account {
  lamports: number
  owner: string
  executable: boolean
  data: Buffer
}

/** One read-only devnet snapshot; every account comes from the same getMultipleAccounts call. */
export interface ChainState {
  genesis: string
  sbpfV3: string
  rent: { buffer: number; programData: number; program: number }
  programDataAddress: string
  program: Account | null
  programData: Account | null
  buffer: Account | null
  feePayer: Account | null
  /** Transactions that ever touched the program address (0 or 1; limit 1). */
  programHistory: number
  /** The RPC's own jsonParsed decoding, an independent cross-check for the post-deploy verifier. */
  parsed?: { programData?: string; authority?: string | null }
}

/** The verified local binary: manifest hash and size plus the bytes. */
export interface Binary {
  sha256: string
  size: number
  bytes: Buffer
}

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`
const isRejected = (value: string) => REJECTED_ID_HASHES.has(sha256(value))
const pubkeyAt = (data: Buffer, offset: number) => getAddressDecoder().decode(data.subarray(offset, offset + 32))
const fee = (signatures: number) => signatures * LAMPORTS_PER_SIGNATURE
const chunks = (size: number) => Math.ceil(size / WRITE_CHUNK)

function bufferState(account: Account | null): { authority: string | null; program: Buffer } | null {
  if (!account || account.owner !== LOADER_V3 || account.data.length < BUFFER_HEADER || account.data.readUInt32LE(0) !== 1) return null
  return { authority: account.data[4] === 1 ? pubkeyAt(account.data, 5) : null, program: account.data.subarray(BUFFER_HEADER) }
}

function programDataState(account: Account | null): { slot: number; authority: string | null; program: Buffer } | null {
  if (!account || account.owner !== LOADER_V3 || account.data.length < PROGRAMDATA_HEADER || account.data.readUInt32LE(0) !== 3) return null
  return {
    slot: Number(account.data.readBigUInt64LE(4)),
    authority: account.data[12] === 1 ? pubkeyAt(account.data, 13) : null,
    program: account.data.subarray(PROGRAMDATA_HEADER),
  }
}

/** Write transactions the CLI would still send: chunks whose bytes differ from the local binary. */
function pendingChunks(program: Buffer, binary: Binary): number {
  let pending = 0
  for (let offset = 0; offset < binary.size; offset += WRITE_CHUNK) {
    const end = Math.min(offset + WRITE_CHUNK, binary.size)
    if (!binary.bytes.subarray(offset, end).equals(program.subarray(offset, end))) pending++
  }
  return pending
}

/** Lamports the fee payer must hold for this step and every later step of the deploy. */
export function lamportsNeeded(step: Step, chain: ChainState, binary: Binary, bufferAuthority?: string): number {
  const bufferLamports = chain.buffer?.lamports ?? chain.rent.buffer
  const deploy = chain.rent.program + fee(SIGNATURES.deploy) + Math.max(0, chain.rent.programData - bufferLamports)
  const state = bufferState(chain.buffer)
  const pending = state && state.program.length === binary.size ? pendingChunks(state.program, binary) : chunks(binary.size)
  switch (step) {
    case "write":
      return chain.rent.buffer + fee(SIGNATURES.create) + fee(SIGNATURES.write) * chunks(binary.size) + fee(SIGNATURES.handoff) + deploy
    case "resume":
      return fee(SIGNATURES.write) * pending + fee(SIGNATURES.handoff) + deploy
    case "handoff":
      return fee(SIGNATURES.handoff) + deploy
    case "deploy":
      return deploy
    case "close":
      return fee(bufferAuthority === L ? 2 : 1)
  }
}

/** Every input the step's command uses is given explicitly, resolves to the approved identity and is not rejected. */
export function inputChecks(step: Step, inputs: Partial<Record<Input, string>>): Check[] {
  const checks: Check[] = []
  for (const input of STEP_INPUTS[step]) {
    const value = inputs[input]
    const approved: string[] = input === "bufferAuthority" ? [F, L] : [DEPLOY_IDENTITIES[input]]
    const name = `input: ${FLAGS[input]} explicit and = ${input === "bufferAuthority" ? `${F} (CLI signer) or ${L} (Ledger)` : approved[0]}`
    if (!value) checks.push({ name, ok: false, detail: "missing or empty — the signer source did not resolve" })
    else if (isRejected(value)) checks.push({ name, ok: false, detail: `${short(value)} is a REJECTED identity — STOP` })
    else checks.push({ name, ok: approved.includes(value), detail: approved.includes(value) ? value : `${value} is not the approved identity — STOP` })
  }
  const unexpected = (Object.keys(inputs) as Input[]).filter((input) => !STEP_INPUTS[step].includes(input))
  if (unexpected.length) {
    checks.push({ name: `input: only the inputs step ${step} uses`, ok: false, detail: `unexpected ${unexpected.map((input) => FLAGS[input]).join(", ")}` })
  }
  return checks
}

/**
 * The owner's shell: signer sources set in the expected form (key file paths are inspected as strings only,
 * never opened or listed), the audited CLI on PATH, and the repository root as working directory.
 */
export function shellChecks(step: Step, env: Record<string, string | undefined>, cwd: string, tools: { solana: string; keygen: string }, bufferAuthority?: string): Check[] {
  const sources = step === "close" && bufferAuthority === L ? [...STEP_SOURCES.close, "QLC_LEDGER_URI"] : STEP_SOURCES[step]
  const checks: Check[] = sources.map((name) => {
    const value = env[name] ?? ""
    if (name === "QLC_LEDGER_URI") {
      return {
        name: "signer source: QLC_LEDGER_URI is usb://ledger or usb://ledger?key=<account>[/<change>] (never usb://ledger/<pubkey>)",
        ok: LEDGER_URI.test(value),
        detail: value || "not set",
      }
    }
    const fromRoot = relative(ROOT, resolve(value))
    const inside = Boolean(value) && fromRoot !== ".." && !fromRoot.startsWith("../") && !isAbsolute(fromRoot)
    return {
      name: `signer source: ${name} is an absolute key file path outside the repository (path string only)`,
      ok: isAbsolute(value) && !inside,
      detail: !value ? "not set" : !isAbsolute(value) ? "not an absolute path" : inside ? "inside the repository — STOP" : "set",
    }
  })
  const keygen = "solana-keygen 4.1.2 (src:182084b8;"
  checks.push(
    { name: "owner shell: solana on PATH is the audited 4.1.2 (182084b8)", ok: tools.solana.startsWith(APPROVED.solanaCli), detail: tools.solana },
    { name: "owner shell: solana-keygen on PATH is 4.1.2 (182084b8)", ok: tools.keygen.startsWith(keygen), detail: tools.keygen },
    {
      name: "owner shell: commands run from the repository root (-C solana/devnet-cli.yml and the binary path resolve)",
      ok: resolve(cwd) === resolve(ROOT),
      detail: resolve(cwd) === resolve(ROOT) ? undefined : cwd,
    },
  )
  return checks
}

/** The deploy buffer: loader-owned, expected authority, exact size, rent-exempt and (when required) complete. */
export function bufferChecks(chain: ChainState, binary: Binary, authority: string | undefined, requireComplete: boolean): Check[] {
  const state = bufferState(chain.buffer)
  const program = state?.program
  const sized = program?.length === binary.size
  const pending = program && sized ? pendingChunks(program, binary) : undefined
  const complete = Boolean(program && sized && sha256(program) === binary.sha256)
  const total = chunks(binary.size)
  return [
    {
      name: `buffer: ${B} is an upgradeable-loader buffer account`,
      ok: state !== null,
      detail: chain.buffer ? (state ? `${chain.buffer.lamports} lamports` : `owner ${chain.buffer.owner}, not a loader buffer`) : "absent",
    },
    {
      name: `buffer: authority = ${authority ?? "(not given)"}`,
      ok: Boolean(state && authority && state.authority === authority),
      detail: state ? (state.authority ?? "none (immutable)") : undefined,
    },
    { name: "buffer: authority is not a rejected identity", ok: !state?.authority || !isRejected(state.authority) },
    { name: `buffer: program area is exactly ${binary.size} bytes (no --max-len, no padding)`, ok: sized, detail: program ? `${program.length} bytes` : undefined },
    requireComplete
      ? {
          name: `buffer: bytes = verified local binary (sha256 ${binary.sha256})`,
          ok: complete,
          detail: program ? `sha256 ${sha256(program)}${pending ? ` — ${pending} of ${total} chunks differ` : ""}` : undefined,
        }
      : { name: "buffer: write progress", ok: true, info: true, detail: pending === undefined ? "unknown" : `${total - pending} of ${total} chunks match${complete ? " — complete" : ""}` },
    {
      name: "buffer: rent-exempt",
      ok: Boolean(chain.buffer && chain.buffer.lamports >= chain.rent.buffer),
      detail: chain.buffer ? `${chain.buffer.lamports} ≥ ${chain.rent.buffer}` : undefined,
    },
  ]
}

/** On-chain state required before the step's command may run. */
export function stateChecks(step: Step, chain: ChainState, binary: Binary, bufferAuthority?: string): Check[] {
  const checks: Check[] = [{ name: "devnet: genesis of the RPC that served the account snapshot", ok: chain.genesis === DEVNET.genesis, detail: chain.genesis }]
  if (step !== "close") {
    checks.push(
      { name: "SBPF gate: devnet still accepts SBPF v3 deployments", ok: chain.sbpfV3 === "active", detail: chain.sbpfV3 },
      {
        name: `first deploy: program address ${P} holds no account (unfunded; the deploy creates it)`,
        ok: chain.program === null,
        detail: chain.program ? `exists: ${chain.program.lamports} lamports, owner ${chain.program.owner} — STOP` : "absent",
      },
      {
        name: "first deploy: program address never used (no transaction history)",
        ok: chain.programHistory === 0,
        detail: chain.programHistory ? "has transaction history — owner review required" : "none",
      },
      {
        name: `first deploy: ProgramData address ${chain.programDataAddress} absent`,
        ok: chain.programData === null,
        detail: chain.programData ? "exists — STOP" : "absent",
      },
    )
  }
  if (step === "write") {
    checks.push({
      name: `buffer: ${B} absent (the fresh write creates it)`,
      ok: chain.buffer === null,
      detail: chain.buffer ? "exists — use --step resume, or close it first" : "absent",
    })
  } else {
    const authority = { resume: F, handoff: F, deploy: L, close: bufferAuthority }[step]
    checks.push(...bufferChecks(chain, binary, authority, step === "handoff" || step === "deploy"))
  }
  const payer = chain.feePayer
  const need = lamportsNeeded(step, chain, binary, bufferAuthority)
  checks.push(
    {
      name: `fee payer: ${F} is a system-owned wallet account`,
      ok: Boolean(payer && payer.owner === SYSTEM_PROGRAM && !payer.executable && payer.data.length === 0),
      detail: payer ? `${payer.lamports} lamports` : "absent (0 SOL)",
    },
    {
      name: `fee payer: balance covers step ${step} and every later step`,
      ok: (payer?.lamports ?? 0) >= need,
      detail: `${payer?.lamports ?? 0} ≥ ${need} lamports${(payer?.lamports ?? 0) >= need ? "" : " — BLOCKED: owner funding required"}`,
    },
  )
  if (step === "write") {
    checks.push({ name: "fee payer: record this balance for the post-deploy verifier", ok: true, info: true, detail: `export QLC_FEE_PAYER_BEFORE=${payer?.lamports ?? 0}` })
  }
  return checks
}

/** The deployed program: loader-owned, ProgramData relationship, Ledger authority, exact bytes, buffer closed. */
export function deployedChecks(chain: ChainState, binary: Binary, feePayerBefore?: number): Check[] {
  const program = chain.program
  const linked = program && program.owner === LOADER_V3 && program.data.length === PROGRAM_SIZE && program.data.readUInt32LE(0) === 2 ? pubkeyAt(program.data, 4) : null
  const programData = programDataState(chain.programData)
  const deployed = programData?.program
  const checks: Check[] = [
    { name: "devnet: genesis of the RPC that served the account snapshot", ok: chain.genesis === DEVNET.genesis, detail: chain.genesis },
    { name: `program: ${P} owned by the upgradeable loader`, ok: program?.owner === LOADER_V3, detail: program ? program.owner : "absent" },
    { name: "program: executable", ok: program?.executable === true },
    { name: `program: state Program → derived ProgramData ${chain.programDataAddress}`, ok: linked === chain.programDataAddress, detail: linked ?? undefined },
    { name: "program: rent-exempt", ok: Boolean(program && program.lamports >= chain.rent.program), detail: program ? `${program.lamports} ≥ ${chain.rent.program}` : undefined },
    { name: "ProgramData: upgradeable-loader ProgramData account", ok: programData !== null, detail: programData ? `deployed in slot ${programData.slot}` : "absent" },
    { name: `ProgramData: upgrade authority = ${L} (owner Ledger)`, ok: programData?.authority === L, detail: programData ? (programData.authority ?? "none (immutable)") : undefined },
    {
      name: "ProgramData: upgrade authority is neither the CLI signer nor a rejected identity",
      ok: Boolean(programData?.authority && programData.authority !== F && !isRejected(programData.authority)),
    },
    { name: `ProgramData: program area is exactly ${binary.size} bytes`, ok: deployed?.length === binary.size, detail: deployed ? `${deployed.length} bytes` : undefined },
    {
      name: `deployed bytes: sha256 = safe-build manifest ${binary.sha256}`,
      ok: Boolean(deployed && deployed.length === binary.size && sha256(deployed) === binary.sha256),
      detail: deployed ? `sha256 ${sha256(deployed)}` : undefined,
    },
    {
      name: "ProgramData: rent-exempt",
      ok: Boolean(chain.programData && chain.programData.lamports >= chain.rent.programData),
      detail: chain.programData ? `${chain.programData.lamports} ≥ ${chain.rent.programData}` : undefined,
    },
  ]
  if (chain.parsed) {
    checks.push(
      { name: "RPC jsonParsed: program → ProgramData address matches", ok: chain.parsed.programData === chain.programDataAddress, detail: chain.parsed.programData },
      { name: "RPC jsonParsed: ProgramData authority = owner Ledger", ok: chain.parsed.authority === L, detail: chain.parsed.authority ?? "none" },
    )
  }
  checks.push({
    name: `buffer: ${B} closed by the deploy (its lamports went to the fee payer)`,
    ok: chain.buffer === null,
    detail: chain.buffer ? `still open with ${chain.buffer.lamports} lamports — close it (step 10)` : "closed",
  })
  const balance = chain.feePayer?.lamports ?? 0
  checks.push({ name: `fee payer: ${F} balance`, ok: true, info: true, detail: `${balance} lamports` })
  if (feePayerBefore !== undefined) {
    const locked = (program?.lamports ?? 0) + (chain.programData?.lamports ?? 0)
    const fees = feePayerBefore - balance - locked
    checks.push({
      name: "fee payer: spend since step 4 = locked program rent + transaction fees (buffer rent refunded)",
      ok: fees >= 0 && fees <= FEE_TOLERANCE,
      detail: `spent ${feePayerBefore - balance} = locked ${locked} + fees ${fees}${fees < 0 ? " — the balance rose; unexplained funds" : fees > FEE_TOLERANCE ? " — exceeds the retry allowance; owner review" : ""}`,
    })
  }
  return checks
}

export async function programDataAddressOf(programId: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(LOADER_V3), seeds: [getAddressEncoder().encode(address(programId))] })
  return pda
}

type RpcAccount = { lamports: number; owner: string; executable: boolean; data: [string, string] } | null
type ParsedAccount = { data: { parsed?: { info?: { programData?: string; authority?: string | null } } } } | null

/** One devnet snapshot (confirmed commitment, the same as the CLI config). */
export async function chainState(binarySize: number, withParsed = false): Promise<ChainState> {
  const programDataAddress = await programDataAddressOf(P)
  const confirmed = { commitment: "confirmed" }
  const [genesis, v3, rentBuffer, rentProgramData, rentProgram, history, accounts, parsed] = await Promise.all([
    rpc<string>("getGenesisHash", []),
    featureStatus(SBPF_V3_FEATURE),
    rpc<number>("getMinimumBalanceForRentExemption", [BUFFER_HEADER + binarySize, confirmed]),
    rpc<number>("getMinimumBalanceForRentExemption", [PROGRAMDATA_HEADER + binarySize, confirmed]),
    rpc<number>("getMinimumBalanceForRentExemption", [PROGRAM_SIZE, confirmed]),
    rpc<unknown[]>("getSignaturesForAddress", [P, { limit: 1, ...confirmed }]),
    rpc<{ value: RpcAccount[] }>("getMultipleAccounts", [[P, programDataAddress, B, F], { encoding: "base64", ...confirmed }]),
    withParsed ? rpc<{ value: ParsedAccount[] }>("getMultipleAccounts", [[P, programDataAddress], { encoding: "jsonParsed", ...confirmed }]) : null,
  ])
  const [program, programData, buffer, feePayer] = accounts.value.map((value) =>
    value ? { lamports: value.lamports, owner: value.owner, executable: value.executable, data: Buffer.from(value.data[0], "base64") } : null,
  )
  return {
    genesis,
    sbpfV3: v3.state,
    rent: { buffer: rentBuffer, programData: rentProgramData, program: rentProgram },
    programDataAddress,
    program,
    programData,
    buffer,
    feePayer,
    programHistory: history.length,
    parsed: parsed
      ? { programData: parsed.value[0]?.data.parsed?.info?.programData, authority: parsed.value[1]?.data.parsed?.info?.authority ?? null }
      : undefined,
  }
}

function localBinary(): Binary | null {
  const manifest = readManifest()
  if (!manifest || !existsSync(PROGRAM_SO)) return null
  return { sha256: manifest.so.sha256, size: manifest.so.size, bytes: readFileSync(PROGRAM_SO) }
}

function ownerTools(): { solana: string; keygen: string } {
  const version = (cmd: string) => {
    try {
      // The owner's own PATH: the CLI that the command after && will run.
      return execFileSync(cmd, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    } catch {
      return "not found"
    }
  }
  return { solana: version("solana"), keygen: version("solana-keygen") }
}

/** Strict flag parser: unknown, repeated or value-less flags are errors; an empty value stays "" and fails later. */
function parseArgs(argv: string[], allowed: string[], switches: string[] = []): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {}
  const errors: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!allowed.includes(flag) && !switches.includes(flag)) errors.push(`unknown argument ${JSON.stringify(flag)}`)
    else if (flag in values) errors.push(`${flag} given more than once`)
    else if (switches.includes(flag)) values[flag] = "true"
    else if (argv[i + 1] === undefined) errors.push(`${flag} has no value`)
    else values[flag] = argv[++i]
  }
  return { values, errors }
}

async function snapshot(checks: Check[], binary: Binary | null, withParsed = false): Promise<ChainState | null> {
  if (!binary) {
    checks.push({ name: "artifact: verified binary and manifest present", ok: false, detail: "missing — run npm run qlc:build" })
    return null
  }
  try {
    return await chainState(binary.size, withParsed)
  } catch (err) {
    checks.push({ name: "devnet: account snapshot readable", ok: false, detail: `${err instanceof Error ? err.message : err} — BLOCKED` })
    return null
  }
}

async function preflight(argv: string[]): Promise<boolean> {
  const { values, errors } = parseArgs(argv, ["--step", ...Object.values(FLAGS)])
  const step = values["--step"] as Step
  if (!STEPS.includes(step)) {
    console.error(`--step must be one of ${STEPS.join(", ")}`)
    return false
  }
  const inputs: Partial<Record<Input, string>> = {}
  for (const [input, flag] of Object.entries(FLAGS) as [Input, string][]) if (flag in values) inputs[input] = values[flag]
  const checks: Check[] = [
    ...errors.map((error) => ({ name: "arguments", ok: false, detail: error })),
    ...inputChecks(step, inputs),
    ...shellChecks(step, process.env, process.env.INIT_CWD ?? process.cwd(), ownerTools(), inputs.bufferAuthority),
    ...(await readinessChecks()),
  ]
  const binary = localBinary()
  const chain = await snapshot(checks, binary)
  if (chain && binary) checks.push(...stateChecks(step, chain, binary, inputs.bufferAuthority))
  return report(
    `QLC devnet deploy preflight — step ${step} (keyless: nothing is read from a key, signed or sent)`,
    checks,
    `Step ${step} preflight passed. Only the command after && in the same canonical line may run now; this result authorizes nothing else.`,
  )
}

async function verify(argv: string[]): Promise<boolean> {
  const { values, errors } = parseArgs(argv, ["--buffer-authority", "--fee-payer-before"], ["--deployed"])
  const deployed = values["--deployed"] === "true"
  const authority = values["--buffer-authority"]
  const before = values["--fee-payer-before"]
  if (deployed === (authority !== undefined)) errors.push("give exactly one of --deployed or --buffer-authority <address>")
  if (before !== undefined && (!deployed || !/^\d+$/.test(before))) errors.push("--fee-payer-before takes a lamport amount and needs --deployed")
  const checks: Check[] = errors.map((error) => ({ name: "arguments", ok: false, detail: error }))
  if (authority !== undefined) {
    checks.push({
      name: `input: --buffer-authority = ${F} (before the handoff) or ${L} (after)`,
      ok: authority === F || authority === L,
      detail: !authority ? "missing" : isRejected(authority) ? `${short(authority)} is a REJECTED identity — STOP` : authority,
    })
  }
  checks.push(...artifactChecks("require"), ...rejectedIdentityChecks())
  const binary = localBinary()
  const chain = await snapshot(checks, binary, deployed)
  if (chain && binary) {
    if (deployed) checks.push(...deployedChecks(chain, binary, before === undefined ? undefined : Number(before)))
    else checks.push({ name: "devnet: genesis of the RPC that served the account snapshot", ok: chain.genesis === DEVNET.genesis, detail: chain.genesis }, ...bufferChecks(chain, binary, authority, true))
  }
  return report(
    `QLC devnet ${deployed ? "post-deploy" : "buffer"} verification (keyless, read-only)`,
    checks,
    deployed
      ? "DEPLOYED PROGRAM VERIFIED: program id, ProgramData, Ledger upgrade authority and bytes match the safe build; the buffer is closed."
      : "BUFFER VERIFIED: the buffer holds exactly the safe-build binary under the expected authority.",
  )
}

async function plan(): Promise<boolean> {
  const checks: Check[] = [...artifactChecks("require")]
  const binary = localBinary()
  const chain = await snapshot(checks, binary)
  if (chain) checks.push({ name: "devnet: genesis of the RPC that served rent and balances", ok: chain.genesis === DEVNET.genesis, detail: chain.genesis })
  const ok = report("QLC devnet deploy plan (keyless, read-only: live devnet rent, nothing is signed or sent)", checks, "Plan inputs verified.")
  if (!ok || !chain || !binary) return false
  const writes = chunks(binary.size)
  const fees = fee(SIGNATURES.create) + fee(SIGNATURES.write) * writes + fee(SIGNATURES.handoff) + fee(SIGNATURES.deploy)
  const total = lamportsNeeded("write", chain, binary)
  const sol = (lamports: number) => (lamports / 1e9).toFixed(9).replace(/0+$/, "")
  const fund = Math.ceil((total + FEE_TOLERANCE) / 1e8) / 10
  console.log(`
Binary          ${binary.size} bytes, sha256 ${binary.sha256}
Buffer rent     ${chain.rent.buffer} lamports (${BUFFER_HEADER + binary.size} bytes) — refunded to the fee payer by the deploy
ProgramData     ${chain.rent.programData} lamports (${PROGRAMDATA_HEADER + binary.size} bytes) — locked while the program exists
Program account ${chain.rent.program} lamports (${PROGRAM_SIZE} bytes) — locked while the program exists
Writes          ${writes} transactions of up to ${WRITE_CHUNK} bytes
Fees            ${fees} lamports (${LAMPORTS_PER_SIGNATURE}/signature, no priority fee: create ${fee(SIGNATURES.create)}, writes ${fee(SIGNATURES.write) * writes}, handoff ${fee(SIGNATURES.handoff)}, deploy ${fee(SIGNATURES.deploy)})
Total           ${total} lamports (${sol(total)} SOL) net from the fee payer ${F}
Funding         ${fund} SOL just in time (total + ${sol(FEE_TOLERANCE)} SOL allowance for retried writes)
Fee payer now   ${chain.feePayer?.lamports ?? 0} lamports
Program address ${chain.program ? "EXISTS — STOP" : "absent"}; ProgramData ${chain.programData ? "EXISTS — STOP" : "absent"}; buffer ${chain.buffer ? "exists" : "absent"}

Canonical command lines (docs/qlc-devnet-deploy.md, step 4), one command per line group:`)
  for (const { step, title, command } of canonicalCommands()) console.log(`\n[${step}] ${title}\n${command}`)
  return true
}

export interface CanonicalCommand {
  step: string
  title: string
  command: string
}

/** The exact owner command lines; docs/qlc-devnet-deploy.md step 4 carries each one verbatim in its own block. */
export function canonicalCommands(): CanonicalCommand[] {
  const cli = "solana -C solana/devnet-cli.yml program"
  const resolved = (source: string) => `"$(solana-keygen pubkey "\${${source}:?}")"`
  const signer = '"${QLC_CLI_SIGNER:?}"'
  const gate = (step: Step, ...inputs: string[]) => [`npm run -s qlc:deploy:preflight -- --step ${step}`, ...inputs].join(" \\\n  ")
  const line = (...parts: string[]) => parts.join(" \\\n")
  return [
    {
      step: "4a",
      title: "Fresh buffer write (buffer absent)",
      command: line(
        gate("write", `--fee-payer ${resolved("QLC_CLI_SIGNER")}`, `--buffer ${resolved("QLC_BUFFER_KEYPAIR")}`),
        `&& ${cli} write-buffer solana/target/deploy/qelarix_qlc.so`,
        `  -k ${signer} --fee-payer ${signer}`,
        `  --buffer "\${QLC_BUFFER_KEYPAIR:?}" --buffer-authority ${signer}`,
        "  --url devnet",
      ),
    },
    {
      step: "4b",
      title: "Resume an interrupted write (buffer exists, authority = CLI signer)",
      command: line(
        gate("resume", `--fee-payer ${resolved("QLC_CLI_SIGNER")}`, `--buffer ${B}`),
        `&& ${cli} write-buffer solana/target/deploy/qelarix_qlc.so`,
        `  -k ${signer} --fee-payer ${signer}`,
        `  --buffer ${B} --buffer-authority ${signer}`,
        "  --url devnet",
      ),
    },
    {
      step: "5",
      title: "Hand the complete buffer to the Ledger upgrade authority",
      command: line(
        gate("handoff", `--fee-payer ${resolved("QLC_CLI_SIGNER")}`, `--buffer ${B}`, `--upgrade-authority ${resolved("QLC_LEDGER_URI")}`),
        `&& ${cli} set-buffer-authority ${B}`,
        `  -k ${signer} --buffer-authority ${signer}`,
        `  --new-buffer-authority ${L}`,
        "  --url devnet",
      ),
    },
    { step: "6", title: "Keyless buffer verification", command: `npm run qlc:deploy:verify -- --buffer-authority ${L}` },
    {
      step: "7",
      title: "Final deploy with the fixed program id, signed by the Ledger",
      command: line(
        gate(
          "deploy",
          `--program-id ${resolved("QLC_PROGRAM_KEYPAIR")}`,
          `--upgrade-authority ${resolved("QLC_LEDGER_URI")}`,
          `--fee-payer ${resolved("QLC_CLI_SIGNER")}`,
          `--buffer ${B}`,
        ),
        `&& ${cli} deploy`,
        `  --program-id "\${QLC_PROGRAM_KEYPAIR:?}"`,
        `  --upgrade-authority "\${QLC_LEDGER_URI:?}"`,
        `  -k ${signer} --fee-payer ${signer}`,
        `  --buffer ${B}`,
        "  --url devnet",
      ),
    },
    {
      step: "8",
      title: "Keyless post-deploy verification: ProgramData authority (8), deployed bytes (9), buffer closed and spend (10)",
      command: `npm run qlc:deploy:verify -- --deployed --fee-payer-before "\${QLC_FEE_PAYER_BEFORE:?}"`,
    },
    {
      step: "9",
      title: "Independent bytecode cross-check: both hashes must equal the manifest sha256",
      command: line(`${cli} dump ${P} /tmp/qelarix_qlc.devnet.so --url devnet`, "&& shasum -a 256 /tmp/qelarix_qlc.devnet.so solana/target/deploy/qelarix_qlc.so"),
    },
    {
      step: "10a",
      title: "Abandon path only, before the handoff: close the buffer, refund the CLI signer",
      command: line(
        gate("close", `--fee-payer ${resolved("QLC_CLI_SIGNER")}`, `--buffer ${B}`, `--buffer-authority ${resolved("QLC_CLI_SIGNER")}`),
        `&& ${cli} close ${B}`,
        `  -k ${signer} --authority ${signer}`,
        `  --recipient ${F}`,
        "  --url devnet",
      ),
    },
    {
      step: "10b",
      title: "Abandon path only, after the handoff: close the buffer with the Ledger, refund the CLI signer",
      command: line(
        gate("close", `--fee-payer ${resolved("QLC_CLI_SIGNER")}`, `--buffer ${B}`, `--buffer-authority ${resolved("QLC_LEDGER_URI")}`),
        `&& ${cli} close ${B}`,
        `  -k ${signer} --authority "\${QLC_LEDGER_URI:?}"`,
        `  --recipient ${F}`,
        "  --url devnet",
      ),
    },
  ]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2)
  const commands: Record<string, (argv: string[]) => Promise<boolean>> = { plan: () => plan(), preflight, verify }
  if (!commands[command]) {
    console.error("usage: qlc-deploy-preflight.ts plan | preflight --step <step> … | verify (--buffer-authority <address> | --deployed [--fee-payer-before <lamports>])")
    process.exit(1)
  }
  commands[command](rest)
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
