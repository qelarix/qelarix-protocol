import styles from "./qelarix-grid-backdrop.module.css"

// Full-screen live perspective-line background. Place it as the first child of a positioned page
// wrapper and give the content `position: relative` with a higher z-index.
// Tones: yellow (Shorts Generator), green (Create Image).
export default function QelarixGridBackdrop({ tone = "yellow" }: { tone?: "yellow" | "green" }) {
  return (
    <div className={`${styles.grid} ${styles[tone]}`} aria-hidden="true">
      <span className={`${styles.plane} ${styles.top}`} />
      <span className={`${styles.plane} ${styles.bottom}`} />
      <span className={styles.horizon} />
      <span className={styles.stars} />
    </div>
  )
}
