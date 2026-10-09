import { Metadata } from "next"
import ComingSoonFeature from "@/components/ui/ComingSoonFeature"

export const metadata: Metadata = {
  title: "API — Qelarix",
  description: "The Qelarix API for developers and agents is coming soon.",
}

export default function DevelopersPage() {
  return (
    <ComingSoonFeature
      tone="gold"
      accent="#FACC15"
      accentText="#1A1203"
      eyebrow="Coming soon"
      title="Qelarix"
      highlight="API"
      body="Generate images, video and audio from your own apps and AI agents, paid per call in QLC and settled on Solana."
      points={[
        { title: "One API for every model", text: "Image, video and audio generation through a single, consistent interface." },
        { title: "Pay per call in QLC", text: "No subscription. Every call is charged in QLC and settled on Solana." },
        { title: "Keys and webhooks", text: "API keys and webhooks for finished generations will appear here at launch." },
      ]}
    />
  )
}
