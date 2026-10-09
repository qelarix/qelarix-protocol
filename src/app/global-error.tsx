"use client"

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: "#050505", color: "#F4F7FB", display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", margin: 0, fontFamily: "sans-serif" }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: "#AAB2BF", fontSize: 14, marginBottom: 24 }}>{error?.message ?? "An unexpected error occurred."}</p>
          <button
            onClick={reset}
            style={{ background: "#7B61FF", color: "white", border: "none", borderRadius: 8, padding: "10px 24px", cursor: "pointer", fontWeight: 600, fontSize: 14 }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
