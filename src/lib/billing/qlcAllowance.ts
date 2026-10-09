// The QLC spend allowance a member approves to the program's spend delegate (Allowance + automatic
// refund UX: approve once, QLC stays in the wallet until a generation is charged; no per-generation
// wallet popup). Always finite: an approval sets the allowance to exactly this amount; revoking clears it.
// Charges consume the allowance and refunds do not restore it, so the member re-approves when it runs low.

/** Default allowance offered by "Enable QLC": deliberately small (about 12 images) so a wallet never approves a large share of its balance by default. Whole QLC. */
export const DEFAULT_ALLOWANCE_QLC = 50
/** Largest allowance Qelarix asks a wallet to approve. Whole QLC. */
export const MAX_ALLOWANCE_QLC = 10_000

/** Whole/decimal QLC from the client → base units, or null when outside 0.05 … MAX_ALLOWANCE_QLC or off the 0.05 step. */
export function parseAllowance(value: unknown): bigint | null {
  const qlc = value === undefined || value === null || value === "" ? DEFAULT_ALLOWANCE_QLC : Number(value)
  if (!Number.isFinite(qlc) || qlc <= 0 || qlc > MAX_ALLOWANCE_QLC) return null
  const baseUnits = Math.round(qlc * 100)
  if (Math.abs(baseUnits - qlc * 100) > 1e-6 || baseUnits % 5 !== 0) return null
  return BigInt(baseUnits)
}
