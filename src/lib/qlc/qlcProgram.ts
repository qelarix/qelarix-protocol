// QLC program constants shared by the server and the setup script. QLC amounts are integers in
// base units (2 decimals): 100 = 1.00 QLC. Every amount Qelarix handles is a multiple of 5 (0.05 QLC).
import { address, getAddressEncoder, getProgramDerivedAddress, getU64Encoder, getUtf8Encoder, type Address } from "@solana/kit"
import { QELARIX_QLC_PROGRAM_ADDRESS } from "./generated"

export { QELARIX_QLC_PROGRAM_ADDRESS }

export const QLC_DECIMALS = 2
export const QLC_AMOUNT_STEP = BigInt(5)
export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111")

/**
 * The mint's PermissionedBurn authority: an address derived under the System Program, which never
 * signs for derived addresses, so no QLC burn can ever be authorized.
 */
export async function findNoBurnAuthority(): Promise<Address> {
  const [authority] = await getProgramDerivedAddress({
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    seeds: [getUtf8Encoder().encode("qlc-permanent-no-burn")],
  })
  return authority
}

/**
 * Receipt of a member's charge number `seq` (seeds: "charge", wallet, seq as u64 little-endian).
 * Charge numbers only grow per member (`Member.lastChargeSeq`), so a number is never charged twice.
 */
export async function findChargeReceiptPda(input: { wallet: Address; seq: bigint }): Promise<Address> {
  const [receipt] = await getProgramDerivedAddress({
    programAddress: QELARIX_QLC_PROGRAM_ADDRESS,
    seeds: [getUtf8Encoder().encode("charge"), getAddressEncoder().encode(input.wallet), getU64Encoder().encode(input.seq)],
  })
  return receipt
}

/** True for positive QLC base-unit amounts on the 0.05 QLC step. */
export function isQlcStep(amount: bigint): boolean {
  return amount > BigInt(0) && amount % QLC_AMOUNT_STEP === BigInt(0)
}

/** 150 → "1.50" */
export function formatQlc(baseUnits: bigint | number | string): string {
  const value = BigInt(baseUnits)
  const hundred = BigInt(100)
  return `${(value / hundred).toLocaleString("en-US")}.${(value % hundred).toString().padStart(2, "0")}`
}
