// Internal (founder / team) accounts get unlimited access: plan and credit gates are skipped.
// They are identified only by approved Solana wallet addresses in the server-side
// INTERNAL_WALLET_ADDRESSES setting (comma-separated), never by email and never in source code.
// Server code calls isInternalUser(authUser); client components read session.user.isInternal,
// which /api/profile computes on the server.
import { SOLANA_ADDRESS_PATTERN } from "@/lib/walletIdentity"

export function internalWalletAddresses(): string[] {
  return (process.env.INTERNAL_WALLET_ADDRESSES ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => SOLANA_ADDRESS_PATTERN.test(address))
}

/** True when the signed-in user's wallet is an approved internal account. Server only. */
export function isInternalUser(user?: { walletAddress?: string | null } | null): boolean {
  const wallet = user?.walletAddress
  return !!wallet && internalWalletAddresses().includes(wallet)
}
