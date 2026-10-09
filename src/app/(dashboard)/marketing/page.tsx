import { Metadata } from "next"
import ComingSoonFeature from "@/components/ui/ComingSoonFeature"

export const metadata: Metadata = {
  title: "Viral Mode — Qelarix",
  description: "Turn a product link or an idea into short ads and social clips. Coming soon.",
}

export default function ViralModePage() {
  return (
    <ComingSoonFeature
      tone="orange"
      accent="#FB923C"
      accentText="#1F0C02"
      eyebrow="Coming soon"
      title="Qelarix"
      highlight="Viral Mode"
      body="Turn a product link or an idea into short ads and social clips built to stop the scroll, in every format you need."
      points={[
        { title: "From link to ad", text: "Paste a product URL and get ad concepts, visuals and video built around it." },
        { title: "Hooks and captions", text: "Attention-grabbing openings, captions and calls to action written for each platform." },
        { title: "Every format", text: "Vertical, square and wide versions for TikTok, Reels, Shorts and feeds." },
      ]}
    />
  )
}
