import type { CSSProperties } from "react"

// Shared look for every QLC surface (Pricing page, Buy QLC modal, QLC spending): one solid accent,
// no gradients, quiet surfaces. Keep QLC windows visually identical by importing from here.
export const QLC_COLORS = {
  text: "#F4F7FB",
  muted: "#9AA3B2",
  faint: "#5E6675",
  accent: "#6D5EF6",
  active: "#9C92FF",
  error: "#F2A3A3",
  success: "#7FD8A4",
  danger: "#E8A0A0",
  // Homepage "liquid glass" surfaces (qelarix-home.css --surface / --line), slightly lifted.
  surface: "rgba(24, 19, 40, 0.58)",
  surfaceRaised: "rgba(32, 26, 54, 0.66)",
  line: "rgba(171, 143, 255, 0.16)",
  lineAccent: "rgba(140, 124, 255, 0.6)",
} as const

export const qlcPrimaryButton: CSSProperties = {
  width: "100%",
  padding: "11px 18px",
  borderRadius: 10,
  border: "none",
  cursor: "pointer",
  color: "#FFFFFF",
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: "0.01em",
  background: QLC_COLORS.accent,
}

// Pair with qlcPrimaryButton for a subtle hover without changing the colour family.
export const qlcPrimaryButtonClass = "transition-[filter,opacity] hover:brightness-110 active:brightness-95 disabled:opacity-60"

export const qlcTextButton: CSSProperties = {
  background: "transparent",
  border: "none",
  color: QLC_COLORS.muted,
  fontSize: 13,
  cursor: "pointer",
  padding: "6px 0",
}

const glass: CSSProperties = {
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 18px 48px rgba(0,0,0,0.35)",
}

export const qlcPanel: CSSProperties = {
  ...glass,
  borderRadius: 14,
  background: QLC_COLORS.surface,
  border: `1px solid ${QLC_COLORS.line}`,
}

export function qlcPackCard(highlighted: boolean): CSSProperties {
  return {
    borderRadius: 12,
    padding: "18px 16px",
    textAlign: "left",
    ...glass,
    background: highlighted ? "rgba(52, 40, 102, 0.62)" : QLC_COLORS.surface,
    border: `1px solid ${highlighted ? QLC_COLORS.lineAccent : QLC_COLORS.line}`,
    color: QLC_COLORS.text,
  }
}
