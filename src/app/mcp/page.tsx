import { Metadata } from "next"
import ComingSoonFeature from "@/components/ui/ComingSoonFeature"

export const metadata: Metadata = {
  title: "MCP — Qelarix",
  description: "The Qelarix MCP server for AI agents is coming soon.",
}

export default function McpPage() {
  return (
    <ComingSoonFeature
      tone="crimson"
      accent="#F87171"
      accentText="#1F0507"
      eyebrow="Coming soon"
      title="Qelarix"
      highlight="MCP"
      body="Connect AI agents to Qelarix through the Model Context Protocol and let them create images, video and audio for you."
      points={[
        { title: "Works with MCP clients", text: "Any MCP-compatible agent or assistant can use Qelarix generation tools." },
        { title: "Your wallet, your limit", text: "Agents spend only within the QLC spending limit you approved, and you can revoke it at any time." },
        { title: "Every result in your library", text: "Agent creations land in your Qelarix history, like anything you make in the studio." },
      ]}
    />
  )
}
