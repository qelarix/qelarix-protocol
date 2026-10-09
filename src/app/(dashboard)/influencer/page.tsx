import { Metadata } from "next"
import AiInfluencerPage from "@/app/ai-influencer/page"

export const metadata: Metadata = {
  title: "AI Influencer — Qelarix",
  description: "Create a consistent AI influencer with endless content. Coming soon.",
}

// The Influencer studio is announced on /ai-influencer (coming soon); this route shows the same page.
export default function InfluencerPage() {
  return <AiInfluencerPage />
}
