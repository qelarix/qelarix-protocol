// SPL token payments (USDC, future QLX, approved partner tokens) under the SPL Token or Token-2022
// program. The transfer is one TransferChecked from the payer's associated token account to the
// treasury's, with the quote reference appended as a read-only account. Tokens that need extra
// transfer accounts or take transfer fees are not supported by this adapter: their transfers would
// fail verification (balance change ≠ amount), so no QLC is ever delivered for them.
import { AccountRole, getAddressEncoder, getProgramDerivedAddress, getU64Encoder, type Address, type Instruction } from "@solana/kit"
import type { SolanaRpcCall } from "@/lib/solanaRpc"
import type { PaymentAsset } from "../paymentAssets"
import {
  MIN_FEE_LAMPORTS,
  allInstructions,
  payerSigned,
  referencePresent,
  type ExpectedPayment,
  type ParsedTransaction,
  type PaymentAdapter,
  type PaymentVerification,
  type PreflightResult,
  type TransferInput,
} from "./types"

export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
/** Token instruction index of TransferChecked (amount and decimals checked on chain). */
const TRANSFER_CHECKED = 12
const TOKEN_TRANSFER_TYPES = new Set(["transfer", "transferChecked"])

export async function findAssociatedTokenAddress(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const encoder = getAddressEncoder()
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM as Address,
    seeds: [encoder.encode(owner as Address), encoder.encode(tokenProgram as Address), encoder.encode(mint as Address)],
  })
  return ata
}

/** Token amount (base units) of a token account; null when the account does not exist. */
async function tokenBalance(rpc: SolanaRpcCall, account: string): Promise<bigint | null> {
  const { value } = await rpc<{ value: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } | null }>(
    "getAccountInfo",
    [account, { encoding: "jsonParsed", commitment: "confirmed" }],
  )
  const amount = value?.data?.parsed?.info?.tokenAmount?.amount
  return amount && /^\d+$/.test(amount) ? BigInt(amount) : null
}

export async function lamportsOf(rpc: SolanaRpcCall, address: string): Promise<bigint> {
  const { value } = await rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])
  return BigInt(value)
}

export const splTokenAdapter: PaymentAdapter = {
  kind: "spl-token",

  destinationAccount(asset: PaymentAsset) {
    return findAssociatedTokenAddress(asset.treasury, asset.mint!, asset.tokenProgram!)
  },

  async preflight(rpc, asset, payer, destinationAccount, amount): Promise<PreflightResult> {
    const payerAccount = await findAssociatedTokenAddress(payer, asset.mint!, asset.tokenProgram!)
    const [treasuryBalance, payerBalance, lamports] = await Promise.all([
      tokenBalance(rpc, destinationAccount),
      tokenBalance(rpc, payerAccount),
      lamportsOf(rpc, payer),
    ])
    if (treasuryBalance === null) return { status: "destination_not_ready" }
    const available = payerBalance ?? BigInt(0)
    if (available < amount) return { status: "insufficient_funds", required: amount, available }
    if (lamports < MIN_FEE_LAMPORTS) return { status: "insufficient_sol" }
    return { status: "ok" }
  },

  async transferInstruction({ asset, payer, destinationAccount, amount, reference }: TransferInput): Promise<Instruction> {
    const source = await findAssociatedTokenAddress(payer, asset.mint!, asset.tokenProgram!)
    const data = new Uint8Array(10)
    data[0] = TRANSFER_CHECKED
    data.set(getU64Encoder().encode(amount), 1)
    data[9] = asset.decimals
    return {
      programAddress: asset.tokenProgram as Address,
      accounts: [
        { address: source as Address, role: AccountRole.WRITABLE },
        { address: asset.mint as Address, role: AccountRole.READONLY },
        { address: destinationAccount as Address, role: AccountRole.WRITABLE },
        { address: payer as Address, role: AccountRole.READONLY_SIGNER },
        { address: reference as Address, role: AccountRole.READONLY },
      ],
      data,
    }
  },

  verify(signature: string, tx: ParsedTransaction | null, expected: ExpectedPayment): PaymentVerification {
    if (!tx || !tx.meta) return { status: "not_found" }
    if (tx.meta.err !== null && tx.meta.err !== undefined) return { status: "rejected", reason: "transaction_failed" }
    if (!payerSigned(tx, expected.payer)) return { status: "rejected", reason: "payer_not_signer" }
    if (!referencePresent(tx, expected.reference)) return { status: "rejected", reason: "reference_missing" }

    // Every token transfer into the treasury account, top-level or inner, must be exactly one.
    const toTreasury = allInstructions(tx).filter(
      (ix) => TOKEN_TRANSFER_TYPES.has(ix.parsed?.type ?? "") && ix.parsed?.info?.destination === expected.destinationAccount,
    )
    if (toTreasury.length === 0) return { status: "rejected", reason: "no_transfer" }
    if (toTreasury.length > 1) return { status: "rejected", reason: "multiple_transfers" }

    const transfer = toTreasury[0]
    const info = transfer.parsed?.info ?? {}
    const tokenAmount = info.tokenAmount as { amount?: string; decimals?: number } | undefined
    if (transfer.programId !== expected.tokenProgram || transfer.parsed?.type !== "transferChecked") {
      return { status: "rejected", reason: "wrong_program" }
    }
    if (info.mint !== expected.mint) return { status: "rejected", reason: "wrong_mint" }
    if (tokenAmount?.decimals !== expected.decimals) return { status: "rejected", reason: "wrong_decimals" }
    // The appended reference makes RPC parsers report the payer as "multisigAuthority" with the
    // reference as the only listed signer; the token program ignores it because the payer is a plain
    // wallet that signed. Anything else (a real multisig, other signers) is refused.
    const authority = info.authority ?? info.multisigAuthority
    const signers = info.signers
    const onlyReference = info.multisigAuthority === undefined || (Array.isArray(signers) && signers.length === 1 && signers[0] === expected.reference)
    if (authority !== expected.payer || !onlyReference) return { status: "rejected", reason: "wrong_authority" }
    if (!/^\d+$/.test(tokenAmount?.amount ?? "") || BigInt(tokenAmount!.amount!) !== expected.amount) {
      return { status: "rejected", reason: "wrong_amount" }
    }

    // The source must be the payer's own token account for this mint.
    const keys = tx.transaction.message.accountKeys
    const sourceIndex = keys.findIndex((key) => key.pubkey === info.source)
    const source = tx.meta.preTokenBalances?.find((b) => b.accountIndex === sourceIndex)
    if (!source || source.owner !== expected.payer || source.mint !== expected.mint) return { status: "rejected", reason: "wrong_source" }

    // The treasury account's balance change must confirm the transfer: right owner, mint and delta.
    const index = keys.findIndex((key) => key.pubkey === expected.destinationAccount)
    const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === index)
    const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === index)
    if (!post || post.owner !== expected.treasury || post.mint !== expected.mint) return { status: "rejected", reason: "wrong_destination" }
    if (pre && (pre.owner !== expected.treasury || pre.mint !== expected.mint)) return { status: "rejected", reason: "wrong_destination" }
    if (BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0") !== expected.amount) {
      return { status: "rejected", reason: "balance_mismatch" }
    }
    if (tx.blockTime === null) return { status: "rejected", reason: "missing_block_time" }

    return {
      status: "verified",
      payment: {
        signature,
        payer: expected.payer,
        treasury: expected.treasury,
        destinationAccount: expected.destinationAccount,
        mint: expected.mint,
        amount: expected.amount,
        reference: expected.reference,
        slot: tx.slot,
        blockTime: new Date(tx.blockTime * 1000),
      },
    }
  },
}
