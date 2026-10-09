// Contract every payment asset adapter implements. An adapter builds the transfer instruction for a
// stored quote and independently verifies a finalized transaction against it. Verification is pure:
// it only reads the transaction fetched by the server; nothing reported by the client is trusted.
import type { Instruction } from "@solana/kit"
import type { SolanaRpcCall } from "@/lib/solanaRpc"
import type { PaymentAsset, PaymentAssetKind } from "../paymentAssets"

export interface ExpectedPayment {
  payer: string
  /** Wallet that receives the payment. */
  treasury: string
  /** Account whose balance must increase: the treasury's token account, or the treasury itself for SOL. */
  destinationAccount: string
  /** Base units of the payment asset. */
  amount: bigint
  reference: string
  mint: string | null
  tokenProgram: string | null
  decimals: number
}

export interface VerifiedPayment {
  signature: string
  payer: string
  treasury: string
  destinationAccount: string
  mint: string | null
  amount: bigint
  reference: string
  slot: number
  blockTime: Date
}

export type PaymentRejection =
  | "transaction_failed"
  | "payer_not_signer"
  | "reference_missing"
  | "no_transfer"
  | "multiple_transfers"
  | "wrong_program"
  | "wrong_mint"
  | "wrong_decimals"
  | "wrong_authority"
  | "wrong_source"
  | "wrong_amount"
  | "wrong_destination"
  | "balance_mismatch"
  | "missing_block_time"

export type PaymentVerification =
  /** Not finalized yet, or unknown to the RPC node. */
  | { status: "not_found" }
  | { status: "rejected"; reason: PaymentRejection }
  | { status: "verified"; payment: VerifiedPayment }

export interface ParsedAccountKey {
  pubkey: string
  signer: boolean
}

export interface ParsedInstruction {
  programId?: string
  program?: string
  parsed?: { type?: string; info?: Record<string, unknown> }
}

export interface TokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string; decimals: number }
}

export interface ParsedTransaction {
  slot: number
  blockTime: number | null
  meta: {
    err: unknown
    preBalances?: number[]
    postBalances?: number[]
    preTokenBalances?: TokenBalance[]
    postTokenBalances?: TokenBalance[]
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[]
  } | null
  transaction: { message: { accountKeys: ParsedAccountKey[]; instructions: ParsedInstruction[] } }
}

export type PreflightResult =
  | { status: "ok" }
  | { status: "destination_not_ready" }
  | { status: "insufficient_funds"; required: bigint; available: bigint }
  | { status: "insufficient_sol" }

export interface TransferInput {
  asset: PaymentAsset
  payer: string
  destinationAccount: string
  amount: bigint
  reference: string
}

export interface PaymentAdapter {
  kind: PaymentAssetKind
  destinationAccount(asset: PaymentAsset): Promise<string>
  /** Cheap pre-checks before a quote is stored; the chain remains the final arbiter. */
  preflight(rpc: SolanaRpcCall, asset: PaymentAsset, payer: string, destinationAccount: string, amount: bigint): Promise<PreflightResult>
  /** The payment transfer, with the quote reference appended as a read-only account. */
  transferInstruction(input: TransferInput): Promise<Instruction>
  verify(signature: string, tx: ParsedTransaction | null, expected: ExpectedPayment): PaymentVerification
}

/**
 * Fee headroom required in the payer's SOL balance (lamports): the payer pays for two signatures
 * (its own and the operator's, 5,000 lamports each), plus margin.
 */
export const MIN_FEE_LAMPORTS = BigInt(20_000)

export function referencePresent(tx: ParsedTransaction, reference: string): boolean {
  return tx.transaction.message.accountKeys.some((key) => key.pubkey === reference)
}

export function payerSigned(tx: ParsedTransaction, payer: string): boolean {
  return tx.transaction.message.accountKeys.some((key) => key.pubkey === payer && key.signer)
}

export function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  return [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions)]
}
