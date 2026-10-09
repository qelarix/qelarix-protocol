import { Metadata } from "next"
import ComingSoonFeature from "@/components/ui/ComingSoonFeature"

export const metadata: Metadata = {
  title: "Shorts Generator — Qelarix",
  description: "Script, voiceover and video for TikTok, Reels and YouTube Shorts. Coming soon.",
}

export default function ShortsGeneratorPage() {
  return (
    <ComingSoonFeature
      tone="yellow"
      accent="#FACC15"
      accentText="#1A1203"
      eyebrow="Coming soon"
      title="Shorts"
      highlight="Generator"
      body="Turn one idea into a finished vertical video for TikTok, Reels and YouTube Shorts: script, voiceover and scenes in a single flow, paid in QLC on Solana."
      points={[
        { title: "Script in seconds", text: "Describe a topic, choose a style and length, and get a scene-by-scene script you can edit." },
        { title: "Voiceover in your language", text: "Natural voices in multiple languages and tones, matched to every scene." },
        { title: "Ready-to-post video", text: "Scenes generated in 9:16 and assembled into one short, sized for each platform." },
      ]}
    />
  )
}
