"use client";

import { useEffect, useState } from "react";
import QIcon from "@/components/ui/QIcon"

export interface LightboxItem {
  id: string;
  type: "image" | "video" | "audio";
  output_url: string;
  model: string;
  prompt: string;
  title: string | null;
  created_at: string;
  views: number;
  user_name: string;
  likes_count: number;
}

interface Props {
  item: LightboxItem;
  onClose: () => void;
}

export default function LightboxModal({ item, onClose }: Props) {
  const [muted, setMuted] = useState(false);

  const url = (() => {
    try { const p = JSON.parse(item.output_url); return Array.isArray(p) ? p[0] : item.output_url; }
    catch { return item.output_url; }
  })();

  // ESC key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Browser back button closes modal
  useEffect(() => {
    window.history.pushState({ lightbox: true }, "");
    const handlePop = () => onClose();
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [onClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const formattedDate = new Date(item.created_at).toLocaleDateString("en", {
    month: "long", day: "numeric", year: "numeric",
  });

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)",
        backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
        zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, animation: "fadeIn 0.2s ease",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          position: "relative", maxWidth: "90vw", width: "100%",
          maxHeight: "90vh", display: "flex", flexDirection: "column",
          background: "#111318", borderRadius: 16, border: "1px solid #2A2F3A",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute", top: 12, right: 12, zIndex: 10000,
            width: 36, height: 36, borderRadius: "50%",
            background: "rgba(17,19,24,0.9)", border: "1px solid #2A2F3A",
            color: "white", fontSize: 18, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.background = "#2A2F3A"}
          onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.background = "rgba(17,19,24,0.9)"}
        >
          ✕
        </button>

        {/* Media */}
        <div style={{ background: "#000", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200 }}>
          {item.type === "video" ? (
            <video
              autoPlay
              loop
              playsInline
              controls
              muted={muted}
              src={url}
              style={{ maxWidth: "90vw", maxHeight: "65vh", objectFit: "contain", display: "block" }}
            />
          ) : item.type === "audio" ? (
            <div style={{ padding: "32px 24px", textAlign: "center", width: "100%" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 4, height: 48, marginBottom: 20 }}>
                {[0.4, 0.65, 1, 0.8, 0.5, 0.9, 0.7, 0.45, 0.6, 1, 0.75, 0.5].map((h, i) => (
                  <div key={i} style={{ width: 6, borderRadius: 3, background: "#7B61FF", height: `${h * 100}%`, opacity: 0.8 }} />
                ))}
              </div>
              <audio autoPlay controls src={url} style={{ width: "100%", maxWidth: 480 }} />
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={item.prompt}
              style={{ maxWidth: "90vw", maxHeight: "75vh", objectFit: "contain", display: "block" }}
            />
          )}
        </div>

        {/* Mute toggle for video */}
        {item.type === "video" && (
          <div style={{ padding: "8px 16px", background: "#0A0A0F", borderTop: "1px solid #2A2F3A" }}>
            <button
              onClick={() => setMuted((v) => !v)}
              style={{
                background: "#111318", border: "1px solid #2A2F3A", color: "white",
                padding: "6px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              <QIcon name={muted ? "mute" : "volume"} size={15} />
              <span>{muted ? "Unmute" : "Mute"}</span>
            </button>
          </div>
        )}

        {/* Info */}
        <div style={{ padding: "16px 20px", overflowY: "auto", flexShrink: 0 }}>
          <p style={{ margin: "0 0 4px", color: "#AAB2BF", fontSize: 12 }}>{item.model}</p>
          <p style={{ margin: "0 0 12px", color: "white", fontSize: 14, lineHeight: 1.5 }}>{item.prompt}</p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: "#AAB2BF", fontSize: 12 }}>
                by <strong style={{ color: "white" }}>{item.user_name}</strong>
              </span>
              <span style={{ color: "#4A5568", fontSize: 11 }}>{formattedDate}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: "#AAB2BF", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                </svg>
                {item.views.toLocaleString()}
              </span>
              <span style={{ color: "#f87171", fontSize: 12 }}>♥ {item.likes_count}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
