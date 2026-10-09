"use client"

import Link from "next/link";
import QelarixBackdrop from "@/components/ui/QelarixBackdrop";

interface Cookie {
  name: string;
  provider: string;
  purpose: string;
  type: "Necessary" | "Analytical" | "Functional";
  duration: string;
}

const cookies: Cookie[] = [
  { name: "sb-<project>-auth-token", provider: "Supabase", purpose: "Authentication — wallet sign-in session (access and refresh token)", type: "Necessary", duration: "400 days (cleared on sign-out)" },
  { name: "cookie_consent_v2", provider: "Qelarix", purpose: "Stores your cookie preferences", type: "Necessary", duration: "12 months" },
  { name: "_vercel_jwt", provider: "Vercel", purpose: "Access to protected Vercel deployments", type: "Necessary", duration: "Session" },
  { name: "theme", provider: "Qelarix", purpose: "Remembering dark/light theme preference", type: "Functional", duration: "1 year" },
  { name: "dashboard_layout", provider: "Qelarix", purpose: "Remembering user preferred layout", type: "Functional", duration: "6 months" },
];

const typeColors: Record<Cookie["type"], string> = {
  "Necessary": "rgba(34,197,94,0.15)",
  "Analytical": "rgba(59,231,255,0.15)",
  "Functional": "rgba(234,179,8,0.15)",
};

const typeTextColors: Record<Cookie["type"], string> = {
  "Necessary": "#4ade80",
  "Analytical": "#60a5fa",
  "Functional": "#facc15",
};

export default function CookiePolicyPage() {
  const necessary = cookies.filter((c) => c.type === "Necessary");
  const analytics = cookies.filter((c) => c.type === "Analytical");
  const functional = cookies.filter((c) => c.type === "Functional");

  return (
    <div className="min-h-screen">
      <QelarixBackdrop layer="behind" />
      <div
        className="border-b"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link
            href="/"
            className="text-white/60 hover:text-white text-sm transition-colors flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </Link>
          <span className="text-white/30 text-xs">Last updated: May 2026</span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-white mb-2">Cookie Policy</h1>
          <p className="text-white/40 text-sm">
            A transparent list of all cookies we use — in compliance with GDPR / ePrivacy Directive.
          </p>
        </div>

        {/* Consent controls */}
        <div
          className="p-5 rounded-2xl mb-10"
          style={{ background: "rgba(123,97,255,0.08)", border: "1px solid rgba(123,97,255,0.2)" }}
        >
          <h2 className="text-base font-semibold text-white mb-2">Consent management</h2>
          <p className="text-white/55 text-sm mb-4">
            You can change your cookie preferences at any time. Necessary cookies cannot be disabled —
            they are required for the Platform to function.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => {
                if (typeof window !== "undefined") {
                  localStorage.setItem("cookie_consent_v2", "all");
                  window.location.reload();
                }
              }}
              className="px-4 py-2 rounded-xl text-sm font-medium text-white transition-all hover:opacity-90"
              style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
            >
              Accept all
            </button>
            <button
              onClick={() => {
                if (typeof window !== "undefined") {
                  localStorage.setItem("cookie_consent_v2", "essential");
                  window.location.reload();
                }
              }}
              className="px-4 py-2 rounded-xl text-sm font-medium text-white/70 hover:text-white transition-all"
              style={{ border: "1px solid rgba(255,255,255,0.12)" }}
            >
              Necessary only
            </button>
            <button
              onClick={() => {
                if (typeof window !== "undefined") {
                  localStorage.removeItem("cookie_consent_v2");
                  window.location.reload();
                }
              }}
              className="px-4 py-2 rounded-xl text-sm font-medium text-red-400/70 hover:text-red-400 transition-all"
              style={{ border: "1px solid rgba(239,68,68,0.15)" }}
            >
              Reset consent
            </button>
          </div>
        </div>

        {/* Cookie table per category */}
        {[
          { label: "Necessary cookies", items: necessary, desc: "These cookies are essential for the Platform to function and cannot be disabled." },
          { label: "Analytical cookies", items: analytics, desc: "Help us understand how users use the Platform — only with your consent." },
          { label: "Functional cookies", items: functional, desc: "Remember your preferences for a better experience — only with your consent." },
        ].map(({ label, items, desc }) => (
          <section key={label} className="mb-10">
            <h2 className="text-lg font-semibold text-white mb-2">{label}</h2>
            <p className="text-white/50 text-sm mb-4">{desc}</p>
            <div className="overflow-x-auto rounded-xl" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Name</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Provider</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Purpose</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Type</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((cookie, i) => (
                    <tr
                      key={cookie.name}
                      style={{
                        borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                      }}
                    >
                      <td className="px-4 py-3 text-white/80 font-mono">{cookie.name}</td>
                      <td className="px-4 py-3 text-white/55">{cookie.provider}</td>
                      <td className="px-4 py-3 text-white/55 max-w-xs">{cookie.purpose}</td>
                      <td className="px-4 py-3">
                        <span
                          className="px-2 py-0.5 rounded-md text-xs font-medium"
                          style={{
                            background: typeColors[cookie.type],
                            color: typeTextColors[cookie.type],
                          }}
                        >
                          {cookie.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-white/55 whitespace-nowrap">{cookie.duration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <section className="mb-10">
          <h2 className="text-lg font-semibold text-white mb-3">How to disable cookies</h2>
          <p className="text-white/60 text-sm leading-7">
            In addition to the controls above, you can also disable cookies in your browser settings.
            Note that disabling necessary cookies may impair Platform functionality.
            Instructions for popular browsers:
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {[
              { name: "Google Chrome", link: "https://support.google.com/chrome/answer/95647" },
              { name: "Mozilla Firefox", link: "https://support.mozilla.org/en-US/kb/clear-cookies-and-site-data-firefox" },
              { name: "Safari", link: "https://support.apple.com/en-us/guide/safari/sfri11471/mac" },
              { name: "Microsoft Edge", link: "https://support.microsoft.com/en-us/microsoft-edge/delete-cookies" },
            ].map(({ name, link }) => (
              <li key={name}>
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-400 hover:text-purple-300 underline underline-offset-2 transition-colors"
                >
                  {name}
                </a>
              </li>
            ))}
          </ul>
        </section>

        <div
          className="mt-10 pt-6 flex flex-wrap gap-4 text-xs"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          <Link href="/impressum" className="text-white/40 hover:text-white/70 transition-colors">
            Impressum
          </Link>
          <Link href="/privacy" className="text-white/40 hover:text-white/70 transition-colors">
            Privacy Policy
          </Link>
          <Link href="/terms" className="text-white/40 hover:text-white/70 transition-colors">
            Terms of Service
          </Link>
        </div>
      </div>
    </div>
  );
}
