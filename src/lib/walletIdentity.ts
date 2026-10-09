// Solana wallet identity of a Supabase Auth user. Edge-safe: no imports.
//
// Supabase "Sign in with Web3" stores one identity per wallet with provider "web3" and
// provider id "web3:solana:<address>"; the signed message claims (address, chain, network,
// domain, statement) are kept in identity_data.custom_claims.

export const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SOLANA_IDENTITY_PATTERN = /^web3:solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/

interface IdentityLike {
  provider?: string
  id?: string
  identity_data?: { [key: string]: unknown } | null
}

interface UserLike {
  identities?: IdentityLike[] | null
}

/** Wallet address the user signed in with, or null for any user without a Solana wallet identity. */
export function getSolanaWalletAddress(user: UserLike | null | undefined): string | null {
  for (const identity of user?.identities ?? []) {
    if (identity.provider !== "web3") continue
    const address = identity.id?.match(SOLANA_IDENTITY_PATTERN)?.[1]
    if (!address) continue
    const claims = identity.identity_data?.custom_claims as { address?: unknown } | undefined
    if (claims?.address !== undefined && claims.address !== address) continue
    return address
  }
  return null
}

export function shortWalletAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}
