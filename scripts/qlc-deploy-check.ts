// Offline checks for the QLC devnet deploy gate and keyless verifier (scripts/qlc-deploy-preflight.ts):
// every fail-closed rule is exercised against synthetic devnet snapshots, and the canonical command lines
// are checked for their mandatory flags and against the runbook. No network, no keys, no chain; signer
// sources are plain path strings that are never opened.
//
//   npm run check:qlc-deploy
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { address, getAddressEncoder } from "@solana/kit"
import { DEVNET, REJECTED_ID_HASHES, ROOT, sha256, type Check } from "./qlc-build-preflight"
import {
  DEPLOY_IDENTITIES,
  bufferChecks,
  canonicalCommands,
  deployedChecks,
  inputChecks,
  lamportsNeeded,
  programDataAddressOf,
  shellChecks,
  stateChecks,
  type Account,
  type Binary,
  type ChainState,
  type Input,
  type Step,
} from "./qlc-deploy-preflight"

const { programId: P, upgradeAuthority: L, feePayer: F, buffer: B } = DEPLOY_IDENTITIES
const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111"
const SYSTEM_PROGRAM = "11111111111111111111111111111111"
const TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
// Valid addresses with no Qelarix role.
const STRANGER = "Stake11111111111111111111111111111111111111"
const OTHER = "Vote111111111111111111111111111111111111111"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
const failedNames = (checks: Check[]) => checks.filter((c) => !c.ok).map((c) => c.name)
function expectPass(name: string, checks: Check[]) {
  const failed = failedNames(checks)
  check(name, failed.length === 0, failed.join("; "))
}
function expectFail(name: string, checks: Check[], fragment: string) {
  const failed = failedNames(checks)
  check(`fails closed: ${name}`, failed.some((n) => n.includes(fragment)), failed.length ? `blocked by: ${failed.join("; ")}` : "nothing failed")
}

// Synthetic binary and accounts in the loader v3 layouts.
const SIZE = 2_500
const bytes = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 31 + 7) % 251))
const binary: Binary = { sha256: sha256(bytes), size: SIZE, bytes }
const tampered = Buffer.from(bytes)
tampered[SIZE - 1] ^= 0xff
const rent = (size: number) => (size + 128) * 6_960
const key = (value: string) => Buffer.from(getAddressEncoder().encode(address(value)))
const wallet = (lamports: number): Account => ({ lamports, owner: SYSTEM_PROGRAM, executable: false, data: Buffer.alloc(0) })
function bufferAccount(authority: string | null, program: Buffer = bytes): Account {
  const header = Buffer.alloc(37)
  header.writeUInt32LE(1, 0)
  if (authority) {
    header[4] = 1
    key(authority).copy(header, 5)
  }
  return { lamports: rent(37 + program.length), owner: LOADER_V3, executable: false, data: Buffer.concat([header, program]) }
}
function programAccount(programData: string): Account {
  const data = Buffer.alloc(36)
  data.writeUInt32LE(2, 0)
  key(programData).copy(data, 4)
  return { lamports: rent(36), owner: LOADER_V3, executable: true, data }
}
function programDataAccount(authority: string | null, program: Buffer = bytes): Account {
  const header = Buffer.alloc(45)
  header.writeUInt32LE(3, 0)
  header.writeBigUInt64LE(BigInt(470_000_000), 4)
  if (authority) {
    header[12] = 1
    key(authority).copy(header, 13)
  }
  return { lamports: rent(45 + program.length), owner: LOADER_V3, executable: false, data: Buffer.concat([header, program]) }
}

async function main() {
  const programDataAddress = await programDataAddressOf(P)
  const fresh: ChainState = {
    genesis: DEVNET.genesis,
    sbpfV3: "active",
    rent: { buffer: rent(37 + SIZE), programData: rent(45 + SIZE), program: rent(36) },
    programDataAddress,
    program: null,
    programData: null,
    buffer: null,
    feePayer: wallet(3_000_000_000),
    programHistory: 0,
  }
  const at = (overrides: Partial<ChainState>): ChainState => ({ ...fresh, ...overrides })
  const written = at({ buffer: bufferAccount(F) })
  const handedOff = at({ buffer: bufferAccount(L) })
  const deployed = at({
    program: programAccount(programDataAddress),
    programData: programDataAccount(L),
    programHistory: 1,
    feePayer: wallet(3_000_000_000 - rent(36) - rent(45 + SIZE) - 2_085_000),
    parsed: { programData: programDataAddress, authority: L },
  })

  console.log("— explicit inputs")
  const all: Record<Input, string> = { programId: P, upgradeAuthority: L, feePayer: F, buffer: B, bufferAuthority: F }
  const inputsFor = (step: Step, overrides: Partial<Record<Input, string>> = {}) => {
    const needed: Record<Step, Input[]> = {
      write: ["feePayer", "buffer"],
      resume: ["feePayer", "buffer"],
      handoff: ["feePayer", "buffer", "upgradeAuthority"],
      deploy: ["programId", "upgradeAuthority", "feePayer", "buffer"],
      close: ["feePayer", "buffer", "bufferAuthority"],
    }
    return { ...Object.fromEntries(needed[step].map((input) => [input, all[input]])), ...overrides } as Partial<Record<Input, string>>
  }
  for (const step of ["write", "resume", "handoff", "deploy", "close"] as Step[]) expectPass(`step ${step}: approved explicit inputs accepted`, inputChecks(step, inputsFor(step)))
  expectPass("step close: Ledger as buffer authority accepted", inputChecks("close", inputsFor("close", { bufferAuthority: L })))
  const withoutProgramId = inputsFor("deploy")
  delete withoutProgramId.programId
  expectFail("deploy without --program-id (no random program id fallback)", inputChecks("deploy", withoutProgramId), "--program-id")
  expectFail("deploy with an unresolved --program-id (empty)", inputChecks("deploy", inputsFor("deploy", { programId: "" })), "--program-id")
  expectFail("deploy with a wrong --program-id", inputChecks("deploy", inputsFor("deploy", { programId: STRANGER })), "--program-id")
  expectFail("deploy with the fee payer key as --program-id", inputChecks("deploy", inputsFor("deploy", { programId: F })), "--program-id")
  const withoutAuthority = inputsFor("deploy")
  delete withoutAuthority.upgradeAuthority
  expectFail("deploy without --upgrade-authority", inputChecks("deploy", withoutAuthority), "--upgrade-authority")
  expectFail("deploy with a wrong Ledger account (wrong key index)", inputChecks("deploy", inputsFor("deploy", { upgradeAuthority: OTHER })), "--upgrade-authority")
  expectFail("deploy with the CLI signer as upgrade authority", inputChecks("deploy", inputsFor("deploy", { upgradeAuthority: F })), "--upgrade-authority")
  const withoutPayer = inputsFor("deploy")
  delete withoutPayer.feePayer
  expectFail("deploy without an explicit fee payer", inputChecks("deploy", withoutPayer), "--fee-payer")
  expectFail("write with a wrong fee payer", inputChecks("write", inputsFor("write", { feePayer: STRANGER })), "--fee-payer")
  const withoutBuffer = inputsFor("deploy")
  delete withoutBuffer.buffer
  expectFail("deploy without an explicit buffer", inputChecks("deploy", withoutBuffer), "--buffer")
  expectFail("write with a wrong buffer key", inputChecks("write", inputsFor("write", { buffer: STRANGER })), "--buffer")
  expectFail("close with a third party as buffer authority", inputChecks("close", inputsFor("close", { bufferAuthority: STRANGER })), "--buffer-authority")
  expectFail("an input the step does not use", inputChecks("write", inputsFor("write", { programId: P })), "only the inputs")
  // Rejected identities are stored only as hashes; prove the refusal path with a temporarily rejected address.
  REJECTED_ID_HASHES.add(sha256(STRANGER))
  const rejected = inputChecks("deploy", inputsFor("deploy", { programId: STRANGER }))
  check("fails closed: rejected identity as --program-id is reported as REJECTED", rejected.some((c) => !c.ok && c.detail?.includes("REJECTED")))
  expectFail("buffer authority is a rejected identity", bufferChecks(at({ buffer: bufferAccount(STRANGER) }), binary, STRANGER, true), "not a rejected identity")
  REJECTED_ID_HASHES.delete(sha256(STRANGER))

  console.log("— owner shell")
  const env = { QLC_CLI_SIGNER: "/owner/keys/cli-signer.json", QLC_BUFFER_KEYPAIR: "/owner/keys/buffer.json", QLC_PROGRAM_KEYPAIR: "/owner/keys/program.json", QLC_LEDGER_URI: "usb://ledger?key=0" }
  const tools = { solana: "solana-cli 4.1.2 (src:182084b8; feat:c763ae0a, client:Agave)", keygen: "solana-keygen 4.1.2 (src:182084b8; feat:c763ae0a, client:Agave)" }
  for (const step of ["write", "resume", "handoff", "deploy", "close"] as Step[]) expectPass(`step ${step}: owner shell accepted`, shellChecks(step, env, ROOT, tools, F))
  expectPass("Ledger URI forms usb://ledger and usb://ledger?key=1/0 accepted", [
    ...shellChecks("deploy", { ...env, QLC_LEDGER_URI: "usb://ledger" }, ROOT, tools),
    ...shellChecks("deploy", { ...env, QLC_LEDGER_URI: "usb://ledger?key=1/0" }, ROOT, tools),
  ])
  expectFail("program key source not set", shellChecks("deploy", { ...env, QLC_PROGRAM_KEYPAIR: undefined }, ROOT, tools), "QLC_PROGRAM_KEYPAIR")
  expectFail("CLI signer source is a relative path", shellChecks("write", { ...env, QLC_CLI_SIGNER: "keys/cli.json" }, ROOT, tools), "QLC_CLI_SIGNER")
  expectFail("buffer key source inside the repository", shellChecks("write", { ...env, QLC_BUFFER_KEYPAIR: join(ROOT, "solana/target/deploy/x.json") }, ROOT, tools), "QLC_BUFFER_KEYPAIR")
  expectFail("key source in a repository folder named ..keys", shellChecks("deploy", { ...env, QLC_PROGRAM_KEYPAIR: join(ROOT, "..keys/program.json") }, ROOT, tools), "QLC_PROGRAM_KEYPAIR")
  expectPass("key source in a sibling folder of the repository", shellChecks("deploy", { ...env, QLC_PROGRAM_KEYPAIR: join(ROOT, "../ai-platforma-keys/program.json") }, ROOT, tools))
  expectFail("Ledger URI with a pubkey path (resolves the device base key)", shellChecks("deploy", { ...env, QLC_LEDGER_URI: `usb://ledger/${L}?key=0` }, ROOT, tools), "QLC_LEDGER_URI")
  expectFail("upgrade authority source is a key file, not the Ledger", shellChecks("deploy", { ...env, QLC_LEDGER_URI: "/owner/keys/admin.json" }, ROOT, tools), "QLC_LEDGER_URI")
  expectFail("close by the Ledger without QLC_LEDGER_URI", shellChecks("close", { ...env, QLC_LEDGER_URI: undefined }, ROOT, tools, L), "QLC_LEDGER_URI")
  expectFail("an older Solana CLI on the owner's PATH", shellChecks("deploy", env, ROOT, { ...tools, solana: "solana-cli 3.1.10 (src:00000000; feat:0, client:Agave)" }), "solana on PATH")
  expectFail("solana-keygen missing from PATH", shellChecks("deploy", env, ROOT, { ...tools, keygen: "not found" }), "solana-keygen on PATH")
  expectFail("commands not run from the repository root (-C would fall back)", shellChecks("deploy", env, join(ROOT, "solana"), tools), "repository root")

  console.log("— devnet state per step")
  expectPass("step write: fresh state accepted", stateChecks("write", fresh, binary))
  expectPass("step resume: partly written buffer accepted", stateChecks("resume", at({ buffer: bufferAccount(F, Buffer.concat([bytes.subarray(0, 972), Buffer.alloc(SIZE - 972)])) }), binary))
  expectPass("step handoff: complete buffer under the CLI signer accepted", stateChecks("handoff", written, binary))
  expectPass("step deploy: complete buffer under the Ledger accepted", stateChecks("deploy", handedOff, binary))
  expectPass("step close: buffer under the Ledger accepted", stateChecks("close", handedOff, binary, L))
  expectFail("wrong cluster (testnet genesis)", stateChecks("deploy", at({ ...handedOff, genesis: TESTNET_GENESIS }), binary), "genesis")
  expectFail("wrong cluster (mainnet genesis)", stateChecks("write", at({ genesis: MAINNET_GENESIS }), binary), "genesis")
  expectFail("SBPF v3 no longer accepted on devnet", stateChecks("deploy", at({ ...handedOff, sbpfV3: "inactive" }), binary), "SBPF")
  expectFail("program address already funded", stateChecks("write", at({ program: wallet(1_000_000) }), binary), "holds no account")
  expectFail("program address already deployed", stateChecks("deploy", at({ ...handedOff, program: programAccount(programDataAddress) }), binary), "holds no account")
  expectFail("program address has transaction history", stateChecks("deploy", at({ ...handedOff, programHistory: 1 }), binary), "never used")
  expectFail("ProgramData address already exists", stateChecks("deploy", at({ ...handedOff, programData: programDataAccount(L) }), binary), "ProgramData address")
  expectFail("fresh write while the buffer already exists", stateChecks("write", written, binary), "absent (the fresh write")
  expectFail("resume with the buffer missing", stateChecks("resume", fresh, binary), "upgradeable-loader buffer")
  expectFail("buffer account not owned by the loader", stateChecks("handoff", at({ buffer: wallet(5_000_000) }), binary), "upgradeable-loader buffer")
  expectFail("handoff of an incomplete buffer", stateChecks("handoff", at({ buffer: bufferAccount(F, Buffer.alloc(SIZE)) }), binary), "bytes = verified local binary")
  expectFail("handoff after the buffer is already the Ledger's", stateChecks("handoff", handedOff, binary), "buffer: authority")
  expectFail("deploy before the handoff (buffer authority = CLI signer)", stateChecks("deploy", written, binary), "buffer: authority")
  expectFail("deploy from an immutable buffer", stateChecks("deploy", at({ buffer: bufferAccount(null) }), binary), "buffer: authority")
  expectFail("buffer bytes differ from the manifest hash", stateChecks("deploy", at({ buffer: bufferAccount(L, tampered) }), binary), "bytes = verified local binary")
  expectFail("buffer larger than the binary (--max-len padding)", stateChecks("deploy", at({ buffer: bufferAccount(L, Buffer.concat([bytes, Buffer.alloc(100)])) }), binary), "exactly")
  expectFail("close with the wrong authority", stateChecks("close", handedOff, binary, F), "buffer: authority")
  expectFail("fee payer unfunded", stateChecks("write", at({ feePayer: null }), binary), "balance covers")
  expectFail("fee payer one lamport short", stateChecks("write", at({ feePayer: wallet(lamportsNeeded("write", fresh, binary) - 1) }), binary), "balance covers")
  expectFail("fee payer is not a system wallet", stateChecks("write", at({ feePayer: { ...wallet(3_000_000_000), owner: LOADER_V3 } }), binary), "system-owned")
  check(
    "funding need: write = buffer rent + every fee + net ProgramData and program rent",
    lamportsNeeded("write", fresh, binary) === rent(37 + SIZE) + 10_000 + 5_000 * Math.ceil(SIZE / 972) + 5_000 + rent(36) + 15_000 + (rent(45 + SIZE) - rent(37 + SIZE)),
    `${lamportsNeeded("write", fresh, binary)}`,
  )

  console.log("— keyless post-deploy verifier")
  expectPass("deployed program accepted", deployedChecks(deployed, binary))
  expectPass("spend reconciliation accepted", deployedChecks(deployed, binary, 3_000_000_000))
  expectFail("wrong cluster (testnet genesis)", deployedChecks(at({ ...deployed, genesis: TESTNET_GENESIS }), binary), "genesis")
  expectFail("program never deployed at the fixed id", deployedChecks(at({ ...deployed, program: null }), binary), "owned by the upgradeable loader")
  expectFail("program account not executable", deployedChecks(at({ ...deployed, program: { ...programAccount(programDataAddress), executable: false } }), binary), "executable")
  expectFail("program linked to another ProgramData", deployedChecks(at({ ...deployed, program: programAccount(STRANGER) }), binary), "derived ProgramData")
  expectFail("upgrade authority left with the CLI signer", deployedChecks(at({ ...deployed, programData: programDataAccount(F) }), binary), "upgrade authority = ")
  expectFail("program made immutable (--final)", deployedChecks(at({ ...deployed, programData: programDataAccount(null) }), binary), "upgrade authority = ")
  expectFail("third-party upgrade authority", deployedChecks(at({ ...deployed, programData: programDataAccount(STRANGER) }), binary), "upgrade authority = ")
  expectFail("deployed bytes differ from the manifest hash", deployedChecks(at({ ...deployed, programData: programDataAccount(L, tampered) }), binary), "sha256 = safe-build manifest")
  expectFail("ProgramData padded beyond the binary (--max-len)", deployedChecks(at({ ...deployed, programData: programDataAccount(L, Buffer.concat([bytes, Buffer.alloc(64)])) }), binary), "exactly")
  expectFail("RPC jsonParsed disagrees on the authority", deployedChecks(at({ ...deployed, parsed: { programData: programDataAddress, authority: F } }), binary), "jsonParsed")
  expectFail("buffer still open after the deploy", deployedChecks(at({ ...deployed, buffer: bufferAccount(L) }), binary), "closed by the deploy")
  expectFail("fee payer balance rose during the deploy", deployedChecks(deployed, binary, 1_000_000_000), "spend since step 4")
  expectFail("fee payer spent more than rent + fee allowance", deployedChecks(deployed, binary, 3_100_000_000), "spend since step 4")

  console.log("— canonical command lines")
  const commands = canonicalCommands()
  const text = commands.map((c) => c.command).join("\n")
  const lines = commands.map((c) => c.command.replace(/\\\n/g, " "))
  const mutating = lines.filter((line) => /program (write-buffer|set-buffer-authority|deploy|close)\b/.test(line))
  check("every Solana CLI command uses -C solana/devnet-cli.yml and --url devnet", lines.filter((l) => l.includes("solana -C")).every((l) => l.includes("solana -C solana/devnet-cli.yml") && /--url devnet(\s|$)/.test(l)))
  check("no Solana CLI command without -C", lines.every((l) => !/(^|&& )solana (?!-C)/.test(l)))
  check("every state-changing command runs only after its step preflight (&&)", mutating.length === 6 && mutating.every((l) => /^npm run -s qlc:deploy:preflight -- --step \w+ .*&& solana -C/.test(l)), `${mutating.length} state-changing lines`)
  check("every state-changing command names the default signer explicitly (-k)", mutating.every((l) => l.includes('-k "${QLC_CLI_SIGNER:?}"')))
  check("every signer source is guarded with :? (unset or empty aborts the line)", (text.match(/\$\{QLC_[A-Z_]+/g) ?? []).length === (text.match(/\$\{QLC_[A-Z_]+:\?\}/g) ?? []).length)
  const deploy = mutating.find((l) => l.includes("program deploy")) ?? ""
  const deployCli = deploy.slice(deploy.indexOf("&& solana"))
  check("deploy: --program-id is the owner's program key file", deployCli.includes('--program-id "${QLC_PROGRAM_KEYPAIR:?}"'))
  check("deploy: --upgrade-authority is the Ledger", deployCli.includes('--upgrade-authority "${QLC_LEDGER_URI:?}"'))
  check("deploy: explicit fee payer and buffer", deployCli.includes('--fee-payer "${QLC_CLI_SIGNER:?}"') && deployCli.includes(`--buffer ${B}`))
  check("deploy: deploys from the verified buffer only (no .so path, so the Ledger signs no writes)", !/program deploy\s+\S*\.so/.test(deployCli))
  check("deploy: preflight resolves all four identities", ["--program-id", "--upgrade-authority", "--fee-payer", "--buffer"].every((flag) => deploy.slice(0, deploy.indexOf("&&")).includes(flag)))
  check("no --final, --max-len, --skip-* or --use-tpu-client flags", !/--final|--max-len|--skip-|--use-tpu-client/.test(text))
  check("no key creation, airdrop or transfer commands", !/solana-keygen (new|grind|recover)|airdrop|transfer/.test(text))
  check("handoff sets the buffer authority to the owner Ledger only", lines.some((l) => l.includes(`set-buffer-authority ${B}`) && l.includes(`--new-buffer-authority ${L}`)))
  check("buffer close refunds the CLI signer only", lines.filter((l) => l.includes("program close")).every((l) => l.includes(`--recipient ${F}`)))
  const runbook = readFileSync(join(ROOT, "docs/qlc-devnet-deploy.md"), "utf8")
  const missing = commands.filter((c) => !runbook.includes("```bash\n" + c.command + "\n```")).map((c) => c.step)
  check("runbook step 4 carries every canonical command verbatim in its own block", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "")

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll QLC deploy gate checks passed")
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
