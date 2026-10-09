// Runs the QLC program tests (LiteSVM) with the owner's test identities. Qelarix tests never generate
// keys: the identities are validated first (present, 64-byte keypair files, not privileged or rejected,
// distinct), then `cargo test -p qelarix-qlc` runs with QLC_TEST_IDENTITIES_DIR passed through. Key
// contents are never printed.
//
//   QLC_TEST_IDENTITIES_DIR=<owner folder> npm run qlc:test
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { ROOT, toolEnv } from "./qlc-build-preflight"
import { missingIdentity, validateTestIdentities, type TestIdentity } from "./test-identities"

const REQUIRED: TestIdentity[] = ["admin", "operator", "mint", "wallet-1", "wallet-2", "wallet-3"]

let missing: TestIdentity[]
try {
  missing = validateTestIdentities(REQUIRED)
} catch (err) {
  console.error(`STOP: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
if (missing.length) {
  for (const name of missing) console.error(`BLOCKED  ${missingIdentity(name)}`)
  console.error("The QLC program tests did not run.")
  process.exit(1)
}

const result = spawnSync("cargo", ["test", "-p", "qelarix-qlc"], { cwd: join(ROOT, "solana"), env: toolEnv(), stdio: "inherit" })
process.exit(result.status ?? 1)
