import type { PaymentAssetKind } from "../paymentAssets"
import { nativeSolAdapter } from "./nativeSol"
import { splTokenAdapter } from "./splToken"
import type { PaymentAdapter } from "./types"

export * from "./types"
export { findAssociatedTokenAddress } from "./splToken"

const ADAPTERS: Record<PaymentAssetKind, PaymentAdapter> = {
  "spl-token": splTokenAdapter,
  "native-sol": nativeSolAdapter,
}

export function adapterFor(kind: PaymentAssetKind): PaymentAdapter {
  return ADAPTERS[kind]
}
