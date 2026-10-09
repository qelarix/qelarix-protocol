// Post-sign-in destination for the wallet sign-in pages. Edge-safe: no imports.

const BASE = "http://qelarix.invalid"

/**
 * Same-origin path (with query and hash) from ?callbackUrl= or ?redirect=, never an external URL.
 * Parsed with the URL parser, so "//host", "/\host" and control-character variants that a browser
 * would resolve to another origin fall back to `fallback`.
 */
export function safeReturnPath(params: URLSearchParams, fallback = "/"): string {
  const target = params.get("callbackUrl") ?? params.get("redirect")
  if (!target?.startsWith("/")) return fallback
  try {
    const url = new URL(target, BASE)
    return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : fallback
  } catch {
    return fallback
  }
}
