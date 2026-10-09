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

interface CreditPurchaseEmailProps {
  name: string
  credits: number
  amount: number
  currency?: string
}

export function CreditPurchaseEmail({ name, credits, amount, currency = "EUR" }: CreditPurchaseEmailProps) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://qelarix.com"
  const formattedAmount = new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(amount / 100)
  const formattedCredits = credits.toLocaleString("en-US")

  return (
    <Html lang="en">
      <Head />
      <Preview>💳 Purchase successful — {formattedCredits} credits added to your account!</Preview>
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
            <Text style={coinEmoji}>💳</Text>
            <Heading style={h1}>Credit purchase successful!</Heading>
            <Text style={heroSubtitle}>Thank you, {name}. Your credits are available right away.</Text>
          </Section>

          {/* Receipt */}
          <Section style={receiptSection}>
            <Heading as="h2" style={h2}>Transaction receipt</Heading>

            <div style={receiptRow}>
              <Text style={receiptLabel}>Credits purchased</Text>
              <Text style={receiptValueHighlight}>+{formattedCredits}</Text>
            </div>

            <div style={receiptDivider} />

            <div style={receiptRow}>
              <Text style={receiptLabel}>Amount paid</Text>
              <Text style={receiptValue}>{formattedAmount}</Text>
            </div>

            <div style={receiptRow}>
              <Text style={receiptLabel}>Date</Text>
              <Text style={receiptValue}>{new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</Text>
            </div>

            <div style={receiptRow}>
              <Text style={receiptLabel}>Status</Text>
              <Text style={statusBadge}>✓ Successful</Text>
            </div>
          </Section>

          {/* Credit balance info */}
          <Section style={infoSection}>
            <Text style={infoText}>
              ⚡ The credits are already in your account and ready for image, video and audio generation.
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
              Questions about billing? Contact us at{" "}
              <a href="mailto:contact@pixidigital.io" style={footerLink}>
                contact@pixidigital.io
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
  background: "linear-gradient(135deg, #0d1f0d 0%, #0a1a2e 100%)",
  borderRadius: "16px",
  padding: "40px 36px",
  marginBottom: "20px",
  border: "1px solid rgba(34, 197, 94, 0.25)",
  textAlign: "center",
}

const coinEmoji: React.CSSProperties = { fontSize: "48px", margin: "0 0 12px", lineHeight: "1" }

const h1: React.CSSProperties = {
  color: "#22c55e",
  fontSize: "26px",
  fontWeight: "700",
  margin: "0 0 8px",
}

const heroSubtitle: React.CSSProperties = { color: "#a1a1aa", fontSize: "15px", margin: 0 }

const receiptSection: React.CSSProperties = {
  backgroundColor: "#12121a",
  borderRadius: "16px",
  padding: "32px",
  marginBottom: "20px",
  border: "1px solid rgba(255, 255, 255, 0.08)",
}

const h2: React.CSSProperties = { color: "#ffffff", fontSize: "16px", fontWeight: "600", margin: "0 0 20px" }

const receiptRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "12px",
}

const receiptLabel: React.CSSProperties = { color: "#71717a", fontSize: "14px", margin: 0 }
const receiptValue: React.CSSProperties = { color: "#d4d4d8", fontSize: "14px", fontWeight: "500", margin: 0 }

const receiptValueHighlight: React.CSSProperties = {
  color: "#22c55e",
  fontSize: "22px",
  fontWeight: "800",
  margin: 0,
}

const receiptDivider: React.CSSProperties = {
  height: "1px",
  backgroundColor: "rgba(255, 255, 255, 0.08)",
  margin: "16px 0",
}

const statusBadge: React.CSSProperties = {
  color: "#22c55e",
  fontSize: "13px",
  fontWeight: "600",
  backgroundColor: "rgba(34, 197, 94, 0.1)",
  border: "1px solid rgba(34, 197, 94, 0.25)",
  borderRadius: "20px",
  padding: "4px 12px",
  margin: 0,
}

const infoSection: React.CSSProperties = {
  backgroundColor: "rgba(168, 85, 247, 0.08)",
  borderRadius: "12px",
  padding: "16px 20px",
  marginBottom: "24px",
  border: "1px solid rgba(168, 85, 247, 0.2)",
}

const infoText: React.CSSProperties = { color: "#c4b5fd", fontSize: "13px", margin: 0, lineHeight: "1.6" }

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
