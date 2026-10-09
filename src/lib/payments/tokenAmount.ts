// Amounts are integers in base units everywhere (quotes, chain checks, database). Display formatting
// is the only place they become decimals. Safe to import from client components.

/** USD values are stored in micro-dollars (6 decimals), the same scale as USDC base units. */
export const USD_DECIMALS = 6

/** 10^n as a bigint. */
export function pow10(n: number): bigint {
  let result = BigInt(1)
  for (let i = 0; i < n; i++) result *= BigInt(10)
  return result
}

/** formatTokenAmount(4990000n, 6) → "4.99"; (40960123n, 9) → "0.040960123"; (100n, 2) → "1.00". */
export function formatTokenAmount(baseUnits: bigint | string, decimals: number, minFractionDigits = 2): string {
  const value = BigInt(baseUnits)
  const unit = pow10(decimals)
  const whole = value / unit
  const fraction = decimals === 0 ? "" : (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "")
  const shown = fraction.padEnd(Math.min(minFractionDigits, decimals), "0")
  return shown ? `${whole.toLocaleString("en-US")}.${shown}` : whole.toLocaleString("en-US")
}

export function formatUsd(micros: bigint | string): string {
  return `$${formatTokenAmount(micros, USD_DECIMALS)}`
}
