// Read-only on-chain facts about a wallet, used by campaign eligibility rules.
// Every read is memoized per instance, so one claim request never repeats an RPC call.

export interface SolanaAccountSignals {
  getBalanceLamports(address: string): Promise<bigint>
  /** True when the wallet has a finalized transaction at or before `cutoffUnixSeconds`. */
  hasActivityBefore(address: string, cutoffUnixSeconds: number): Promise<boolean>
  hasAtLeastTransactions(address: string, count: number): Promise<boolean>
  /** Raw token amount (base units) the wallet holds for `mint`, across all its token accounts. */
  getTokenBalance(owner: string, mint: string): Promise<bigint>
}

/** Signature history is scanned in pages of 1,000; anything that would need more pages is refused. */
export const SIGNATURE_PAGE_SIZE = 1000
export const MAX_SIGNATURE_PAGES = 10

interface SignatureInfo {
  signature: string
  blockTime: number | null
}

export function createSolanaAccountSignals(rpcUrl: string, fetchImpl: typeof fetch = fetch): SolanaAccountSignals {
  const cache = new Map<string, Promise<unknown>>()
  let requestId = 0

  function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!cache.has(key)) cache.set(key, load())
    return cache.get(key) as Promise<T>
  }

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    })
    if (!res.ok) throw new Error(`Solana RPC ${method} failed: HTTP ${res.status}`)
    const body = (await res.json()) as { result?: T; error?: { message?: string } }
    if (body.error) throw new Error(`Solana RPC ${method} failed: ${body.error.message ?? "unknown error"}`)
    return body.result as T
  }

  function signaturePage(address: string, before?: string): Promise<SignatureInfo[]> {
    return memo(`signatures:${address}:${before ?? ""}`, () =>
      rpc<SignatureInfo[]>("getSignaturesForAddress", [
        address,
        { limit: SIGNATURE_PAGE_SIZE, commitment: "finalized", ...(before ? { before } : {}) },
      ]),
    )
  }

  /** Walks history newest → oldest until `stop` returns true; false when history ends first. */
  async function scanSignatures(address: string, stop: (page: SignatureInfo[], seen: number) => boolean): Promise<boolean> {
    let before: string | undefined
    let seen = 0
    for (let pageIndex = 0; pageIndex < MAX_SIGNATURE_PAGES; pageIndex++) {
      const page = await signaturePage(address, before)
      seen += page.length
      if (stop(page, seen)) return true
      if (page.length < SIGNATURE_PAGE_SIZE) return false
      before = page[page.length - 1].signature
    }
    throw new Error("Signature history exceeds the scan limit")
  }

  return {
    getBalanceLamports: (address) =>
      memo(`balance:${address}`, async () => {
        const result = await rpc<{ value: number }>("getBalance", [address, { commitment: "finalized" }])
        return BigInt(result.value)
      }),

    hasActivityBefore: (address, cutoffUnixSeconds) =>
      memo(`activity:${address}:${cutoffUnixSeconds}`, () =>
        scanSignatures(address, (page) => page.some((s) => s.blockTime !== null && s.blockTime <= cutoffUnixSeconds)),
      ),

    hasAtLeastTransactions: (address, count) =>
      memo(`count:${address}:${count}`, async () => {
        if (count <= 0) return true
        if (count > SIGNATURE_PAGE_SIZE * MAX_SIGNATURE_PAGES) throw new Error("Transaction count exceeds the scan limit")
        return scanSignatures(address, (_page, seen) => seen >= count)
      }),

    getTokenBalance: (owner, mint) =>
      memo(`token:${owner}:${mint}`, async () => {
        const result = await rpc<{ value: { account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] }>(
          "getTokenAccountsByOwner",
          [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }],
        )
        return result.value.reduce((sum, entry) => sum + BigInt(entry.account.data.parsed?.info?.tokenAmount?.amount ?? "0"), BigInt(0))
      }),
  }
}
