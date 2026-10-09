// Wallet sign-in: Sign In With Solana through Supabase Web3 auth.
//
// Supabase Auth asks the wallet to sign a plain-text SIWS message (domain, URI, issued-at,
// statement), then verifies the Ed25519 signature, the domain / URI allowlist and the message
// age, and issues a session. Wallets with the Wallet Standard `solana:signIn` feature (e.g.
// Phantom) build the standard SIWS message themselves; only wallets without it sign Supabase's
// own message text via `solana:signMessage`. No transaction is sent, nothing is stored
// client-side beyond the Supabase session, and the signature is never kept.
import type { SolanaWallet, SupabaseClient } from "@supabase/supabase-js"
import type { SolanaCluster } from "@/lib/solanaCluster"
import { SOLANA_ADDRESS_PATTERN, getSolanaWalletAddress } from "@/lib/walletIdentity"

/** Clusters where wallet sign-in is enabled. Mainnet is enabled in a dedicated launch task. */
export const WALLET_SIGN_IN_CLUSTERS: readonly SolanaCluster[] = ["devnet"]

export const WALLET_SIGN_IN_STATEMENT =
  "Sign in to Qelarix with your Solana wallet. This request does not send a transaction or cost any fees."

/** Wallet Standard features used to sign in: Sign In With Solana, or a plain message signature. */
export const SOLANA_SIGN_IN_FEATURE = "solana:signIn"
export const SOLANA_SIGN_MESSAGE_FEATURE = "solana:signMessage"

/**
 * How a wallet signs in: "sign-in" when it supports Sign In With Solana, so the wallet builds the
 * standard SIWS message; "sign-message" only for wallets without it, which then sign Supabase's own
 * message text. That text does not follow the SIWS field order (Version before URI), so wallets
 * that parse SIWS messages, like Phantom, reject it as invalid formatting.
 */
export function walletSignInMethod(features: readonly string[]): "sign-in" | "sign-message" | null {
  if (features.includes(SOLANA_SIGN_IN_FEATURE)) return "sign-in"
  if (features.includes(SOLANA_SIGN_MESSAGE_FEATURE)) return "sign-message"
  return null
}

export function isWalletSignInEnabled(cluster: SolanaCluster | null): cluster is SolanaCluster {
  return cluster !== null && WALLET_SIGN_IN_CLUSTERS.includes(cluster)
}

/** Wallet Standard chain id for a cluster, e.g. "solana:devnet". */
export function walletChainFor(cluster: SolanaCluster): `solana:${string}` {
  return cluster === "mainnet-beta" ? "solana:mainnet" : `solana:${cluster}`
}

export type MessageSigner = (message: Uint8Array) => Promise<Uint8Array>

type SupabaseSignIn = NonNullable<SolanaWallet["signIn"]>
/** The SIWS fields Supabase asks the wallet to sign (domain, URI, version, statement, issued-at). */
export type SignInInput = Parameters<SupabaseSignIn>[0]
export type SignInOutput = Extract<Awaited<ReturnType<SupabaseSignIn>>, { signedMessage: Uint8Array }>
/** Wallet Standard `solana:signIn`: the wallet builds the SIWS message from the input, signs it and reports the signing account. */
export type SignInSigner = (input: SignInInput) => Promise<SignInOutput>

export type WalletSigner = { signIn: SignInSigner } | { signMessage: MessageSigner }

/**
 * Adapts a Wallet Standard account to the wallet shape Supabase expects. A Sign In With Solana
 * wallet is exposed with `signIn` only, so Supabase always takes its structured SIWS path for it
 * and never falls back to signing its own message text.
 */
export function toSupabaseSolanaWallet(address: string, signer: WalletSigner): SolanaWallet {
  const publicKey = { toBase58: () => address }
  if ("signIn" in signer) {
    return {
      publicKey,
      signIn: async (input: SignInInput) => {
        const output = await signer.signIn({ ...input, address })
        if (output.account.address !== address) throw new Error("The wallet signed in with a different account")
        // Plain copies: Supabase checks `instanceof Uint8Array`, which fails for arrays from another realm.
        return { ...output, signedMessage: Uint8Array.from(output.signedMessage), signature: Uint8Array.from(output.signature) }
      },
    }
  }
  return { publicKey, signMessage: (message: Uint8Array) => signer.signMessage(message) }
}

export type WalletSignInOutcome =
  | { kind: "signed-in"; userId: string; walletAddress: string }
  | { kind: "rejected" }
  | { kind: "unavailable"; detail: string }
  | { kind: "error"; detail: string }

/** True for the errors wallets raise when the user declines a request. */
export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null
  if (!e || typeof e !== "object") return false
  if (e.code === 4001) return true
  return /user rejected|rejected the request|request rejected|declined|cancell?ed by user|denied/i.test(String(e.message ?? ""))
}

/**
 * Signs the SIWS message with the wallet and exchanges it for a Supabase session.
 * `url` is only needed outside the browser; in the browser Supabase uses the current page URL.
 */
export async function signInWithSolanaWallet(
  client: SupabaseClient,
  address: string,
  signer: WalletSigner,
  url?: string,
): Promise<WalletSignInOutcome> {
  if (!SOLANA_ADDRESS_PATTERN.test(address)) return { kind: "error", detail: "Invalid wallet address" }

  let result: Awaited<ReturnType<SupabaseClient["auth"]["signInWithWeb3"]>>
  try {
    result = await client.auth.signInWithWeb3({
      chain: "solana",
      statement: WALLET_SIGN_IN_STATEMENT,
      wallet: toSupabaseSolanaWallet(address, signer),
      ...(url ? { options: { url } } : {}),
    })
  } catch (err) {
    if (isUserRejection(err)) return { kind: "rejected" }
    return { kind: "error", detail: err instanceof Error ? err.message : String(err) }
  }

  const { data, error } = result
  if (error) {
    const code = (error as { code?: string }).code
    if (code === "web3_provider_disabled" || code === "provider_disabled") return { kind: "unavailable", detail: error.message }
    return { kind: "error", detail: error.message }
  }

  // The session must belong to the wallet that signed; anything else is discarded.
  const signedInAddress = getSolanaWalletAddress(data.user)
  if (!data.user || signedInAddress !== address) {
    await client.auth.signOut({ scope: "local" }).catch(() => {})
    return { kind: "error", detail: "Signed-in wallet does not match the connected wallet" }
  }
  return { kind: "signed-in", userId: data.user.id, walletAddress: address }
}
