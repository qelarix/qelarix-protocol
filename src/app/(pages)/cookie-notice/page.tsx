"use client";

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
  { name: "theme", provider: "Qelarix", purpose: "Remembering dark/light theme preference", type: "Functional", duration: "1 year" },
  { name: "dashboard_layout", provider: "Qelarix", purpose: "Remembering user&apos;s preferred layout", type: "Functional", duration: "6 months" },
];

const typeColors: Record<Cookie["type"], string> = {
  Necessary: "rgba(34,197,94,0.15)",
  Analytical: "rgba(59,231,255,0.15)",
  Functional: "rgba(234,179,8,0.15)",
};

const typeTextColors: Record<Cookie["type"], string> = {
  Necessary: "#4ade80",
  Analytical: "#60a5fa",
  Functional: "#facc15",
};

export default function CookieNoticePage() {
  const necessary = cookies.filter((c) => c.type === "Necessary");
  const analytics = cookies.filter((c) => c.type === "Analytical");
  const functional = cookies.filter((c) => c.type === "Functional");

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <QelarixBackdrop layer="behind" />
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-white mb-2">Cookie Notice</h1>
        <p className="text-white/40 text-sm">
          A transparent list of all cookies we use — in compliance with GDPR / ePrivacy Directive.
        </p>
        <p className="text-white/30 text-xs mt-2">Last updated: May 2026</p>
      </div>

      {/* Consent controls */}
      <div
        className="p-5 rounded-2xl mb-10"
        style={{ background: "rgba(123,97,255,0.08)", border: "1px solid rgba(123,97,255,0.2)" }}
      >
        <h2 className="text-base font-semibold text-white mb-2">Consent management</h2>
        <p className="text-white/55 text-sm mb-4">
          You can change your cookie preferences at any time.
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
                    style={{ borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
                  >
                    <td className="px-4 py-3 text-white/80 font-mono">{cookie.name}</td>
                    <td className="px-4 py-3 text-white/55">{cookie.provider}</td>
                    <td className="px-4 py-3 text-white/55 max-w-xs">{cookie.purpose}</td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded-md text-xs font-medium"
                        style={{ background: typeColors[cookie.type], color: typeTextColors[cookie.type] }}
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

      <div
        className="mt-10 pt-6 flex flex-wrap gap-4 text-xs"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <Link href="/impressum" className="text-white/40 hover:text-white/70 transition-colors">Impressum</Link>
        <Link href="/privacy-policy" className="text-white/40 hover:text-white/70 transition-colors">Privacy Policy</Link>
        <Link href="/terms" className="text-white/40 hover:text-white/70 transition-colors">Terms of Service</Link>
      </div>
    </div>
  );
}
