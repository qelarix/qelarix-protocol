import { Metadata } from "next";
import Link from "next/link";
import QelarixBackdrop from "@/components/ui/QelarixBackdrop";

export const metadata: Metadata = {
  title: "Privacy Policy — Qelarix",
  description: "GDPR-compliant privacy policy for the Qelarix service.",
};

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-10">
      <h2 className="text-xl font-semibold text-white mb-4">{title}</h2>
      <div className="text-white/65 text-sm leading-7 space-y-3">{children}</div>
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-medium text-white/85 mb-2">{title}</h3>
      <div className="text-white/60 text-sm leading-7">{children}</div>
    </div>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <QelarixBackdrop layer="behind" />
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-white mb-2">Privacy Policy</h1>
        <p className="text-white/40 text-sm">
          GDPR-compliant — Your right to privacy is our priority.
        </p>
        <p className="text-white/30 text-xs mt-2">Last updated: October 2026</p>
      </div>

      <Section id="controller" title="1. Data Controller">
        <p>
          The data controller for the purposes of the General Data Protection Regulation (GDPR) is:
        </p>
        <div
          className="p-4 rounded-xl mt-2"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <p>Qelarix, a project by Pixi Digital (founder: Pixi)</p>
          <p>
            E-mail:{" "}
            <a href="mailto:contact@pixidigital.io" className="text-purple-400">
              contact@pixidigital.io
            </a>
          </p>
        </div>
      </Section>

      <Section id="data-collected" title="2. Data we collect">
        <SubSection title="2.1 Registration data">
          <p>Your Solana wallet address (public key). You sign in by approving a sign-in message in your wallet, which Supabase Auth verifies; no password is used, and Qelarix never receives your private key or seed phrase. Optional profile details you add (display name, avatar).</p>
        </SubSection>
        <SubSection title="2.2 Usage data">
          <p>
            Prompts and generated content, QLC used, generation history,
            IP address (anonymized after 30 days), log files (errors, requests).
          </p>
        </SubSection>
        <SubSection title="2.3 Blockchain and payment data">
          <p>
            Qelarix does not process card payments. QLC purchases and generation charges are Solana transactions
            made from your own wallet. Your wallet address, balances and transactions are public on the Solana blockchain
            and cannot be changed or deleted by us. We store transaction references to link purchases and charges to your account.
          </p>
        </SubSection>
      </Section>

      <Section id="legal-basis" title="3. Legal basis for processing (Art. 6 GDPR)">
        <ul className="space-y-2">
          {[
            { art: "Art. 6(1)(b)", desc: "Performance of contract — providing the content generation service" },
            { art: "Art. 6(1)(a)", desc: "Consent — analytical cookies, marketing communications" },
            { art: "Art. 6(1)(c)", desc: "Legal obligation — accounting, taxes, financial reporting" },
            { art: "Art. 6(1)(f)", desc: "Legitimate interest — security, abuse prevention, service improvement" },
          ].map(({ art, desc }) => (
            <li key={art} className="flex gap-2">
              <span className="text-purple-400 font-medium flex-shrink-0">{art}</span>
              <span>{desc}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="third-parties" title="4. Service providers that process data for us">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                <th className="text-left py-2 pr-4 text-white/70 font-medium">Provider</th>
                <th className="text-left py-2 pr-4 text-white/70 font-medium">Purpose</th>
                <th className="text-left py-2 text-white/70 font-medium">Location</th>
              </tr>
            </thead>
            <tbody className="text-white/50">
              {[
                ["Supabase Inc.", "Database, authentication, file storage", "EU"],
                ["Vercel Inc.", "Hosting, server functions, request logs", "EU (Frankfurt), US company (SCCs)"],
                ["AI model providers: fal.ai, MuAPI, OpenAI, Anthropic, Google, xAI, Stability AI", "Process your prompts and uploaded images to create the content you request", "US (SCCs)"],
                ["Resend Inc.", "Emails, only if you add an email address", "US (SCCs)"],
                ["Solana network", "Public blockchain: your wallet address and QLC transactions", "Public, worldwide"],
              ].map(([provider, purpose, location]) => (
                <tr key={provider} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td className="py-2 pr-4">{provider}</td>
                  <td className="py-2 pr-4">{purpose}</td>
                  <td className="py-2">{location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-white/40">
          SCCs = Standard Contractual Clauses (Art. 46 GDPR)
        </p>
      </Section>

      <Section id="retention" title="5. Data retention periods">
        <ul className="space-y-1 list-disc list-inside">
          <li>User account: until account deletion + 30 days</li>
          <li>Generated content: 90 days (adjustable in Settings)</li>
          <li>Financial data: 10 years (legal obligation, § 147 AO)</li>
          <li>Log files: 30 days, IP anonymized</li>
          <li>Marketing consent: until consent is withdrawn</li>
        </ul>
      </Section>

      <Section id="rights" title="6. Your rights (Art. 15–22 GDPR)">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { right: "Right of access", desc: "A copy of all your data (Art. 15)" },
            { right: "Right to rectification", desc: "Correction of inaccurate data (Art. 16)" },
            { right: "Right to erasure", desc: "\"Right to be forgotten\" (Art. 17)" },
            { right: "Right to restriction", desc: "Restriction of processing (Art. 18)" },
            { right: "Right to portability", desc: "Your data in CSV/JSON (Art. 20)" },
            { right: "Right to object", desc: "Object to processing (Art. 21)" },
          ].map(({ right, desc }) => (
            <div
              key={right}
              className="p-3 rounded-xl"
              style={{ background: "rgba(123,97,255,0.06)", border: "1px solid rgba(123,97,255,0.15)" }}
            >
              <p className="text-purple-300 font-medium text-xs">{right}</p>
              <p className="text-white/50 text-xs">{desc}</p>
            </div>
          ))}
        </div>
        <p className="mt-4">
          To exercise your rights, contact:{" "}
          <a href="mailto:contact@pixidigital.io" className="text-purple-400">
            contact@pixidigital.io
          </a>
        </p>
      </Section>

      <Section id="cookies" title="7. Cookies">
        <p>
          Details about the cookies we use are available in our{" "}
          <Link href="/cookie-notice" className="text-purple-400 hover:text-purple-300">
            Cookie Notice
          </Link>
          .
        </p>
      </Section>

      <Section id="changes" title="8. Changes to this policy">
        <p>
          We reserve the right to amend this privacy policy. We will notify you of material changes
          by email at least 30 days in advance.
        </p>
      </Section>

      <div
        className="mt-10 pt-6 flex flex-wrap gap-4 text-xs"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <Link href="/impressum" className="text-white/40 hover:text-white/70 transition-colors">Impressum</Link>
        <Link href="/terms" className="text-white/40 hover:text-white/70 transition-colors">Terms of Service</Link>
        <Link href="/cookie-notice" className="text-white/40 hover:text-white/70 transition-colors">Cookie Notice</Link>
      </div>
    </div>
  );
}
