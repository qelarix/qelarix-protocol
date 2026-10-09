import { Metadata } from "next";
import QelarixBackdrop from "@/components/ui/QelarixBackdrop";

export const metadata: Metadata = {
  title: "Contact — Qelarix",
  description: "Contact the Qelarix team at Pixi Digital.",
};

const EMAIL = "contact@pixidigital.io";

const glass = {
  background: "rgba(24, 19, 40, 0.58)",
  border: "1px solid rgba(171, 143, 255, 0.16)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
} as const;

const topics = [
  { title: "Support", desc: "Questions about generations, QLC, your wallet or your account.", subject: "Qelarix support" },
  { title: "Bug report", desc: "Something did not work as expected. Include the page and what you did.", subject: "Qelarix bug report" },
  { title: "Partnerships and press", desc: "Integrations, collaborations, media and interviews.", subject: "Qelarix partnership" },
];

export default function ContactPage() {
  return (
    <div style={{ position: "relative", minHeight: "100vh", color: "#F4F7FB" }}>
      <QelarixBackdrop />
      <div className="relative mx-auto max-w-3xl px-4 sm:px-6 py-16" style={{ zIndex: 1 }}>
        <h1 className="text-4xl font-semibold mb-3" style={{ letterSpacing: "-0.03em" }}>Contact</h1>
        <p className="text-lg mb-10" style={{ color: "rgba(246,240,255,0.68)" }}>
          Qelarix is built by Pixi Digital. Write to us directly. We read every message.
        </p>

        <div className="space-y-4 mb-10">
          {topics.map((t) => (
            <a
              key={t.title}
              href={`mailto:${EMAIL}?subject=${encodeURIComponent(t.subject)}`}
              className="flex items-center justify-between gap-4 rounded-2xl p-5 transition-colors hover:bg-white/5"
              style={glass}
            >
              <div>
                <p className="font-semibold mb-1">{t.title}</p>
                <p className="text-sm" style={{ color: "rgba(246,240,255,0.6)" }}>{t.desc}</p>
              </div>
              <span className="text-sm font-semibold flex-shrink-0" style={{ color: "#b9aeff" }}>Email us</span>
            </a>
          ))}
        </div>

        <div className="rounded-2xl p-6 text-center" style={glass}>
          <p className="text-sm mb-2" style={{ color: "rgba(246,240,255,0.6)" }}>Email</p>
          <a href={`mailto:${EMAIL}`} className="text-xl font-semibold" style={{ color: "#F4F7FB" }}>{EMAIL}</a>
        </div>
      </div>
    </div>
  );
}
