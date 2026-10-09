import { getAddressDecoder } from "@solana/kit"

/** A random public key used once per quote to find its payment on chain. Nobody holds its key. */
export function createPaymentReference(): string {
  return getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)))
}
