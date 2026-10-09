import { Metadata } from "next"
import ComingSoonFeature from "@/components/ui/ComingSoonFeature"

export const metadata: Metadata = {
  title: "Storyboard — Qelarix",
  description: "Turn a script into a shot-by-shot storyboard. Coming soon.",
}

export default function StoryboardPage() {
  return (
    <ComingSoonFeature
      tone="teal"
      accent="#22D3EE"
      accentText="#03181D"
      eyebrow="Coming soon"
      title="Qelarix"
      highlight="Storyboard"
      body="Turn a script or an idea into a shot-by-shot storyboard: scenes, camera angles and a frame for every shot, ready to bring to life."
      points={[
        { title: "Script to scenes", text: "Paste a script or describe a story and get it split into clear scenes and shots." },
        { title: "A frame for every shot", text: "Each shot gets a generated frame with camera angle and mood, so you see the film before you make it." },
        { title: "Straight into Cinema Studio", text: "Send the whole storyboard to Cinema Studio and turn the frames into video." },
      ]}
    />
  )
}
