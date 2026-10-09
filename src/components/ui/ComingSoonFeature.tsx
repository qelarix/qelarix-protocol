import Link from "next/link"
import QelarixBackdrop from "@/components/ui/QelarixBackdrop"
import QelarixGridBackdrop from "@/components/ui/QelarixGridBackdrop"

// Full-page "coming soon" announcement for a planned Qelarix surface (API, MCP), on the live
// Qelarix background in the page's own tone (live waves for most tones, a live line grid for "yellow").
export default function ComingSoonFeature({
  tone,
  accent,
  accentText,
  eyebrow,
  title,
  highlight,
  body,
  points,
}: {
  tone: "gold" | "crimson" | "teal" | "magenta" | "orange" | "yellow"
  accent: string
  accentText: string
  eyebrow: string
  title: string
  highlight: string
  body: string
  points: { title: string; text: string }[]
}) {
  return (
    <div className="relative min-h-screen">
      {tone === "yellow" ? <QelarixGridBackdrop tone="yellow" /> : <QelarixBackdrop tone={tone} />}
      <div className="relative mx-auto w-full max-w-4xl px-4 sm:px-6 pt-24 pb-20 text-center" style={{ zIndex: 1 }}>
        <span
          className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em]"
          style={{ color: accent, background: "rgba(0,0,0,0.28)" }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent, boxShadow: `0 0 10px ${accent}` }} />
          {eyebrow}
        </span>

        <h1 className="mt-6 text-4xl sm:text-6xl font-bold tracking-tight text-white">
          {title} <span style={{ color: accent }}>{highlight}</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base sm:text-lg leading-relaxed text-white/65">{body}</p>

        <div className="mt-12 grid gap-4 sm:grid-cols-3 text-left">
          {points.map((point) => (
            <div key={point.title} className="rounded-2xl p-5" style={{ background: "rgba(0,0,0,0.32)", backdropFilter: "blur(10px)" }}>
              <h2 className="text-sm font-semibold text-white">{point.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-white/55">{point.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center gap-3">
          <p className="text-sm text-white/45">Coming soon. Until then, everything is available in the studio.</p>
          <Link
            href="/playground"
            className="rounded-xl px-6 py-3 text-sm font-semibold transition-opacity hover:opacity-90"
            style={{ background: accent, color: accentText }}
          >
            Start creating
          </Link>
        </div>
      </div>
    </div>
  )
}
