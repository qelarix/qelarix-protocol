// Server-side QLC operations through the QLC program (server only). The operator key is a relayer
// and fee payer: it submits program instructions and pays fees and the member-account rent, but it
// holds no token authority and cannot admit a member alone (the wallet must co-sign). The program
// enforces membership, the 0.05 QLC step, limits, the mint window cap, exactly-once delivery (one
// on-chain receipt per delivery id) and strictly increasing charge numbers per member.
import {
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  partiallySignTransactionMessageWithSigners,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit"
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  getRevokeInstruction,
} from "@solana-program/token-2022"
import {
  ChargeStatus,
  DeliveryKind,
  fetchConfig,
  fetchMaybeChargeReceipt,
  fetchMaybeDeliveryReceipt,
  fetchMaybeMember,
  findConfigPda,
  findDeliveryReceiptPda,
  findMemberPda,
  getChargeInstructionAsync,
  getCloseChargeInstructionAsync,
  getDeliverInstructionAsync,
  getRefundInstructionAsync,
  getRegisterMemberInstructionAsync,
  type Config,
} from "./generated"
import { QLC_DECIMALS, findChargeReceiptPda, isQlcStep } from "./qlcProgram"

export { DeliveryKind }

export interface QlcOperatorDeps {
  rpc: Rpc<SolanaRpcApi>
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>
  operator: TransactionSigner
  mint: Address
}

export type DeliveryResult =
  | { status: "delivered"; signature: string; fromVault: bigint; minted: bigint }
  | { status: "already_delivered"; fromVault: bigint; minted: bigint }
  /** Nothing was sent: the wallet has not joined (it must co-sign register_member) or is suspended. */
  | { status: "not_member" }
  | { status: "member_suspended" }

export interface QlcBalance {
  tokenAccount: Address
  exists: boolean
  frozen: boolean
  amount: bigint
  /** Remaining spend allowance granted to the QLC spend delegate. */
  allowance: bigint
}

/** The program's current delivery and charge limits and pause state (base units). */
export interface QlcLimits {
  maxDeliveryAmount: bigint
  maxChargeAmount: bigint
  mintWindowCap: bigint
  paused: boolean
}

/** A wallet's membership: registered, suspended, and the last charge number the program accepted. */
export interface QlcMemberState {
  exists: boolean
  suspended: boolean
  lastChargeSeq: bigint
}

/** On-chain receipt of one charge: absent (never landed, or closed), charged, or refunded. */
export type QlcChargeReceiptState = { exists: false } | { exists: true; status: "charged" | "refunded"; amount: bigint }

export class QlcConfigurationError extends Error {
  name = "QlcConfigurationError"
}

/** The QLC program's custom error code carried by a failed transaction, or null (see generated/errors). */
export function qlcProgramErrorCode(err: unknown): number | null {
  for (let e: unknown = err, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return Number(e.context.code)
    const logs = (e as { context?: { logs?: unknown } }).context?.logs
    const text = `${(e as { message?: unknown }).message ?? ""} ${Array.isArray(logs) ? logs.join(" ") : ""}`
    const match = /custom program error: 0x([0-9a-f]+)/i.exec(text)
    if (match) return parseInt(match[1], 16)
  }
  return null
}

export function createQlcOperator({ rpc, rpcSubscriptions, operator, mint }: QlcOperatorDeps) {
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })

  async function send(instructions: Instruction[]): Promise<string> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(operator, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const signed = await signTransactionMessageWithSigners(message)
    assertIsTransactionWithBlockhashLifetime(signed)
    await sendAndConfirm(signed, { commitment: "confirmed" })
    return getSignatureFromTransaction(signed)
  }

  /** A transaction the wallet still has to sign: operator fee payer, partially signed by the operator. */
  async function walletTransaction(instructions: Instruction[]): Promise<string> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(operator, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message))
  }

  async function tokenAccountOf(wallet: Address): Promise<Address> {
    const [account] = await findAssociatedTokenPda({ owner: wallet, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    return account
  }

  function assertAmount(amount: bigint) {
    if (!isQlcStep(amount)) throw new RangeError("QLC amounts must be positive multiples of 0.05 QLC")
  }

  return {
    /** Confirms this deployment points at an initialized program for this mint and operator. */
    async selfCheck(): Promise<Config> {
      const [configAddress] = await findConfigPda()
      const config = await fetchConfig(rpc, configAddress).catch(() => null)
      if (!config) throw new QlcConfigurationError("QLC program is not initialized on this cluster")
      if (config.data.qlcMint !== mint) throw new QlcConfigurationError("QLC_MINT_ADDRESS does not match the program configuration")
      if (config.data.operator !== operator.address) throw new QlcConfigurationError("Operator key is not the program's configured operator")
      return config.data
    },

    /** Current on-chain delivery limits, read live (the admin can change them with update_config). */
    async limits(): Promise<QlcLimits> {
      const config = await fetchConfig(rpc, (await findConfigPda())[0])
      return {
        maxDeliveryAmount: config.data.maxDeliveryAmount,
        maxChargeAmount: config.data.maxChargeAmount,
        mintWindowCap: config.data.mintWindowCap,
        paused: config.data.paused,
      }
    },

    async member(wallet: Address): Promise<QlcMemberState> {
      const member = await fetchMaybeMember(rpc, (await findMemberPda({ wallet }))[0])
      if (!member.exists) return { exists: false, suspended: false, lastChargeSeq: BigInt(0) }
      return { exists: true, suspended: member.data.suspended, lastChargeSeq: member.data.lastChargeSeq }
    },

    /** The on-chain receipt of charge `seq` of `wallet`: the source of truth when a charge's outcome is unknown. */
    async chargeReceipt(input: { wallet: Address; seq: bigint }): Promise<QlcChargeReceiptState> {
      const receipt = await fetchMaybeChargeReceipt(rpc, await findChargeReceiptPda(input))
      if (!receipt.exists) return { exists: false }
      return { exists: true, status: receipt.data.status === ChargeStatus.Refunded ? "refunded" : "charged", amount: receipt.data.amount }
    },

    /**
     * The wallet's one-time "Enable QLC" transaction, or a later allowance change: register_member when
     * the wallet is not yet a member (Qelarix pays the member and token-account rent), then a finite
     * approve_checked of `allowance` to the program's spend delegate. Qelarix pays the fee: the operator
     * is fee payer and signs here; the wallet's signature slot stays empty for the wallet to sign.
     */
    async allowanceTransaction(input: { wallet: Address; spendAuthority: Address; allowance: bigint }): Promise<string> {
      assertAmount(input.allowance)
      const owner = createNoopSigner(input.wallet)
      const instructions: Instruction[] = []
      if (!(await fetchMaybeMember(rpc, (await findMemberPda({ wallet: input.wallet }))[0])).exists) {
        instructions.push(await getRegisterMemberInstructionAsync({ operator, wallet: owner, qlcMint: mint }))
      }
      instructions.push(
        getApproveCheckedInstruction(
          { source: await tokenAccountOf(input.wallet), mint, delegate: input.spendAuthority, owner, amount: input.allowance, decimals: QLC_DECIMALS },
          { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
        ),
      )
      return walletTransaction(instructions)
    },

    /** Revokes the wallet's whole spend allowance (Qelarix pays the fee; the wallet signs). */
    async revokeTransaction(wallet: Address): Promise<string> {
      const owner = createNoopSigner(wallet)
      return walletTransaction([getRevokeInstruction({ source: await tokenAccountOf(wallet), owner }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })])
    },

    async isMember(wallet: Address): Promise<boolean> {
      const [address] = await findMemberPda({ wallet })
      const member = await fetchMaybeMember(rpc, address)
      return member.exists && !member.data.suspended
    },

    /**
     * register_member for `wallet` (idempotent; Qelarix pays the member-account rent). The operator
     * signs; the wallet must sign too, as its consent. The server never holds the wallet key, so
     * the instruction travels inside a transaction the wallet signs (e.g. its payment).
     */
    async membershipInstruction(wallet: Address | TransactionSigner): Promise<Instruction> {
      const signer = typeof wallet === "string" ? createNoopSigner(wallet) : wallet
      return getRegisterMemberInstructionAsync({ operator, wallet: signer, qlcMint: mint })
    },

    /**
     * Delivers QLC exactly once per delivery id. A delivery id that already has an on-chain receipt
     * is never sent again. Wallets that are not (active) members get nothing sent.
     */
    async deliver(input: { deliveryId: Uint8Array; wallet: Address; amount: bigint; kind: DeliveryKind }): Promise<DeliveryResult> {
      assertAmount(input.amount)
      if (input.deliveryId.length !== 32) throw new RangeError("deliveryId must be 32 bytes")
      const [receiptAddress] = await findDeliveryReceiptPda({ deliveryId: input.deliveryId })
      const existing = await fetchMaybeDeliveryReceipt(rpc, receiptAddress)
      if (existing.exists) return { status: "already_delivered", fromVault: existing.data.fromVault, minted: existing.data.minted }

      const [memberAddress] = await findMemberPda({ wallet: input.wallet })
      const member = await fetchMaybeMember(rpc, memberAddress)
      if (!member.exists) return { status: "not_member" }
      if (member.data.suspended) return { status: "member_suspended" }
      const config = await fetchConfig(rpc, (await findConfigPda())[0])
      const instruction = await getDeliverInstructionAsync({
        operator,
        member: memberAddress,
        memberTokenAccount: await tokenAccountOf(input.wallet),
        qlcMint: mint,
        vault: config.data.vault,
        deliveryId: input.deliveryId,
        amount: input.amount,
        kind: input.kind,
      })
      try {
        const signature = await send([instruction])
        const receipt = await fetchMaybeDeliveryReceipt(rpc, receiptAddress)
        return receipt.exists
          ? { status: "delivered", signature, fromVault: receipt.data.fromVault, minted: receipt.data.minted }
          : { status: "delivered", signature, fromVault: BigInt(0), minted: BigInt(0) }
      } catch (err) {
        // A concurrent attempt may have delivered first; the receipt is the source of truth.
        const raced = await fetchMaybeDeliveryReceipt(rpc, receiptAddress)
        if (raced.exists) return { status: "already_delivered", fromVault: raced.data.fromVault, minted: raced.data.minted }
        throw err
      }
    },

    /**
     * The next unused charge number of a member. Callers record the number they use before sending,
     * so a retry reuses it: the program refuses any number at or below the member's last one.
     */
    async nextChargeSeq(wallet: Address): Promise<bigint> {
      const [memberAddress] = await findMemberPda({ wallet })
      const member = await fetchMaybeMember(rpc, memberAddress)
      if (!member.exists) throw new QlcConfigurationError("Wallet is not a QLC member")
      return member.data.lastChargeSeq + BigInt(1)
    },

    /** Charges a member from the allowance they approved; the QLC goes to the vault. */
    async charge(input: { wallet: Address; seq: bigint; amount: bigint }): Promise<string> {
      assertAmount(input.amount)
      const [memberAddress] = await findMemberPda({ wallet: input.wallet })
      const config = await fetchConfig(rpc, (await findConfigPda())[0])
      return send([
        await getChargeInstructionAsync({
          operator,
          member: memberAddress,
          memberTokenAccount: await tokenAccountOf(input.wallet),
          chargeReceipt: await findChargeReceiptPda({ wallet: input.wallet, seq: input.seq }),
          qlcMint: mint,
          vault: config.data.vault,
          seq: input.seq,
          amount: input.amount,
        }),
      ])
    },

    /** Returns a charge to the member, at most once (the program rejects a second refund). */
    async refund(input: { wallet: Address; seq: bigint }): Promise<string> {
      const [memberAddress] = await findMemberPda({ wallet: input.wallet })
      const config = await fetchConfig(rpc, (await findConfigPda())[0])
      return send([
        await getRefundInstructionAsync({
          operator,
          chargeReceipt: await findChargeReceiptPda(input),
          member: memberAddress,
          memberTokenAccount: await tokenAccountOf(input.wallet),
          qlcMint: mint,
          vault: config.data.vault,
        }),
      ])
    },

    /** Closes a final charge receipt and recovers its rent; its number stays used forever. */
    async closeCharge(input: { wallet: Address; seq: bigint }): Promise<string> {
      return send([await getCloseChargeInstructionAsync({ operator, chargeReceipt: await findChargeReceiptPda(input) })])
    },

    /** On-chain QLC balance and remaining spend allowance of a wallet (the authoritative balance). */
    async balance(wallet: Address, spendAuthority: Address): Promise<QlcBalance> {
      const tokenAccount = await tokenAccountOf(wallet)
      const account = await fetchMaybeToken(rpc, tokenAccount)
      if (!account.exists) return { tokenAccount, exists: false, frozen: false, amount: BigInt(0), allowance: BigInt(0) }
      const delegate = account.data.delegate.__option === "Some" ? account.data.delegate.value : null
      return {
        tokenAccount,
        exists: true,
        frozen: account.data.state === 2,
        amount: account.data.amount,
        allowance: delegate === spendAuthority ? account.data.delegatedAmount : BigInt(0),
      }
    },
  }
}

export type QlcOperator = ReturnType<typeof createQlcOperator>
