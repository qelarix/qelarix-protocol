// Offline checks for the Program Metadata tooling (scripts/qlc-metadata.ts): the IDL provenance chain, the
// security.txt review, the metadata account verifier and the export inspector (exact official plan), each
// against the committed files, the local verified build and synthetic Program Metadata data. No network, no
// keys, no chain.
//
//   npm run check:qlc-metadata
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { AccountRole, address, getAddressEncoder, type Instruction } from "@solana/kit"
import { PROGRAM_ID, PROGRAM_SO, ROOT, readManifest, sha256, type Check, type Manifest } from "./qlc-build-preflight"
import { DEPLOY_IDENTITIES } from "./qlc-deploy-preflight"
import {
  DEPLOYED_SO_SHA256,
  HEADER_LEN,
  METADATA_FILES,
  PMP_PROGRAM,
  PROVENANCE_FILE,
  codamaIdl,
  codamaVersionChecks,
  decodeHeader,
  encodeLegacy,
  inBinary,
  inspectChecks,
  metadataAddress,
  metadataChecks,
  officialPlan,
  parseExport,
  provenanceChecks,
  seedBytes,
  securityChecks,
  type Account,
  type InspectContext,
} from "./qlc-metadata"

const { upgradeAuthority: L, feePayer: F } = DEPLOY_IDENTITIES
const SYSTEM_PROGRAM = "11111111111111111111111111111111"
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"
const PROGRAM_DATA = "4vy8vMXA8wdojSvipTb5hasfnvUD9WB1V7VnbX4hSwgJ"
const ANCHOR_IDL = join(ROOT, "solana/target/idl/qelarix_qlc.json")

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
    failed.length ? `blocked by: ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail.slice(0, 160)})` : ""}`).join("; ")}` : "nothing failed",
  )
}

// ---------------------------------------------------------------- synthetic Program Metadata data
const rent = (size: number) => (size + 128) * 5_080
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u64 = (n: number | bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
const meta = (key: string, role: AccountRole) => ({ address: address(key), role })
const ix = (program: string, accounts: [string, AccountRole][], data: Buffer): Instruction => ({
  programAddress: address(program),
  accounts: accounts.map(([key, role]) => meta(key, role)),
  data: new Uint8Array(data),
})
const W = AccountRole.WRITABLE
const R = AccountRole.READONLY
const WS = AccountRole.WRITABLE_SIGNER
const RS = AccountRole.READONLY_SIGNER
const writeIx = (M: string, offset: number, bytes: Buffer) => ix(PMP_PROGRAM, [[M, W], [L, RS], [PMP_PROGRAM, R]], Buffer.concat([Buffer.from([0]), u32(offset), bytes]))
const price = (micro: number) => ix(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([3]), u64(micro)]))
const isWrite = (i: Instruction) => i.programAddress === PMP_PROGRAM && i.data?.[0] === 0
const writeOf = (i: Instruction) => ({ offset: Buffer.from(i.data ?? []).readUInt32LE(1), bytes: Buffer.from(i.data ?? []).subarray(5) })
const encodeAll = (txs: Instruction[][], feePayer?: string, version?: "legacy" | 0) => txs.map((t) => encodeLegacy(t, feePayer, version))

function metadataAccount(seed: string, payload: Buffer, o: Partial<{ authority: string; canonical: number; mutable: number; compression: number; owner: string; lamports: number; seed: Buffer; executable: boolean; declared: number; padding: number; extra: number }> = {}): Account {
  const header = Buffer.alloc(HEADER_LEN)
  header[0] = 2
  Buffer.from(getAddressEncoder().encode(address(PROGRAM_ID))).copy(header, 1)
  if (o.authority) Buffer.from(getAddressEncoder().encode(address(o.authority))).copy(header, 33)
  header[65] = o.mutable ?? 1
  header[66] = o.canonical ?? 1
  ;(o.seed ?? seedBytes(seed)).copy(header, 67)
  header[83] = 1
  header[84] = o.compression ?? 2
  header[85] = 1
  header[86] = 0
  header.writeUInt32LE(o.declared ?? payload.length, 87)
  if (o.padding) header[95] = o.padding
  const data = Buffer.concat([header, payload, Buffer.alloc(o.extra ?? 0)])
  return { lamports: o.lamports ?? rent(data.length), owner: o.owner ?? PMP_PROGRAM, executable: o.executable ?? false, data }
}

async function main() {
  const idlText = readFileSync(METADATA_FILES.idl, "utf8")
  const securityText = readFileSync(METADATA_FILES.security, "utf8")
  const idlPayload = deflateSync(Buffer.from(idlText))
  const securityPayload = deflateSync(Buffer.from(securityText))
  const [M_IDL, M_SEC] = await Promise.all([metadataAddress("idl"), metadataAddress("security")])
  const idlCtx: InspectContext = { seed: "idl", metadata: M_IDL, programData: PROGRAM_DATA, localText: idlText, expectedRent: rent }
  const secCtx: InspectContext = { seed: "security", metadata: M_SEC, programData: PROGRAM_DATA, localText: securityText, expectedRent: rent }

  console.log("— committed metadata files")
  const idl = JSON.parse(idlText) as { standard: string; program: { publicKey: string; name: string } }
  check("idl.json is a Codama root for the program", idl.standard === "codama" && idl.program.publicKey === PROGRAM_ID && idl.program.name === "qelarixQlc")
  const provenance = JSON.parse(readFileSync(PROVENANCE_FILE, "utf8")) as { deployedBinary: { sha256: string }; anchorIdl: { sha256: string }; codamaIdl: { sha256: string } }
  check("idl.provenance.json binds idl.json (sha256) to the deployed binary", provenance.codamaIdl.sha256 === sha256(idlText) && provenance.deployedBinary.sha256 === DEPLOYED_SO_SHA256)
  expectPass("security.json passes the review", securityChecks(securityText))
  check("canonical PDAs differ per seed", M_IDL !== M_SEC, `${M_IDL} / ${M_SEC}`)

  console.log("— IDL provenance chain (local verified build)")
  const manifest = readManifest()
  if (!manifest || !existsSync(PROGRAM_SO) || !existsSync(ANCHOR_IDL)) {
    check("local verified build present (npm run qlc:build)", false, "binary, Anchor IDL or manifest missing")
  } else {
    const so = readFileSync(PROGRAM_SO)
    const anchorText = readFileSync(ANCHOR_IDL, "utf8")
    expectPass("deployed binary + manifest + Anchor IDL of the same build accepted", provenanceChecks(manifest, anchorText, so))
    check("the recorded Anchor IDL converts to the committed idl.json", codamaIdl(anchorText) === idlText && provenance.anchorIdl.sha256 === sha256(anchorText))
    const edited = anchorText.replace('"name": "amount"', '"name": "amounts"')
    check("negative control: the edit below changes the Anchor IDL", edited !== anchorText)
    expectFail("edited Anchor IDL (same discriminators, different interface)", provenanceChecks(manifest, edited, so), "Anchor IDL = the IDL recorded")
    const without = { ...manifest, idl: undefined } as Manifest
    expectFail("manifest without an Anchor IDL hash", provenanceChecks(without, anchorText, so), "Anchor IDL = the IDL recorded")
    expectFail("manifest records another Anchor IDL", provenanceChecks({ ...manifest, idl: { ...manifest.idl!, sha256: sha256("other") } }, anchorText, so), "Anchor IDL = the IDL recorded")
    expectFail("manifest records another binary", provenanceChecks({ ...manifest, so: { ...manifest.so, sha256: sha256("other") } }, anchorText, so), "deployed binary")
    const tampered = Buffer.from(so)
    tampered[1000] ^= 1
    expectFail("local binary differs from the deployed binary", provenanceChecks(manifest, anchorText, tampered), "deployed binary")
    expectFail("no build record (manifest not written by npm run qlc:build)", provenanceChecks({ ...manifest, build: undefined }, anchorText, so), "one npm run qlc:build run")
    expectFail("Anchor IDL older than the build run", provenanceChecks({ ...manifest, idl: { ...manifest.idl!, builtAt: "2026-01-01T00:00:00.000Z" } }, anchorText, so), "one npm run qlc:build run")
    expectFail("no manifest", provenanceChecks(null, anchorText, so), "manifest present")
  }
  expectPass("pinned Codama toolchain installed", codamaVersionChecks())
  expectFail("different Codama version", codamaVersionChecks((name) => (name === "codama" ? "1.12.0" : name === "@codama/nodes-from-anchor" ? "1.5.6" : "2.5.0")), "codama 1.11.0")

  console.log("— security.txt review")
  const base = JSON.parse(securityText) as Record<string, unknown>
  const variant = (extra: Record<string, unknown>) => JSON.stringify({ ...base, ...extra })
  expectPass("approved contacts and policy accepted", securityChecks(variant({ contacts: ["email:security@qelarix.ai"], policy: "https://qelarix.ai/security" })))
  expectFail("not JSON", securityChecks("name: Qelarix"), "valid JSON object")
  expectFail("unknown key", securityChecks(variant({ bug_bounty: "100k" })), "only keys")
  expectFail("placeholder contact", securityChecks(variant({ contacts: ["email:<owner decision>"] })), "placeholder")
  expectFail("example.com URL", securityChecks(variant({ policy: "https://example.com/policy" })), "placeholder")
  expectFail("http URL", securityChecks(variant({ project_url: "http://qelarix.ai" })), "https on approved hosts")
  expectFail("unapproved host", securityChecks(variant({ source_code: "https://github.com/someone/repo" })), "https on approved hosts")
  expectFail("audit claim", securityChecks(variant({ auditors: ["Audit Firm A"] })), "no audit claim")
  expectFail("non-string value", securityChecks(variant({ version: 1 })), "non-empty string")
  expectFail("contact without scheme", securityChecks(variant({ contacts: ["security@qelarix.ai"] })), "<scheme>:<value>")
  expectFail("missing project_url", securityChecks(JSON.stringify({ name: "Qelarix" })), "name and project_url")

  console.log("— metadata account verifier (strict account state)")
  const r = rent(HEADER_LEN + idlPayload.length)
  expectPass("idl: canonical account with the reviewed content accepted", metadataChecks("idl", metadataAccount("idl", idlPayload), idlText, r))
  expectPass("security: canonical account accepted", metadataChecks("security", metadataAccount("security", securityPayload), securityText, rent(HEADER_LEN + securityPayload.length)))
  expectFail("account absent", metadataChecks("idl", null, idlText, r), "exists")
  expectFail("owned by another program", metadataChecks("idl", metadataAccount("idl", idlPayload, { owner: SYSTEM_PROGRAM }), idlText, r), "exists")
  expectFail("executable account", metadataChecks("idl", metadataAccount("idl", idlPayload, { executable: true }), idlText, r), "not executable")
  expectFail("immutable account", metadataChecks("idl", metadataAccount("idl", idlPayload, { mutable: 0 }), idlText, r), "mutable")
  expectFail("non-canonical (third-party) account", metadataChecks("idl", metadataAccount("idl", idlPayload, { canonical: 0 }), idlText, r), "canonical")
  expectFail("wrong seed", metadataChecks("idl", metadataAccount("idl", idlPayload, { seed: seedBytes("idl-old") }), idlText, r), "seed field")
  const garbageSeed = seedBytes("idl")
  garbageSeed[10] = 0x41
  expectFail("seed with bytes after the zero padding", metadataChecks("idl", metadataAccount("idl", idlPayload, { seed: garbageSeed }), idlText, r), "seed field")
  expectFail("extra metadata authority set", metadataChecks("idl", metadataAccount("idl", idlPayload, { authority: F }), idlText, r), "no extra authority")
  expectFail("uncompressed content", metadataChecks("idl", metadataAccount("idl", Buffer.from(idlText), { compression: 0 }), idlText, r), "zlib")
  expectFail("content differs from the reviewed file", metadataChecks("idl", metadataAccount("idl", deflateSync(Buffer.from(`${idlText} `))), idlText, r), "byte for byte")
  expectFail("truncated account (declared length beyond the data)", metadataChecks("idl", metadataAccount("idl", idlPayload, { declared: idlPayload.length + 10 }), idlText, r), "account length")
  expectFail("trailing bytes after the declared data", metadataChecks("idl", metadataAccount("idl", idlPayload, { extra: 16 }), idlText, r), "account length")
  expectFail("declared length shorter than the data", metadataChecks("idl", metadataAccount("idl", idlPayload, { declared: idlPayload.length - 1 }), idlText, r), "account length")
  expectFail("non-zero header padding", metadataChecks("idl", metadataAccount("idl", idlPayload, { padding: 1 }), idlText, r), "account length")
  expectFail("account shorter than the header", metadataChecks("idl", { lamports: r, owner: PMP_PROGRAM, executable: false, data: Buffer.alloc(40) }, idlText, r), "96-byte header")
  expectFail("not rent-exempt", metadataChecks("idl", metadataAccount("idl", idlPayload, { lamports: 1 }), idlText, r), "rent-exempt")
  const decoded = decodeHeader(metadataAccount("security", securityPayload).data)
  check("header decoder reads the 96-byte layout", decoded?.program === PROGRAM_ID && decoded.seed.equals(seedBytes("security")) && decoded.authority === null && decoded.dataLength === securityPayload.length)

  console.log("— export inspector (exact official plan)")
  const idlPlan = await officialPlan(idlCtx, idlPayload, rent(HEADER_LEN + idlPayload.length))
  const secPlan = await officialPlan(secCtx, securityPayload, rent(HEADER_LEN + securityPayload.length))
  const idlExport = encodeAll(idlPlan)
  expectPass(`idl: official plan (${idlPlan.length} transactions) accepted`, await inspectChecks(idlExport, idlCtx))
  expectPass("security: official single-transaction plan accepted", await inspectChecks(encodeAll(secPlan), secCtx))
  const sizes = idlExport.map((wire) => Buffer.from(wire, "base64").length)
  check("official IDL plan: transfer + Allocate + first Write share transaction #1", idlPlan[0].length === 4 && isWrite(idlPlan[0][3]) && writeOf(idlPlan[0][3]).offset === 0)
  check("official IDL plan: every non-final write transaction is full (1224 = 1232 − removed 8-byte CU limit)", sizes.slice(0, -2).every((s) => s === 1224), sizes.join(","))
  check("official plans carry one zero compute-unit price per transaction", [...idlPlan, ...secPlan].every((t) => t.filter((i) => i.programAddress === COMPUTE_BUDGET).length === 1))
  check("export parser keeps only transactions from CLI output", parseExport(`Exporting 2 transactions\n[Transaction #1]\n${idlExport[0]}\n\n[Transaction #2]\n${idlExport[1]}\n`).length === 2)
  // Large payload: Extend is planned in 10,240-byte chunks.
  // Pseudo-random hex (sha256 chain) barely compresses, so the account must grow beyond 10,240 bytes.
  const bigText = Array.from({ length: 1_000 }, (_, i) => sha256(`qlc-${i}`)).join("")
  const bigPayload = deflateSync(Buffer.from(bigText))
  const bigCtx: InspectContext = { ...idlCtx, localText: bigText }
  const bigPlan = await officialPlan(bigCtx, bigPayload, rent(HEADER_LEN + bigPayload.length))
  const bigExtends = bigPlan.flat().filter((i) => i.programAddress === PMP_PROGRAM && i.data?.[0] === 8).map((i) => Buffer.from(i.data ?? []).readUInt16LE(1))
  check("large payload: official plan grows the account in 10,240-byte Extend chunks", bigExtends.length > 1 && bigExtends.slice(0, -1).every((n) => n === 10_240) && bigExtends.reduce((a, n) => a + n, 0) === bigPayload.length, `${bigPayload.length} bytes → ${bigExtends.join(",")}`)
  expectPass(`large payload (${bigPayload.length} bytes): official plan with Extend accepted`, await inspectChecks(encodeAll(bigPlan), bigCtx))

  const mutate = (plan: Instruction[][], change: (txs: Instruction[][]) => Instruction[][]) => encodeAll(change(plan.map((t) => [...t])))
  const w2 = writeOf(idlPlan[1].find(isWrite)!)
  expectFail("duplicate write transaction", await inspectChecks(mutate(idlPlan, (t) => [t[0], t[1], t[1], ...t.slice(2)]), idlCtx), "overlaps or repeats")
  const w3 = writeOf(idlPlan[2].find(isWrite)!)
  const overlapping = writeIx(M_IDL, w3.offset - 10, Buffer.concat([w2.bytes.subarray(w2.bytes.length - 10), w3.bytes]))
  expectFail("overlapping write (same final payload)", await inspectChecks(mutate(idlPlan, (t) => [t[0], t[1], [t[2][0], overlapping], ...t.slice(3)]), idlCtx), "overlaps or repeats")
  expectFail("reordered writes", await inspectChecks(mutate(idlPlan, (t) => [t[0], t[2], t[1], ...t.slice(3)]), idlCtx), "out of order")
  const half = Math.floor(w2.bytes.length / 2)
  const split = [
    [price(0), writeIx(M_IDL, w2.offset, w2.bytes.subarray(0, half))],
    [price(0), writeIx(M_IDL, w2.offset + half, w2.bytes.subarray(half))],
  ]
  expectFail("one write split into two transactions (extra Ledger signature)", await inspectChecks(mutate(idlPlan, (t) => [t[0], ...split, ...t.slice(2)]), idlCtx), "official program-metadata 0.10.0 plan")
  const last = writeOf(idlPlan[idlPlan.length - 2].find(isWrite)!)
  const twoWrites = [price(0), writeIx(M_IDL, last.offset, last.bytes.subarray(0, 30)), writeIx(M_IDL, last.offset + 30, last.bytes.subarray(30))]
  expectFail("two writes in one transaction", await inspectChecks(mutate(idlPlan, (t) => [...t.slice(0, -2), twoWrites, t[t.length - 1]]), idlCtx), "Write instructions")
  const extendIx = (M: string, length: number) => ix(PMP_PROGRAM, [[M, W], [L, RS], [PROGRAM_ID, R], [PROGRAM_DATA, R]], Buffer.from([8, length & 0xff, length >> 8]))
  expectFail("unnecessary Extend", await inspectChecks(mutate(idlPlan, (t) => [[...t[0].slice(0, 3), extendIx(M_IDL, idlPayload.length), t[0][3]], ...t.slice(1)]), idlCtx), "Extend exactly")
  const bigFirst = bigPlan[0].map((i) => (i.programAddress === PMP_PROGRAM && i.data?.[0] === 8 && Buffer.from(i.data).readUInt16LE(1) === 10_240 ? extendIx(M_IDL, 10_000) : i))
  expectFail("wrong Extend amount", await inspectChecks(encodeAll([bigFirst, ...bigPlan.slice(1)]), bigCtx), "Extend exactly")
  expectFail("redundant compute-unit price instruction", await inspectChecks(mutate(idlPlan, (t) => [t[0], [price(0), ...t[1]], ...t.slice(2)]), idlCtx), "redundant")
  const cuLimit = ix(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([2]), u32(200_000)]))
  expectFail("compute-unit limit left in the export", await inspectChecks(mutate(idlPlan, (t) => [[cuLimit, ...t[0]], ...t.slice(1)]), idlCtx), "compute budget instruction 2")
  expectFail("second Allocate", await inspectChecks(mutate(idlPlan, (t) => [t[0], [...t[1], idlPlan[0][2]], ...t.slice(2)]), idlCtx), "once")
  const zeroTransfer = ix(SYSTEM_PROGRAM, [[L, WS], [M_IDL, W]], Buffer.concat([u32(2), u64(0)]))
  expectFail("extra zero-lamport transfer", await inspectChecks(mutate(idlPlan, (t) => [t[0], [...t[1], zeroTransfer], ...t.slice(2)]), idlCtx), "rent transfer")
  expectFail("version-0 messages", await inspectChecks(encodeAll(idlPlan, L, 0), idlCtx), "legacy messages")
  const chunkedSecurity = [
    [price(0), secPlan[0][1], ix(PMP_PROGRAM, [[M_SEC, W], [L, RS], [PROGRAM_ID, R], [PROGRAM_DATA, R], [SYSTEM_PROGRAM, R]], Buffer.concat([Buffer.from([7]), seedBytes("security")])), writeIx(M_SEC, 0, securityPayload)],
    [price(0), ix(PMP_PROGRAM, [[M_SEC, W], [L, RS], [PROGRAM_ID, R], [PROGRAM_DATA, R], [PMP_PROGRAM, R]], Buffer.concat([Buffer.from([1]), seedBytes("security"), Buffer.from([1, 2, 1, 0])]))],
  ]
  expectFail("chunked create where the official plan is one transaction", await inspectChecks(encodeAll(chunkedSecurity), secCtx), "official program-metadata 0.10.0 plan")
  expectFail("no transactions", await inspectChecks([], idlCtx), "transactions found")
  expectFail("fee payer is the CLI signer", await inspectChecks(encodeAll(idlPlan, F), idlCtx), "only")
  const extraSigner = ix(PMP_PROGRAM, [[M_IDL, W], [F, RS], [PMP_PROGRAM, R]], Buffer.from([0, 0, 0, 0, 0, 1]))
  expectFail("a second signer", await inspectChecks(mutate(idlPlan, (t) => [[...t[0], extraSigner], ...t.slice(1)]), idlCtx), "only")
  expectFail("non-zero priority fee", await inspectChecks(mutate(idlPlan, (t) => t.map((tx) => tx.map((i) => (i.programAddress === COMPUTE_BUDGET ? price(100_000) : i)))), idlCtx), "priority fee")
  for (const [name, tag] of [["SetAuthority", 2], ["SetData", 3], ["SetImmutable", 4], ["Trim", 5], ["Close", 6]] as const) {
    const extra = ix(PMP_PROGRAM, [[M_IDL, W], [L, RS], [PROGRAM_ID, R], [PROGRAM_DATA, R]], Buffer.from([tag, 0]))
    expectFail(`${name} instruction`, await inspectChecks(mutate(idlPlan, (t) => [t[0], [...t[1], extra], ...t.slice(2)]), idlCtx), name)
  }
  const memo = ix("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", [], Buffer.from("hi"))
  expectFail("unknown program (memo)", await inspectChecks(mutate(idlPlan, (t) => [t[0], [...t[1], memo], ...t.slice(2)]), idlCtx), "unexpected")
  const wrongPdaPlan = await officialPlan({ ...idlCtx, metadata: M_SEC }, idlPayload, rent(HEADER_LEN + idlPayload.length))
  expectFail("wrong metadata PDA (security PDA for the IDL)", await inspectChecks(encodeAll(wrongPdaPlan), idlCtx), "unexpected")
  const wrongSeedPlan = await officialPlan({ ...idlCtx, seed: "security" }, idlPayload, rent(HEADER_LEN + idlPayload.length))
  expectFail("wrong seed (Allocate and Initialize)", await inspectChecks(encodeAll(wrongSeedPlan), idlCtx), "unexpected accounts or data")
  const foreignPayload = deflateSync(Buffer.from(idlText.replace("qelarixQlc", "qelarixQlX")))
  expectFail("payload is not the reviewed file", await inspectChecks(encodeAll(await officialPlan(idlCtx, foreignPayload, rent(HEADER_LEN + foreignPayload.length))), idlCtx), "byte for byte")
  expectFail("gap in written chunks", await inspectChecks(mutate(idlPlan, (t) => [t[0], ...t.slice(2)]), idlCtx), "leaves a gap")
  expectFail("Initialize not last", await inspectChecks(mutate(idlPlan, (t) => [t[t.length - 1], ...t.slice(0, -1)]), idlCtx), "once")
  const offByOne = await officialPlan(idlCtx, idlPayload, rent(HEADER_LEN + idlPayload.length) + 1)
  expectFail("rent transfer off by one lamport", await inspectChecks(encodeAll(offByOne), idlCtx), "rent transfer")
  const presigned = Buffer.from(idlExport[0], "base64")
  presigned[1] = 1
  expectFail("pre-signed transaction", await inspectChecks([presigned.toString("base64"), ...idlExport.slice(1)], idlCtx), "unsigned")

  console.log("— discriminator search")
  const sbf = Buffer.concat([Buffer.alloc(16), Buffer.from([0x18, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8]), Buffer.from([9, 9, 9, 9, 9, 9, 9, 9])])
  check("finds a discriminator split across lddw", inBinary(sbf, [1, 2, 3, 4, 5, 6, 7, 8]))
  check("finds a raw discriminator", inBinary(sbf, [9, 9, 9, 9, 9, 9, 9, 9]))
  check("does not find an absent discriminator", !inBinary(sbf, [1, 2, 3, 4, 5, 6, 7, 9]))

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll QLC metadata checks passed")
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
