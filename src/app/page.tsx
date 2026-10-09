// Root route (/) — Qelarix landing page.
// Thin wrapper: loads the scoped homepage stylesheet and renders the ported Home Page component.
// The global <Header/> (layout.tsx) provides the nav; this page only renders the landing content + its own footer.
import "./qelarix-home.css";
import QelarixHomePage from "@/components/home/QelarixHomePage";

export default function HomePage() {
  return <QelarixHomePage />;
}
