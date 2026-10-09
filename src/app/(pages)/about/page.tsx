import { Metadata } from "next";
import Link from "next/link";
import QelarixBackdrop from "@/components/ui/QelarixBackdrop";

export const metadata: Metadata = {
  title: "About — Qelarix",
  description: "Qelarix is built by Pixi at Pixi Digital: an AI creation studio paid per creation through the Qelarix Protocol on Solana.",
};

const glass = {
  background: "rgba(24, 19, 40, 0.58)",
  border: "1px solid rgba(171, 143, 255, 0.16)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
} as const;

const principles = [
  { title: "Pay only for what you create", desc: "No subscription. Each generation costs a clear amount of QLC, and failed generations are refunded automatically." },
  { title: "Your balance, your wallet", desc: "QLC lives in your own Solana wallet. You approve a spending limit and can change or revoke it at any time." },
  { title: "Built for creators", desc: "Images, video, audio, storyboards and cinema tools in one calm workspace, designed for people who make content every week." },
  { title: "Privacy by default", desc: "Built in Europe with GDPR in mind. Qelarix does not train AI models on your prompts or creations." },
];

const protocol = [
  { label: "QLC token", text: "On-chain credits issued as a Solana Token-2022 token, controlled by the Qelarix program. No server key can mint or move them." },
  { label: "Charge and refund", text: "A generation reserves its cost before it runs and settles only on success. Every charge has an on-chain receipt and can never be replayed." },
  { label: "Wallet identity", text: "Sign in with your Solana wallet. No password, no email required." },
];

export default function AboutPage() {
  return (
    <div style={{ position: "relative", minHeight: "100vh", color: "#F4F7FB" }}>
      <QelarixBackdrop />
      <div className="relative mx-auto max-w-4xl px-4 sm:px-6 py-16" style={{ zIndex: 1 }}>
        {/* Hero */}
        <section className="mb-14">
          <span
            className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold mb-6"
            style={{ ...glass, borderRadius: 999, color: "#cfc6ff", letterSpacing: "0.18em", textTransform: "uppercase" }}
          >
            Pixi Digital · Qelarix Protocol
          </span>
          <h1 className="text-4xl sm:text-5xl font-semibold leading-tight mb-6" style={{ letterSpacing: "-0.03em" }}>
            An AI studio where you pay <span style={{ color: "#b9aeff" }}>per creation</span>, settled on Solana.
          </h1>
          <p className="text-lg leading-relaxed max-w-2xl" style={{ color: "rgba(246,240,255,0.68)" }}>
            Qelarix is built by Pixi, founder of Pixi Digital, a studio for web development and AI automation.
            It brings leading image, video and audio models into one workspace and replaces monthly subscriptions with
            QLC: on-chain credits you hold in your own wallet.
          </p>
        </section>

        {/* Story */}
        <section className="rounded-2xl p-7 mb-12" style={glass}>
          <p className="text-xs font-semibold uppercase mb-3" style={{ color: "#9edbff", letterSpacing: "0.18em" }}>Why Qelarix exists</p>
          <div className="space-y-4 text-base leading-relaxed" style={{ color: "rgba(246,240,255,0.72)" }}>
            <p>
              At Pixi Digital, Pixi creates images and video for clients every week. That meant juggling separate
              subscriptions for images, video and voice, paying every month whether he created or not, with credits
              locked inside each app and no clear view of where they went.
            </p>
            <p>
              Qelarix is the answer to that: one studio, one balance, and a fair rule. You pay for a creation only when
              it succeeds. The payment layer, the Qelarix Protocol, runs on Solana so every charge and refund is
              transparent and verifiable.
            </p>
          </div>
        </section>

        {/* Protocol */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6" style={{ letterSpacing: "-0.02em" }}>The Qelarix Protocol</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {protocol.map((p) => (
              <div key={p.label} className="rounded-2xl p-5" style={glass}>
                <p className="font-semibold mb-2">{p.label}</p>
                <p className="text-sm leading-relaxed" style={{ color: "rgba(246,240,255,0.62)" }}>{p.text}</p>
              </div>
            ))}
          </div>
          <p className="text-xs mt-4" style={{ color: "rgba(246,240,255,0.42)" }}>Running on Solana devnet during the beta.</p>
        </section>

        {/* Principles */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6" style={{ letterSpacing: "-0.02em" }}>What we stand for</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {principles.map((v) => (
              <div key={v.title} className="rounded-2xl p-6" style={glass}>
                <p className="font-semibold mb-2">{v.title}</p>
                <p className="text-sm leading-relaxed" style={{ color: "rgba(246,240,255,0.62)" }}>{v.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Contact */}
        <section className="rounded-2xl p-8 text-center" style={glass}>
          <h2 className="text-xl font-semibold mb-2">Talk to us</h2>
          <p className="text-sm mb-5" style={{ color: "rgba(246,240,255,0.6)" }}>
            Partnerships, press or feedback: we read every message.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/playground"
              className="px-5 py-2.5 rounded-xl text-white font-semibold text-sm transition-[filter] hover:brightness-110"
              style={{ background: "#6D5EF6" }}
            >
              Start creating
            </Link>
            <a
              href="mailto:contact@pixidigital.io"
              className="px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors hover:bg-white/10"
              style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.88)" }}
            >
              contact@pixidigital.io
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
