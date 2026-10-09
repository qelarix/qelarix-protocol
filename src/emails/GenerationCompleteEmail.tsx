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

export type GenerationType = "video" | "image" | "audio"

interface GenerationCompleteEmailProps {
  name: string
  generationType: GenerationType
  prompt: string
  generationId: string
  creditsUsed: number
  durationSeconds?: number
}

const TYPE_META: Record<GenerationType, { emoji: string; label: string; color: string }> = {
  video: { emoji: "🎬", label: "Video", color: "#a855f7" },
  image: { emoji: "🎨", label: "Image", color: "#3b82f6" },
  audio: { emoji: "🎵", label: "Audio", color: "#ec4899" },
}

export function GenerationCompleteEmail({
  name,
  generationType,
  prompt,
  generationId,
  creditsUsed,
  durationSeconds,
}: GenerationCompleteEmailProps) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://qelarix.com"
  const meta = TYPE_META[generationType]
  const truncatedPrompt = prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt
  const outputUrl = `${appUrl}/dashboard/generations/${generationId}`
  const durationDisplay = durationSeconds ? `${Math.round(durationSeconds)}s` : null

  return (
    <Html lang="en">
      <Head />
      <Preview>{meta.emoji} Your {meta.label.toLowerCase()} generation is ready!</Preview>
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
          <Section style={{ ...heroSection, borderColor: `${meta.color}33` }}>
            <Text style={typeEmoji}>{meta.emoji}</Text>
            <Heading style={{ ...h1, color: meta.color }}>
              {meta.label} generation complete!
            </Heading>
            <Text style={heroSubtitle}>
              Hi {name}, your content is ready to view.
            </Text>
          </Section>

          {/* Generation details */}
          <Section style={detailsSection}>
            <Heading as="h2" style={h2}>Generation details</Heading>

            <div style={promptBox}>
              <Text style={promptLabel}>Prompt</Text>
              <Text style={promptText}>&ldquo;{truncatedPrompt}&rdquo;</Text>
            </div>

            <div style={statsRow}>
              <div style={statCard}>
                <Text style={statValue}>{meta.label}</Text>
                <Text style={statLabel}>Type</Text>
              </div>
              <div style={statCard}>
                <Text style={{ ...statValue, color: "#fbbf24" }}>{creditsUsed}</Text>
                <Text style={statLabel}>Credits used</Text>
              </div>
              {durationDisplay && (
                <div style={statCard}>
                  <Text style={{ ...statValue, color: meta.color }}>{durationDisplay}</Text>
                  <Text style={statLabel}>Duration</Text>
                </div>
              )}
            </div>
          </Section>

          {/* Info */}
          <Section style={infoSection}>
            <Text style={infoText}>
              💡 Generated content stays in your dashboard for 30 days.
              Download it soon so you do not lose it.
            </Text>
          </Section>

          {/* CTA */}
          <Section style={ctaSection}>
            <Button href={outputUrl} style={{ ...ctaButton, background: `linear-gradient(135deg, ${meta.color}, #3b82f6)` }}>
              View {meta.label.toLowerCase()} →
            </Button>
          </Section>

          <Hr style={divider} />

          <Section>
            <Text style={footer}>
              You received this email because your generation took longer than 30 seconds.
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

const typeEmoji: React.CSSProperties = { fontSize: "48px", margin: "0 0 12px", lineHeight: "1" }
const h1: React.CSSProperties = { fontSize: "26px", fontWeight: "700", margin: "0 0 8px" }
const heroSubtitle: React.CSSProperties = { color: "#a1a1aa", fontSize: "15px", margin: 0 }

const detailsSection: React.CSSProperties = {
  backgroundColor: "#12121a",
  borderRadius: "16px",
  padding: "32px",
  marginBottom: "20px",
  border: "1px solid rgba(255, 255, 255, 0.08)",
}

const h2: React.CSSProperties = { color: "#ffffff", fontSize: "16px", fontWeight: "600", margin: "0 0 16px" }

const promptBox: React.CSSProperties = {
  backgroundColor: "rgba(255, 255, 255, 0.04)",
  borderRadius: "10px",
  padding: "16px",
  marginBottom: "20px",
  border: "1px solid rgba(255, 255, 255, 0.06)",
}

const promptLabel: React.CSSProperties = {
  color: "#71717a",
  fontSize: "11px",
  fontWeight: "600",
  textTransform: "uppercase" as const,
  letterSpacing: "1px",
  margin: "0 0 6px",
}

const promptText: React.CSSProperties = {
  color: "#d4d4d8",
  fontSize: "14px",
  margin: 0,
  lineHeight: "1.6",
  fontStyle: "italic",
}

const statsRow: React.CSSProperties = { display: "flex", gap: "12px" }

const statCard: React.CSSProperties = {
  flex: "1",
  backgroundColor: "rgba(255, 255, 255, 0.04)",
  borderRadius: "10px",
  padding: "14px",
  border: "1px solid rgba(255, 255, 255, 0.06)",
  textAlign: "center",
}

const statValue: React.CSSProperties = { color: "#ffffff", fontSize: "18px", fontWeight: "700", margin: "0 0 4px" }
const statLabel: React.CSSProperties = { color: "#71717a", fontSize: "11px", margin: 0 }

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
