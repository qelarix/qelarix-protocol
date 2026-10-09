// Canonical QLC program build: keyless preflight, then `anchor build --ignore-keys` with the pinned
// toolchain and SBPF v3, then a guard and key-file re-check, then post-build verification.
//
//   npm run qlc:build
//
// Never use plain `anchor build`: without --ignore-keys Anchor reads, or creates, the program keypair.
// A successful build never authorizes a deploy.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { APPROVED, GUARD, ROOT, guardChecks, runStage, toolEnv } from "./qlc-build-preflight"

function guardFingerprint(): string {
  if (!existsSync(GUARD.path)) return "missing"
  const stat = lstatSync(GUARD.path)
  return `${(stat.mode & 0o777).toString(8)}:${stat.size}:${createHash("sha256").update(readFileSync(GUARD.path)).digest("hex")}`
}

async function main() {
  if (!(await runStage("prebuild"))) process.exit(1)

  const guardBefore = guardFingerprint()
  // Both artifacts must be written by this run; the post-build step records their hashes together.
  const buildStartedAt = Date.now()
  const build = spawnSync("anchor", ["build", "--ignore-keys", "--arch", APPROVED.sbpfArch, "--tools-version", APPROVED.platformTools], {
    cwd: join(ROOT, "solana"),
    env: toolEnv(),
    stdio: "inherit",
  })

  const guardAfter = guardFingerprint()
  const keyFiles = guardChecks().filter((check) => !check.ok)
  if (guardAfter !== guardBefore || keyFiles.length) {
    console.error(`STOP: the guard file or key-file state changed during the build (guard ${guardBefore} → ${guardAfter}).`)
    for (const check of keyFiles) console.error(`FAIL  ${check.name}${check.detail ? `  — ${check.detail}` : ""}`)
    process.exit(1)
  }
  console.log(`Guard unchanged (${guardAfter}); no key file created.`)
  if (build.status !== 0) {
    console.error(`anchor build failed (exit ${build.status ?? build.signal}).`)
    process.exit(1)
  }

  if (!(await runStage("postbuild", { buildStartedAt }))) process.exit(1)
  console.log("Next: npm run qlc:client if the program interface changed, then review. Deploys follow the owner-approved procedure only.")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
