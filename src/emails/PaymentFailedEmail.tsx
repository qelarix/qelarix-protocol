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

interface PaymentFailedEmailProps {
  name: string
}

export function PaymentFailedEmail({ name }: PaymentFailedEmailProps) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://qelarix.com"

  return (
    <Html lang="en">
      <Head />
      <Preview>⚠️ Payment failed — update your card to keep access</Preview>
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
          <Section style={heroSection}>
            <Text style={iconStyle}>⚠️</Text>
            <Heading style={h1}>Payment failed</Heading>
            <Text style={heroSubtitle}>
              Hi {name}, we could not charge your subscription.
            </Text>
          </Section>

          {/* Info */}
          <Section style={infoSection}>
            <Text style={infoText}>
              There is a problem with your subscription. To keep access to all features,
              please update your payment details as soon as possible.
            </Text>
          </Section>

          {/* What happens */}
          <Section style={stepsSection}>
            <Heading as="h2" style={h2}>What happens next:</Heading>
            <div style={stepRow}>
              <Text style={stepDot}>•</Text>
              <Text style={stepText}>Generations will be temporarily disabled</Text>
            </div>
            <div style={stepRow}>
              <Text style={stepDot}>•</Text>
              <Text style={stepText}>Stripe will retry the charge within the next 48 hours</Text>
            </div>
            <div style={stepRow}>
              <Text style={stepDot}>•</Text>
              <Text style={stepText}>After 3 failed attempts the subscription is cancelled</Text>
            </div>
          </Section>

          {/* CTA */}
          <Section style={ctaSection}>
            <Button href={`${appUrl}/dashboard/billing`} style={ctaButton}>
              Update payment details →
            </Button>
          </Section>

          <Hr style={divider} />

          <Section>
            <Text style={footer}>
              If you think this is a mistake, contact us at{" "}
              <a href="mailto:contact@pixidigital.io" style={footerLink}>
                contact@pixidigital.io
              </a>
            </Text>
            <Text style={footer}>© {new Date().getFullYear()} Qelarix · GDPR compliant</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

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
const logoText: React.CSSProperties = {
  color: "#ffffff",
  fontSize: "20px",
  fontWeight: "700",
  margin: 0,
  display: "inline",
}

const heroSection: React.CSSProperties = {
  backgroundColor: "#12121a",
  borderRadius: "16px",
  padding: "40px 36px",
  marginBottom: "20px",
  border: "1px solid rgba(239, 68, 68, 0.3)",
  textAlign: "center",
}

const iconStyle: React.CSSProperties = { fontSize: "48px", margin: "0 0 12px", lineHeight: "1" }

const h1: React.CSSProperties = {
  fontSize: "26px",
  fontWeight: "700",
  color: "#ef4444",
  margin: "0 0 8px",
}

const heroSubtitle: React.CSSProperties = { color: "#a1a1aa", fontSize: "15px", margin: 0 }

const infoSection: React.CSSProperties = {
  backgroundColor: "rgba(239, 68, 68, 0.08)",
  borderRadius: "12px",
  padding: "16px 20px",
  marginBottom: "20px",
  border: "1px solid rgba(239, 68, 68, 0.2)",
}

const infoText: React.CSSProperties = { color: "#fca5a5", fontSize: "14px", margin: 0, lineHeight: "1.6" }

const stepsSection: React.CSSProperties = {
  backgroundColor: "#12121a",
  borderRadius: "16px",
  padding: "28px 32px",
  marginBottom: "24px",
  border: "1px solid rgba(255, 255, 255, 0.08)",
}

const h2: React.CSSProperties = { color: "#ffffff", fontSize: "16px", fontWeight: "600", margin: "0 0 14px" }

const stepRow: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "8px" }
const stepDot: React.CSSProperties = { color: "#ef4444", fontSize: "16px", margin: 0, flexShrink: 0 }
const stepText: React.CSSProperties = { color: "#d4d4d8", fontSize: "14px", margin: 0 }

const ctaSection: React.CSSProperties = { textAlign: "center", marginBottom: "32px" }

const ctaButton: React.CSSProperties = {
  display: "inline-block",
  padding: "14px 36px",
  background: "linear-gradient(135deg, #ef4444, #dc2626)",
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
