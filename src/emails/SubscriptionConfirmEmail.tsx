import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"
import * as React from "react"

export type SubscriptionPlan = "starter" | "pro" | "ultra" | "business"

interface SubscriptionConfirmEmailProps {
  name: string
  plan: SubscriptionPlan
}

const PLAN_DETAILS: Record<SubscriptionPlan, { label: string; credits: string; color: string; features: string[] }> = {
  starter: {
    label: "Starter",
    credits: "5,000",
    color: "#60a5fa",
    features: ["5,000 credits/month", "All AI image models", "HD video generation", "Email support"],
  },
  pro: {
    label: "Pro",
    credits: "20,000",
    color: "#a855f7",
    features: ["20,000 credits/month", "Priority generation", "Cinema Studio access", "4K output", "Priority support"],
  },
  ultra: {
    label: "Ultra",
    credits: "3,500",
    color: "#3BE7FF",
    features: ["3,500 credits/month", "All AI models", "White-label option", "Client Portal", "Make.com integration", "Dedicated support"],
  },
  business: {
    label: "Business",
    credits: "10,000",
    color: "#F59E0B",
    features: ["10,000 credits/month", "All AI models + early access", "White-label option", "Unlimited client portals", "Make.com integration", "API without rate limits", "Priority support"],
  },
}

export function SubscriptionConfirmEmail({ name, plan }: SubscriptionConfirmEmailProps) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://qelarix.com"
  const details = PLAN_DETAILS[plan]

  return (
    <Html lang="en">
      <Head />
      <Preview>✅ Your {details.label} subscription is active — {details.credits} credits are waiting for you!</Preview>
      <Body style={body}>
        <Container style={container}>
          {/* Logo */}
          <Section style={logoSection}>
            <div style={logoWrap}>
              <div style={logoBox} />
              <Text style={logoText}>Qelarix</Text>
            </div>
          </Section>

          {/* Hero */}
          <Section style={{ ...heroSection, borderColor: `${details.color}33` }}>
            <Text style={checkEmoji}>✅</Text>
            <Heading style={{ ...h1, color: details.color }}>
              {details.label} plan activated!
            </Heading>
            <Text style={heroSubtitle}>
              Hi {name}, your subscription has been activated.
            </Text>
          </Section>

          {/* Plan details */}
          <Section style={planSection}>
            <div style={{ ...planBadge, background: `${details.color}18`, borderColor: `${details.color}33` }}>
              <Text style={{ ...planName, color: details.color }}>{details.label} Plan</Text>
              <Text style={planCredits}>{details.credits} credits/month</Text>
            </div>

            <Heading as="h2" style={h2}>Included in your plan:</Heading>
            {details.features.map((feature) => (
              <div key={feature} style={featureRow}>
                <Text style={{ ...checkMark, color: details.color }}>✓</Text>
                <Text style={featureText}>{feature}</Text>
              </div>
            ))}
          </Section>

          {/* Info */}
          <Section style={infoSection}>
            <Text style={infoText}>
              💡 Credits renew automatically every month on your activation date.
              Unused credits do not carry over to the next period.
            </Text>
          </Section>

          {/* CTA */}
          <Section style={ctaSection}>
            <Button href={`${appUrl}/dashboard`} style={ctaButton}>
              Start creating →
            </Button>
          </Section>

          <Hr style={divider} />

          <Section>
            <Text style={footer}>
              Manage your subscription at{" "}
              <a href={`${appUrl}/dashboard/billing`} style={footerLink}>
                {appUrl}/dashboard/billing
              </a>
            </Text>
            <Text style={footer}>
              © {new Date().getFullYear()} Qelarix · GDPR compliant
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────────

const body: React.CSSProperties = {
  backgroundColor: "#050505",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  margin: 0,
  padding: 0,
}

const container: React.CSSProperties = { maxWidth: "600px", margin: "0 auto", padding: "40px 20px" }

const logoSection: React.CSSProperties = { marginBottom: "28px", textAlign: "center" }
const logoWrap: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "10px" }
const logoBox: React.CSSProperties = {
  width: "32px",
  height: "32px",
  borderRadius: "8px",
  background: "linear-gradient(135deg, #a855f7, #3b82f6)",
  display: "inline-block",
}
const logoText: React.CSSProperties = { color: "#ffffff", fontSize: "20px", fontWeight: "700", margin: 0, display: "inline" }

const heroSection: React.CSSProperties = {
  backgroundColor: "#12121a",
  borderRadius: "16px",
  padding: "40px 36px",
  marginBottom: "20px",
  border: "1px solid",
  textAlign: "center",
}

const checkEmoji: React.CSSProperties = { fontSize: "48px", margin: "0 0 12px", lineHeight: "1" }

const h1: React.CSSProperties = { fontSize: "26px", fontWeight: "700", margin: "0 0 8px" }

const heroSubtitle: React.CSSProperties = { color: "#a1a1aa", fontSize: "15px", margin: 0 }

const planSection: React.CSSProperties = {
  backgroundColor: "#12121a",
  borderRadius: "16px",
  padding: "32px",
  marginBottom: "20px",
  border: "1px solid rgba(255, 255, 255, 0.08)",
}

const planBadge: React.CSSProperties = {
  borderRadius: "12px",
  padding: "20px",
  marginBottom: "24px",
  border: "1px solid",
  textAlign: "center",
}

const planName: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: "700",
  textTransform: "uppercase" as const,
  letterSpacing: "1.5px",
  margin: "0 0 6px",
}

const planCredits: React.CSSProperties = {
  color: "#ffffff",
  fontSize: "28px",
  fontWeight: "800",
  margin: 0,
}

const h2: React.CSSProperties = { color: "#ffffff", fontSize: "16px", fontWeight: "600", margin: "0 0 14px" }

const featureRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }

const checkMark: React.CSSProperties = { fontSize: "16px", fontWeight: "700", margin: 0, flexShrink: 0 }

const featureText: React.CSSProperties = { color: "#d4d4d8", fontSize: "14px", margin: 0 }

const infoSection: React.CSSProperties = {
  backgroundColor: "rgba(59, 130, 246, 0.08)",
  borderRadius: "12px",
  padding: "16px 20px",
  marginBottom: "24px",
  border: "1px solid rgba(59, 130, 246, 0.2)",
}

const infoText: React.CSSProperties = { color: "#93c5fd", fontSize: "13px", margin: 0, lineHeight: "1.6" }

const ctaSection: React.CSSProperties = { textAlign: "center", marginBottom: "32px" }

const ctaButton: React.CSSProperties = {
  display: "inline-block",
  padding: "14px 36px",
  background: "linear-gradient(135deg, #a855f7, #3b82f6)",
  color: "#ffffff",
  textDecoration: "none",
  borderRadius: "12px",
  fontSize: "16px",
  fontWeight: "600",
}

const divider: React.CSSProperties = { borderColor: "rgba(255, 255, 255, 0.08)", margin: "0 0 24px" }

const footer: React.CSSProperties = {
  color: "#52525b",
  fontSize: "12px",
  textAlign: "center",
  margin: "0 0 4px",
  lineHeight: "1.6",
}

const footerLink: React.CSSProperties = { color: "#71717a", textDecoration: "underline" }
