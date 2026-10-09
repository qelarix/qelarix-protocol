import styles from "./qelarix-backdrop.module.css"

// Full-screen live Qelarix background (homepage colours, light threads). Place it as the first
// child of a page wrapper and give the content `position: relative` so it renders above it.
// Tones: violet (Pricing), copper (Settings), steel (Profile), emerald (Community), gold (API), crimson (MCP), teal (Storyboard), magenta (Influencer), orange (Viral Mode), sunset (Relight), mint (Video Upscale), citrus (Video Extend).
// layer="behind" places it under ordinary page content (z-index -1), for simple text pages that do
// not wrap their content in a positioned container. The page itself must not paint a background.
export default function QelarixBackdrop({ tone = "violet", layer = "base" }: { tone?: "violet" | "copper" | "steel" | "emerald" | "gold" | "crimson" | "teal" | "magenta" | "orange" | "sunset" | "mint" | "citrus"; layer?: "base" | "behind" }) {
  return (
    <div style={layer === "behind" ? { zIndex: -1 } : undefined} className={`${styles.backdrop} ${tone === "copper" ? styles.copper : tone === "steel" ? styles.steel : tone === "emerald" ? styles.emerald : tone === "gold" ? styles.gold : tone === "crimson" ? styles.crimson : tone === "teal" ? styles.teal : tone === "magenta" ? styles.magenta : tone === "orange" ? styles.orange : tone === "sunset" ? styles.sunset : tone === "mint" ? styles.mint : tone === "citrus" ? styles.citrus : ""}`} aria-hidden="true">
      <span className={`${styles.wash} ${styles.washA}`} />
      <span className={`${styles.wash} ${styles.washB}`} />
      <span className={`${styles.thread} ${styles.threadA}`}><span className={styles.spark} /></span>
      <span className={`${styles.thread} ${styles.threadB}`}><span className={styles.spark} /></span>
      <span className={`${styles.thread} ${styles.threadC}`}><span className={styles.spark} /></span>
      <span className={`${styles.thread} ${styles.threadD}`} />
    </div>
  )
}
