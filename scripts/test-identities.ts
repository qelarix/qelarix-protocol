// Owner-created, test-only signing identities. Qelarix tests never generate keys: signer-dependent
// checks load these key files from the folder named by QLC_TEST_IDENTITIES_DIR (created and kept by the
// owner, outside the repository) and stop, or report BLOCKED, when one is missing. Key contents are
// never printed or logged; only public addresses are compared.
//
//   admin.json  operator.json  mint.json  wallet-1.json  wallet-2.json  wallet-3.json  treasury.json  usd-mint.json
import { createHash, createPrivateKey, type KeyObject } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createKeyPairSignerFromBytes, getAddressDecoder, type KeyPairSigner } from "@solana/kit"
import { REJECTED_ID_HASHES } from "./qlc-build-preflight"

export const TEST_IDENTITIES = ["admin", "operator", "mint", "wallet-1", "wallet-2", "wallet-3", "treasury", "usd-mint"] as const
export type TestIdentity = (typeof TEST_IDENTITIES)[number]

// Active Qelarix identities with real roles. A test may never sign with one of them.
const PRIVILEGED = new Set([
  "EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa", // program deploy key
  "B2sGhW5He2nT5zMYSoYRxrvwKdhdthphYT3G6zaUqNoG", // devnet upgrade authority (Ledger)
  "4GEGAVHQCwshpv3yC25Xs7ACmWvNpcjTneT56XVD8McL", // devnet operator
  "GJPDitCMWnH3bPYFUJRWwyXdXmErBhwrS5EoYz6JZwmz", // deploy CLI signer
  "6k4gTKg6hLDHfL1y9YWbJsSQm18KE9kMHyYzmT8RxB8j", // deploy buffer
  "AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw", // devnet treasury
  "4M9QBi82P75sBUE7yEyDQHSRDreP1s2GnPaQGwazbqqm", // founder wallet
  "C7pkmggd8mNoc1n9XitK6QP4HzdVGGhFTUrbUfFmo7Hp", // owner Phantom account
])
// PKCS#8 DER prefix for a raw 32-byte Ed25519 private key.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const loaded = new Map<string, TestIdentity>()

export function missingIdentity(name: TestIdentity): string {
  return `owner test identity ${name}.json not provided (set QLC_TEST_IDENTITIES_DIR)`
}

/** The identity's 64-byte keypair, or null when QLC_TEST_IDENTITIES_DIR or the file is missing. */
function readIdentity(name: TestIdentity): Uint8Array | null {
  const dir = process.env.QLC_TEST_IDENTITIES_DIR
  if (!dir || !existsSync(join(dir, `${name}.json`))) return null
  const bytes = Uint8Array.from(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as number[])
  if (bytes.length !== 64) throw new Error(`${name}.json is not a 64-byte keypair file`)
  const address = getAddressDecoder().decode(bytes.subarray(32))
  if (PRIVILEGED.has(address) || REJECTED_ID_HASHES.has(createHash("sha256").update(address).digest("hex"))) {
    throw new Error(`${name}.json (${address}) is a privileged or rejected Qelarix identity; use a test-only identity`)
  }
  const other = loaded.get(address)
  if (other && other !== name) throw new Error(`${name}.json and ${other}.json are the same identity; each test identity must be distinct`)
  loaded.set(address, name)
  return bytes
}

/** The owner's test signer, or null when it is not provided. */
export async function testSigner(name: TestIdentity): Promise<KeyPairSigner | null> {
  const bytes = readIdentity(name)
  return bytes ? createKeyPairSignerFromBytes(bytes) : null
}

/** The owner's test signer; stops with a clear error when it is not provided. */
export async function requireTestSigner(name: TestIdentity): Promise<KeyPairSigner> {
  const signer = await testSigner(name)
  if (!signer) throw new Error(missingIdentity(name))
  return signer
}

/** The same identity as a Node Ed25519 private key (for message-signing checks), or null when not provided. */
export function testEd25519Key(name: TestIdentity): KeyObject | null {
  const bytes = readIdentity(name)
  if (!bytes) return null
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(bytes.subarray(0, 32))]), format: "der", type: "pkcs8" })
}

/** Validates every listed identity (present, 64 bytes, not privileged or rejected, distinct); returns the missing ones. */
export function validateTestIdentities(names: readonly TestIdentity[]): TestIdentity[] {
  return names.filter((name) => readIdentity(name) === null)
}
