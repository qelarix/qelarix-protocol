// Native SOL payments: one System Program transfer from the payer to the treasury wallet, with the
// quote reference appended as a read-only account (ignored by the System Program, indexed by RPC).
import { AccountRole, getU32Encoder, getU64Encoder, type Address, type Instruction } from "@solana/kit"
import type { PaymentAsset } from "../paymentAssets"
import { lamportsOf } from "./splToken"
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

export const SYSTEM_PROGRAM = "11111111111111111111111111111111"
/** System Program instruction index of Transfer. */
const SYSTEM_TRANSFER = 2

export const nativeSolAdapter: PaymentAdapter = {
  kind: "native-sol",

  async destinationAccount(asset: PaymentAsset) {
    return asset.treasury
  },

  async preflight(rpc, _asset, payer, _destination, amount): Promise<PreflightResult> {
    const available = await lamportsOf(rpc, payer)
    if (available < amount + MIN_FEE_LAMPORTS) return { status: "insufficient_funds", required: amount + MIN_FEE_LAMPORTS, available }
    return { status: "ok" }
  },

  async transferInstruction({ payer, destinationAccount, amount, reference }: TransferInput): Promise<Instruction> {
    const data = new Uint8Array(12)
    data.set(getU32Encoder().encode(SYSTEM_TRANSFER), 0)
    data.set(getU64Encoder().encode(amount), 4)
    return {
      programAddress: SYSTEM_PROGRAM as Address,
      accounts: [
        { address: payer as Address, role: AccountRole.WRITABLE_SIGNER },
        { address: destinationAccount as Address, role: AccountRole.WRITABLE },
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

    const toTreasury = allInstructions(tx).filter(
      (ix) => ix.parsed?.info?.destination === expected.treasury && (ix.program === "system" || ix.programId === SYSTEM_PROGRAM),
    )
    if (toTreasury.length === 0) return { status: "rejected", reason: "no_transfer" }
    if (toTreasury.length > 1) return { status: "rejected", reason: "multiple_transfers" }
    const transfer = toTreasury[0]
    const info = transfer.parsed?.info ?? {}
    if (transfer.programId !== SYSTEM_PROGRAM || transfer.parsed?.type !== "transfer") return { status: "rejected", reason: "wrong_program" }
    if (info.source !== expected.payer) return { status: "rejected", reason: "wrong_source" }
    const lamports = info.lamports
    if (typeof lamports !== "number" || !Number.isSafeInteger(lamports) || BigInt(lamports) !== expected.amount) {
      return { status: "rejected", reason: "wrong_amount" }
    }

    // The treasury's SOL balance must have grown by exactly the amount (the treasury pays no fee).
    const index = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey === expected.treasury)
    const pre = tx.meta.preBalances?.[index]
    const post = tx.meta.postBalances?.[index]
    if (index < 0 || pre === undefined || post === undefined) return { status: "rejected", reason: "wrong_destination" }
    if (BigInt(post) - BigInt(pre) !== expected.amount) return { status: "rejected", reason: "balance_mismatch" }
    if (tx.blockTime === null) return { status: "rejected", reason: "missing_block_time" }

    return {
      status: "verified",
      payment: {
        signature,
        payer: expected.payer,
        treasury: expected.treasury,
        destinationAccount: expected.treasury,
        mint: null,
        amount: expected.amount,
        reference: expected.reference,
        slot: tx.slot,
        blockTime: new Date(tx.blockTime * 1000),
      },
    }
  },
}
