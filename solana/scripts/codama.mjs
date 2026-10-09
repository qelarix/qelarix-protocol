// Generates the TypeScript (@solana/kit) client for the QLC program from the Anchor IDL into
// src/lib/qlc/generated. Run after `anchor build`:  npm run qlc:client
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createFromRoot } from "codama"
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor"
import { renderVisitor } from "@codama/renderers-js"

const appDir = fileURLToPath(new URL("../..", import.meta.url))
const generated = join(appDir, "src/lib/qlc/generated")
const idl = JSON.parse(readFileSync(new URL("../target/idl/qelarix_qlc.json", import.meta.url), "utf8"))

rmSync(generated, { recursive: true, force: true })
await createFromRoot(rootNodeFromAnchor(idl)).accept(
  renderVisitor(join(appDir, "src/lib/qlc"), {
    generatedFolder: "generated",
    deleteFolderBeforeRendering: false,
    syncPackageJson: false,
    kitImportStrategy: "rootOnly",
    formatCode: true,
  }),
)

// Generated code is not hand-maintained; keep it out of lint.
function markGenerated(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) markGenerated(path)
    else if (path.endsWith(".ts")) writeFileSync(path, `/* eslint-disable */\n${readFileSync(path, "utf8")}`)
  }
}
markGenerated(generated)
console.log("Generated src/lib/qlc/generated")
