"use client"

import { Suspense, useState, useRef } from "react"
import Link from "next/link"
import Image from "next/image"
import WalletSignIn from "@/components/auth/WalletSignIn"

const VIDEOS = ["/media/auth/background-1.mp4", "/media/auth/background-2.mp4"]

const MODEL_STRIP = [
  { name: "Nano Banana Pro", badge: "Image" },
  { name: "Kling 3.0", badge: "Video" },
  { name: "Seedance 2.0", badge: "Video" },
  { name: "Veo 4", badge: "Ultra" },
  { name: "Grok Imagine", badge: "Pro" },
  { name: "GPT Image 2", badge: "Pro" },
]

const BADGE_COLORS: Record<string, string> = {
  Image: "#3B82F6",
  Video: "#7B61FF",
  Audio: "#22C55E",
  Ultra: "#3BE7FF",
  Pro: "#F59E0B",
}

export default function LoginPage() {
  const [videoIdx, setVideoIdx] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)

  const handleVideoEnd = () => setVideoIdx((i) => (i + 1) % VIDEOS.length)


  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#050505" }}>

      {/* LEFT — Video panel (lg+) */}
      <div className="hidden lg:block" style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <video
          ref={videoRef}
          key={VIDEOS[videoIdx]}
          autoPlay
          muted
          playsInline
          onEnded={handleVideoEnd}
          style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }}
        >
          <source src={VIDEOS[videoIdx]} type="video/mp4" />
        </video>
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)" }} />
        {/* Model strip */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
          padding: "48px 28px 28px",
        }}>
          <p style={{ color: "#AAB2BF", fontSize: 11, marginBottom: 12, letterSpacing: 2, textTransform: "uppercase" }}>
            Powered by
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {MODEL_STRIP.map((m) => (
              <div key={m.name} style={{
                background: "rgba(255,255,255,0.08)", backdropFilter: "blur(8px)",
                borderRadius: 8, padding: "6px 12px", display: "flex", alignItems: "center", gap: 8,
                border: "1px solid rgba(255,255,255,0.1)",
              }}>
                <span style={{
                  background: BADGE_COLORS[m.badge] ?? "#7B61FF", color: "white",
                  fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                }}>
                  {m.badge}
                </span>
                <span style={{ color: "white", fontSize: 12, fontWeight: 500 }}>{m.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT — Auth form */}
      <div style={{
        width: "100%", maxWidth: 480, display: "flex", alignItems: "center",
        justifyContent: "center", padding: 40, margin: "0 auto",
      }}>
        <div style={{ width: "100%" }}>

          {/* Logo + heading */}
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <Image src="/qelarix_logo.png" alt="Qelarix" width={100} height={32}
              style={{ objectFit: "contain", marginBottom: 20 }} priority />
            <h1 style={{ color: "#F4F7FB", fontSize: 28, fontWeight: 800, margin: "0 0 8px" }}>
              Welcome back
            </h1>
            <p style={{ color: "#AAB2BF", fontSize: 14, margin: 0 }}>
              Sign in with your Solana wallet
            </p>
          </div>

          <Suspense fallback={null}>
            <WalletSignIn />
          </Suspense>

          <p style={{ textAlign: "center", color: "#2A2F3A", fontSize: 11, marginTop: 24 }}>
            By continuing you agree to our{" "}
            <Link href="/terms" style={{ color: "#4A5568" }}>Terms</Link> and{" "}
            <Link href="/privacy" style={{ color: "#4A5568" }}>Privacy Policy</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
