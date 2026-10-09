import { Metadata } from "next"
import ComingSoonFeature from "@/components/ui/ComingSoonFeature"

export const metadata: Metadata = {
  title: "AI Influencer — Qelarix",
  description: "Create a consistent AI influencer with endless content. Coming soon.",
}

export default function AiInfluencerPage() {
  return (
    <ComingSoonFeature
      tone="magenta"
      accent="#F472B6"
      accentText="#1F0614"
      eyebrow="Coming soon"
      title="Qelarix"
      highlight="Influencer"
      body="Create your own AI influencer: one consistent face and style, with photos, videos and captions for every platform."
      points={[
        { title: "One consistent character", text: "Design a face, look and personality once, and keep it identical in every image and video." },
        { title: "Content on demand", text: "Posts, stories and captions in your influencer's voice, generated whenever you need them." },
        { title: "Video and voice", text: "Bring the character to life with talking videos and a voice of its own." },
      ]}
    />
  )
}
