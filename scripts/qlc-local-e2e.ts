// End-to-end check of the server QLC operator against a LOCAL validator (never devnet/mainnet):
// membership needs the wallet's co-signature (the operator alone is refused on chain), deliveries
// only to members, exactly-once retry, vault reuse, allowance, charge, refund, close, and charge
// numbers that can never be replayed, even after their receipt was closed.
//
//   npx tsx scripts/qlc-local-e2e.ts --funder <keypair.json> --operator <operator-keypair.json> --mint <QLC mint address>
//
// Member wallets are the owner's test identities wallet-1 and wallet-2 (scripts/test-identities.ts).
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit"
import { getTransferSolInstruction } from "@solana-program/system"
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda, getApproveCheckedInstruction } from "@solana-program/token-2022"
import { fetchConfig, findConfigPda, findSpendAuthorityPda } from "../src/lib/qlc/generated"
import { DeliveryKind, createQlcOperator } from "../src/lib/qlc/qlcOperator"
import { findChargeReceiptPda } from "../src/lib/qlc/qlcProgram"
import { requireTestSigner } from "./test-identities"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}
const option = (name: string) => process.argv[process.argv.indexOf(`--${name}`) + 1]
const id = (label: string) => new Uint8Array(createHash("sha256").update(label).digest())

async function main() {
  const rpc = createSolanaRpc("http://127.0.0.1:8899")
  const rpcSubscriptions = createSolanaRpcSubscriptions("ws://127.0.0.1:8900")
  if ((await rpc.getGenesisHash().send()) === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("Refusing: this script is for a local validator")
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(option("operator"), "utf8"))))
  const mint = address(option("mint"))
  const funder = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(option("funder"), "utf8"))))
  const fund = (to: TransactionSigner, sol: number) =>
    sendAs(funder, [getTransferSolInstruction({ source: funder, destination: to.address, amount: BigInt(sol * 1_000_000_000) })])
  await fund(operator, 10)

  const qlc = createQlcOperator({ rpc, rpcSubscriptions, operator, mint })
  const config = await qlc.selfCheck()
  check("self-check: program initialized for this mint and operator", config.qlcMint === mint && config.operator === operator.address)
  const [spendAuthority] = await findSpendAuthorityPda()

  const alice = await requireTestSigner("wallet-1")
  const bob = await requireTestSigner("wallet-2")
  await fund(alice, 1)
  check("new wallet is not a member yet", !(await qlc.isMember(alice.address)))

  const run = Date.now().toString()
  const operatorLamports = async () => (await rpc.getBalance(operator.address).send()).value
  const lamportsBefore = await operatorLamports()
  const refused = await qlc.deliver({ deliveryId: id(`purchase:${run}:1`), wallet: alice.address, amount: BigInt(1000), kind: DeliveryKind.Purchase })
  check("delivery to a non-member sends nothing (no auto-registration)", refused.status === "not_member" && (await operatorLamports()) === lamportsBefore && !(await qlc.isMember(alice.address)))

  // The operator alone cannot admit a wallet: register_member without the wallet's signature is refused on chain.
  const forged = await qlc.membershipInstruction(alice.address)
  const unsignedWallet = { ...forged, accounts: forged.accounts!.map((a) => (a.address === alice.address ? { address: a.address, role: AccountRole.READONLY } : a)) }
  let refusal = ""
  await sendAs(operator, [unsignedWallet]).catch((err) => (refusal = JSON.stringify(err?.context ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + String(err?.cause?.message ?? err?.message ?? err)))
  // Anchor AccountNotSigner = 3010 (0xbc2), raised by the program for the wallet account.
  check("operator alone cannot create a membership (program refuses: wallet signature required)", /3010|0xbc2|AccountNotSigner/.test(refusal) && !(await qlc.isMember(alice.address)), refusal.match(/AnchorError[^"]{0,120}|.{0,40}(3010|0xbc2).{0,40}/)?.[0] ?? refusal.slice(0, 160))

  // With the wallet's co-signature the wallet joins; Qelarix pays the rent.
  await sendAs(operator, [await qlc.membershipInstruction(alice)])
  const joined = await qlc.balance(alice.address, spendAuthority)
  check("wallet + operator signatures admit the member and thaw its QLC account", (await qlc.isMember(alice.address)) && joined.exists && !joined.frozen)

  const first = await qlc.deliver({ deliveryId: id(`purchase:${run}:1`), wallet: alice.address, amount: BigInt(1000), kind: DeliveryKind.Purchase })
  const aliceBalance = await qlc.balance(alice.address, spendAuthority)
  check("delivery to the member delivers 10.00 QLC", first.status === "delivered" && aliceBalance.amount === BigInt(1000), JSON.stringify({ status: first.status }))
  const retry = await qlc.deliver({ deliveryId: id(`purchase:${run}:1`), wallet: alice.address, amount: BigInt(1000), kind: DeliveryKind.Purchase })
  check("retrying the same delivery id never delivers twice", retry.status === "already_delivered" && (await qlc.balance(alice.address, spendAuthority)).amount === BigInt(1000))
  let offStep = false
  await qlc.deliver({ deliveryId: id(`purchase:${run}:x`), wallet: alice.address, amount: BigInt(101), kind: DeliveryKind.Purchase }).catch(() => (offStep = true))
  check("amounts off the 0.05 step are refused before sending", offStep)

  // The member approves the spend delegate once, with their own wallet.
  const [aliceAccount] = await findAssociatedTokenPda({ owner: alice.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  await sendAs(alice, [getApproveCheckedInstruction({ source: aliceAccount, mint, delegate: spendAuthority, owner: alice, amount: BigInt(600), decimals: 2 })])
  check("allowance approved by the member", (await qlc.balance(alice.address, spendAuthority)).allowance === BigInt(600))

  const seq1 = await qlc.nextChargeSeq(alice.address)
  check("first charge number of a new member is 1", seq1 === BigInt(1))
  await qlc.charge({ wallet: alice.address, seq: seq1, amount: BigInt(250) })
  const [configAddress] = await findConfigPda()
  const vault = (await fetchConfig(rpc, configAddress)).data.vault
  const vaultAfterCharge = (await rpc.getTokenAccountBalance(vault).send()).value.amount
  const afterCharge = await qlc.balance(alice.address, spendAuthority)
  check("charge moves 2.50 QLC to the vault without the member signing", afterCharge.amount === BigInt(750) && afterCharge.allowance === BigInt(350) && BigInt(vaultAfterCharge) >= BigInt(250))

  await qlc.refund({ wallet: alice.address, seq: seq1 })
  check("failed generation refunds the charge", (await qlc.balance(alice.address, spendAuthority)).amount === BigInt(1000))
  let secondRefund = false
  await qlc.refund({ wallet: alice.address, seq: seq1 }).catch(() => (secondRefund = true))
  check("a charge cannot be refunded twice", secondRefund)
  await qlc.closeCharge({ wallet: alice.address, seq: seq1 })
  check("closing the charge receipt recovers its rent", (await rpc.getAccountInfo(await findChargeReceiptPda({ wallet: alice.address, seq: seq1 })).send()).value === null)
  let replayAfterClose = false
  await qlc.charge({ wallet: alice.address, seq: seq1, amount: BigInt(250) }).catch(() => (replayAfterClose = true))
  let refundAfterClose = false
  await qlc.refund({ wallet: alice.address, seq: seq1 }).catch(() => (refundAfterClose = true))
  check("a closed charge number can never be charged or refunded again", replayAfterClose && refundAfterClose && (await qlc.balance(alice.address, spendAuthority)).amount === BigInt(1000))

  // Spent QLC is reused: charge, keep it in the vault, then deliver to another member.
  const seq2 = await qlc.nextChargeSeq(alice.address)
  await qlc.charge({ wallet: alice.address, seq: seq2, amount: BigInt(300) })
  await qlc.closeCharge({ wallet: alice.address, seq: seq2 })
  check("charge numbers only move forward", seq2 === BigInt(2) && (await qlc.nextChargeSeq(alice.address)) === BigInt(3))
  await sendAs(operator, [await qlc.membershipInstruction(bob)])
  const reuse = await qlc.deliver({ deliveryId: id(`reward:${run}:1`), wallet: bob.address, amount: BigInt(200), kind: DeliveryKind.Reward })
  check("reward delivery reuses vault inventory before minting", reuse.status === "delivered" && reuse.fromVault === BigInt(200) && reuse.minted === BigInt(0), JSON.stringify(reuse, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)

  async function sendAs(signer: TransactionSigner, instructions: Parameters<typeof appendTransactionMessageInstructions>[0]) {
    const { value: blockhash } = await rpc.getLatestBlockhash().send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const signed = await signTransactionMessageWithSigners(message)
    assertIsTransactionWithBlockhashLifetime(signed)
    await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(signed, { commitment: "confirmed" })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
