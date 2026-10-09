// Minimal Solana JSON-RPC client for server code. Network, HTTP and RPC errors throw
// SolanaRpcError so callers can treat them as transient; nothing is retried here.

export class SolanaRpcError extends Error {
  name = "SolanaRpcError"
}

export type SolanaRpcCall = <T>(method: string, params: unknown[]) => Promise<T>

export function createSolanaRpcCall(rpcUrl: string, fetchImpl: typeof fetch = fetch): SolanaRpcCall {
  let requestId = 0
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    let res: Response
    try {
      res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        cache: "no-store",
      })
    } catch (err) {
      throw new SolanaRpcError(`Solana RPC ${method} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new SolanaRpcError(`Solana RPC ${method} failed: HTTP ${res.status}`)
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null
    if (!body) throw new SolanaRpcError(`Solana RPC ${method} failed: invalid response`)
    if (body.error) throw new SolanaRpcError(`Solana RPC ${method} failed: ${body.error.message ?? "unknown error"}`)
    return body.result as T
  }
}
