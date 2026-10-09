"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuthSession } from "@/components/providers/AuthSessionProvider";
import { toast } from "sonner";
import LightboxModal, { type LightboxItem } from "@/components/LightboxModal";
import QIcon from "@/components/ui/QIcon"

// ─── Types ──────────────────────────────────────────────────────────────────────

interface Generation {
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
  is_liked: boolean;
}

// ─── Tabs ───────────────────────────────────────────────────────────────────────

type TabId = "trending" | "newest" | "images" | "videos" | "characters" | "audio" | "leaderboard";

const TABS: { id: TabId; label: string }[] = [
  { id: "trending", label: "Trending" },
  { id: "newest", label: "Newest" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "characters", label: "Characters" },
  { id: "audio", label: "Audio" },
  { id: "leaderboard", label: "Leaderboard" },
];

// ─── Filter ──────────────────────────────────────────────────────────────────────

function getFilteredContent(tab: TabId, items: Generation[]): Generation[] {
  switch (tab) {
    case "trending": return [...items].sort((a, b) => (b.views + b.likes_count * 3) - (a.views + a.likes_count * 3));
    case "newest": return [...items].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    case "images": return items.filter((i) => i.type === "image" && !i.model?.toLowerCase().includes("influencer"));
    case "videos": return items.filter((i) => i.type === "video");
    case "characters": return items.filter((i) => i.model?.toLowerCase().includes("influencer") || i.model?.toLowerCase().includes("grok-2-image"));
    case "audio": return items.filter((i) => i.type === "audio");
    default: return items;
  }
}

// ─── Card ───────────────────────────────────────────────────────────────────────

function MediaCard({
  gen,
  onLike,
  onOpen,
}: {
  gen: Generation;
  onLike: (id: string) => void;
  onOpen: (gen: Generation) => void;
}) {
  const { data: session } = useAuthSession();
  const url = (() => {
    try { const p = JSON.parse(gen.output_url); return Array.isArray(p) ? p[0] : gen.output_url; }
    catch { return gen.output_url; }
  })();

  return (
    <div
      className="group relative"
      style={{ background: "#111318", border: "1px solid #2A2F3A", borderRadius: 12, overflow: "hidden", cursor: "pointer" }}
      onClick={() => onOpen(gen)}
    >
      {/* Media */}
      <div style={{ aspectRatio: "16/9", position: "relative", background: gen.type === "video" ? "#000" : "#111318" }}>
        {gen.type === "video" ? (
          <video
            data-autoplay
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            src={url}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        ) : gen.type === "audio" ? (
          <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg,#1a1228,#0d1a28)", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 32 }}>
              {[0.4, 0.7, 1, 0.6, 0.9, 0.5, 0.8].map((h, i) => (
                <div key={i} style={{ width: 4, borderRadius: 2, background: "#7B61FF", height: `${h * 100}%`, opacity: 0.7 }} />
              ))}
            </div>
            <span style={{ fontSize: 11, color: "#AAB2BF" }}>Audio</span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={gen.prompt} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} loading="lazy" />
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-end p-3 pointer-events-none">
          <p className="text-white text-xs leading-snug line-clamp-2">{gen.prompt}</p>
        </div>
      </div>

      {/* Card info */}
      <div style={{ padding: "8px 10px 10px", background: "#111318" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "#AAB2BF", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, marginRight: 8 }}>{gen.model}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#AAB2BF", fontSize: 11, display: "flex", alignItems: "center", gap: 3 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
              </svg>
              {gen.views.toLocaleString()}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!session) { toast.error("Sign in to like content"); return; }
                onLike(gen.id);
              }}
              style={{
                display: "flex", alignItems: "center", gap: 3, padding: "3px 7px",
                borderRadius: 20, fontSize: 11, cursor: "pointer",
                background: gen.is_liked ? "rgba(239,68,68,0.15)" : "transparent",
                border: `1px solid ${gen.is_liked ? "rgba(239,68,68,0.4)" : "#2A2F3A"}`,
                color: gen.is_liked ? "#f87171" : "#AAB2BF", transition: "all 0.15s",
              }}
            >
              <span>{gen.is_liked ? "♥" : "♡"}</span>
              <span>{gen.likes_count}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Leaderboard types ───────────────────────────────────────────────────────────

interface Standing {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  likes_count: number;
}

interface HallEntry {
  user_id: string;
  month: number;
  year: number;
  rank: number;
  likes_count: number;
  credits_awarded: number;
  profiles: { full_name: string | null; avatar_url: string | null } | null;
}

// ─── Countdown ───────────────────────────────────────────────────────────────────

function useCountdown() {
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  useEffect(() => {
    const calc = () => {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
      const diff = end.getTime() - now.getTime();
      if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
      return {
        days: Math.floor(diff / 86400000),
        hours: Math.floor((diff % 86400000) / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
      };
    };
    setTimeLeft(calc());
    const id = setInterval(() => setTimeLeft(calc()), 1000);
    return () => clearInterval(id);
  }, []);
  return timeLeft;
}

// ─── Leaderboard section ─────────────────────────────────────────────────────────

function LeaderboardSection() {
  const [standings, setStandings] = useState<Standing[]>([]);
  const [hallOfFame, setHallOfFame] = useState<HallEntry[]>([]);
  const [hofOpen, setHofOpen] = useState(false);
  const [loadingLB, setLoadingLB] = useState(true);
  const countdown = useCountdown();

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => { setStandings(d.standings ?? []); setHallOfFame(d.hallOfFame ?? []); })
      .catch(() => {})
      .finally(() => setLoadingLB(false));
  }, []);

  const PRIZE_COLORS = ["#F59E0B", "#9CA3AF", "#CD7C2F"];
  const PRIZE_BG = ["rgba(245,158,11,0.12)", "rgba(156,163,175,0.1)", "rgba(205,124,47,0.12)"];
  const REWARDS = [500, 300, 100];

  const hofByPeriod = hallOfFame.reduce<Record<string, HallEntry[]>>((acc, e) => {
    const key = `${e.year}-${String(e.month).padStart(2, "0")}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(e);
    return acc;
  }, {});

  const monthName = (m: number, y: number) =>
    new Date(y, m - 1, 1).toLocaleString("en", { month: "long", year: "numeric" });
  const pad = (n: number) => String(n).padStart(2, "0");
  const currentMonthLabel = new Date().toLocaleString("en", { month: "long", year: "numeric" });

  return (
    <div style={{ padding: "0 32px", display: "flex", flexDirection: "column", alignItems: "center" }}>

      {/* Centered header + prizes + countdown */}
      <div style={{ width: "100%", maxWidth: 700, textAlign: "center", marginBottom: 40 }}>
        <h2 style={{ color: "white", fontSize: 22, fontWeight: 800, marginBottom: 28 }}>
          This Month — {currentMonthLabel}
        </h2>

        {/* Prize banner — centered cards */}
        <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 28 }}>
          {[{ label: "#1 1st Place", color: PRIZE_COLORS[0], bg: PRIZE_BG[0], cr: REWARDS[0] },
            { label: "#2 2nd Place", color: PRIZE_COLORS[1], bg: PRIZE_BG[1], cr: REWARDS[1] },
            { label: "#3 3rd Place", color: PRIZE_COLORS[2], bg: PRIZE_BG[2], cr: REWARDS[2] }]
            .map((p) => (
              <div key={p.label} style={{ background: p.bg, border: `1px solid ${p.color}44`, borderRadius: 16, padding: "20px 0", width: 200, textAlign: "center" }}>
                <p style={{ margin: "0 0 4px", fontSize: 26, fontWeight: 800, color: p.color }}>{p.label.split(" ")[0]}</p>
                <p style={{ margin: "0 0 8px", color: p.color, fontSize: 13, fontWeight: 700 }}>{p.label.split(" ").slice(1).join(" ")}</p>
                <p style={{ margin: 0, color: "white", fontSize: 28, fontWeight: 900 }}>{p.cr}</p>
                <p style={{ margin: 0, color: "#AAB2BF", fontSize: 12 }}>QLC</p>
              </div>
            ))}
        </div>

        {/* Countdown — centered */}
        <div style={{ background: "#111318", border: "1px solid #2A2F3A", borderRadius: 16, padding: "20px 24px" }}>
          <p style={{ color: "#AAB2BF", fontSize: 12, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Time remaining
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[{ val: countdown.days, label: "Days" }, { val: countdown.hours, label: "Hours" }, { val: countdown.minutes, label: "Min" }, { val: countdown.seconds, label: "Sec" }].map(({ val, label }) => (
              <div key={label} style={{ textAlign: "center" }}>
                <p style={{ margin: 0, color: "#7B61FF", fontSize: 32, fontWeight: 900, fontVariantNumeric: "tabular-nums", minWidth: 52 }}>{pad(val)}</p>
                <p style={{ margin: 0, color: "#AAB2BF", fontSize: 11 }}>{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* This Month's Top Content */}
      <div style={{ width: "100%" }}>
        {/* Current standings */}
        <div style={{ background: "#111318", border: "1px solid #2A2F3A", borderRadius: 16, overflow: "hidden", marginBottom: 24, maxWidth: 800 }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #2A2F3A" }}>
            <h3 style={{ margin: 0, color: "white", fontSize: 14, fontWeight: 700 }}>Current Standings — {currentMonthLabel}</h3>
          </div>
          {loadingLB ? (
            <div style={{ padding: 24, textAlign: "center", color: "#AAB2BF", fontSize: 13 }}>Loading…</div>
          ) : standings.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center" }}>
              <p style={{ color: "#AAB2BF", fontSize: 14 }}>No submissions yet this month.</p>
              <p style={{ color: "#4A5568", fontSize: 12, marginTop: 4 }}>Generate content and publish it to compete!</p>
            </div>
          ) : (
            standings.map((s, i) => (
              <div key={s.user_id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 20px", borderBottom: i < standings.length - 1 ? "1px solid #2A2F3A" : "none", background: i < 3 ? PRIZE_BG[i] : "transparent" }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: i < 3 ? PRIZE_COLORS[i] + "22" : "#2A2F3A", border: `1px solid ${i < 3 ? PRIZE_COLORS[i] + "66" : "#3A3F4A"}`, color: i < 3 ? PRIZE_COLORS[i] : "#AAB2BF", fontSize: 13, fontWeight: 700 }}>
                  {`${i + 1}`}
                </div>
                {s.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.avatar_url} alt="" style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#2A2F3A", display: "flex", alignItems: "center", justifyContent: "center", color: "#AAB2BF", fontSize: 14, flexShrink: 0 }}>
                    {(s.full_name ?? "?")[0].toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, color: "white", fontSize: 13, fontWeight: 600 }}>{s.full_name ?? "Anonymous"}</p>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <p style={{ margin: 0, color: i < 3 ? PRIZE_COLORS[i] : "white", fontSize: 15, fontWeight: 700 }}>♥ {s.likes_count}</p>
                  {i < 3 && <p style={{ margin: 0, color: "#4A5568", fontSize: 11 }}>{REWARDS[i]} QLC prize</p>}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Hall of Fame */}
        {Object.keys(hofByPeriod).length > 0 && (
          <div style={{ background: "#111318", border: "1px solid #2A2F3A", borderRadius: 16, overflow: "hidden", maxWidth: 800 }}>
            <button onClick={() => setHofOpen((v) => !v)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", background: "transparent", border: "none", cursor: "pointer" }}>
              <span style={{ color: "white", fontSize: 14, fontWeight: 700 }}>Hall of Fame</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#AAB2BF" strokeWidth={2} style={{ transform: hofOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {hofOpen && (
              <div style={{ borderTop: "1px solid #2A2F3A" }}>
                {Object.entries(hofByPeriod).map(([key, entries]) => {
                  const [y, m] = key.split("-");
                  return (
                    <div key={key} style={{ padding: "16px 20px", borderBottom: "1px solid #1a1f28" }}>
                      <p style={{ margin: "0 0 12px", color: "#AAB2BF", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{monthName(Number(m), Number(y))}</p>
                      {entries.map((e) => (
                        <div key={`${e.user_id}-${e.rank}`} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                          <span style={{ fontSize: 16, minWidth: 22 }}>{`#${e.rank}`}</span>
                          <div style={{ flex: 1 }}>
                            <p style={{ margin: 0, color: "white", fontSize: 13 }}>{e.profiles?.full_name ?? "Anonymous"}</p>
                            <p style={{ margin: 0, color: "#4A5568", fontSize: 11 }}>♥ {e.likes_count} likes</p>
                          </div>
                          <span style={{ color: PRIZE_COLORS[e.rank - 1] ?? "#AAB2BF", fontSize: 13, fontWeight: 700 }}>+{e.credits_awarded} QLC</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "96px 32px", textAlign: "center" }}>
      <QIcon name="image" size={40} strokeWidth={1.3} style={{ opacity: 0.5, marginBottom: 16 }} />
      <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>No content yet. Be the first to publish!</p>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────────

export default function ExplorePage() {
  const [tab, setTab] = useState<TabId>("trending");
  const [realData, setRealData] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);
  const [localLikes, setLocalLikes] = useState<Record<string, { count: number; liked: boolean }>>({});
  const [lightboxItem, setLightboxItem] = useState<LightboxItem | null>(null);

  // Scroll position restore
  useEffect(() => {
    const saved = sessionStorage.getItem("explore-scroll");
    if (saved) window.scrollTo(0, parseInt(saved));
    return () => {
      sessionStorage.setItem("explore-scroll", window.scrollY.toString());
    };
  }, []);

  // IntersectionObserver autoplay for all data-autoplay videos
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const video = entry.target as HTMLVideoElement;
          if (entry.isIntersecting) {
            video.play().catch(() => {});
          } else {
            video.pause();
          }
        });
      },
      { threshold: 0.3 }
    );
    const timer = setTimeout(() => {
      document.querySelectorAll("video[data-autoplay]").forEach((v) => observer.observe(v));
    }, 100);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [tab, realData, loading]);

  const fetchData = useCallback(async (currentTab: TabId) => {
    if (currentTab === "leaderboard") { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/explore?tab=${currentTab}&page=0`);
      if (res.ok) {
        const data = await res.json() as { generations?: Generation[] };
        setRealData(data.generations ?? []);
      } else {
        setRealData([]);
      }
    } catch {
      setRealData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(tab); }, [tab, fetchData]);

  const handleLike = async (id: string) => {
    setLocalLikes((prev) => {
      const current = prev[id] ?? {
        count: realData.find((g) => g.id === id)?.likes_count ?? 0,
        liked: realData.find((g) => g.id === id)?.is_liked ?? false,
      };
      return { ...prev, [id]: { count: current.count + (current.liked ? -1 : 1), liked: !current.liked } };
    });
    await fetch("/api/like", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generationId: id }) }).catch(() => {});
  };

  const handleOpen = (gen: Generation) => {
    setLightboxItem(gen as LightboxItem);
    fetch("/api/view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generationId: gen.id }) }).catch(() => {});
  };

  const displayItems = getFilteredContent(tab, realData).map((g) => ({
    ...g,
    likes_count: localLikes[g.id]?.count ?? g.likes_count,
    is_liked: localLikes[g.id]?.liked ?? g.is_liked,
  }));

  const showLeaderboard = tab === "leaderboard";

  return (
    <main className="min-h-screen" style={{ background: "#050505" }}>
      <div className="max-w-[1400px] mx-auto pb-16">

        {/* Header */}
        <div style={{ padding: "32px 32px 8px" }}>
          <h1 style={{ color: "white", fontSize: 32, fontWeight: 700, marginBottom: 6 }}>Explore</h1>
          <p style={{ color: "#AAB2BF", fontSize: 14 }}>AI-generated content from the community</p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, padding: "0 32px", marginBottom: 24, overflowX: "auto" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flexShrink: 0, padding: "6px 16px", borderRadius: 999,
                fontSize: 13, fontWeight: 500, cursor: "pointer", transition: "all 0.15s",
                background: tab === t.id ? "#7B61FF" : "#111318",
                color: tab === t.id ? "white" : "#AAB2BF",
                border: `1px solid ${tab === t.id ? "#7B61FF" : "#2A2F3A"}`,
              }}
              onMouseEnter={(e) => { if (tab !== t.id) (e.currentTarget as HTMLButtonElement).style.borderColor = "#7B61FF"; }}
              onMouseLeave={(e) => { if (tab !== t.id) (e.currentTarget as HTMLButtonElement).style.borderColor = "#2A2F3A"; }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Community label */}
        {!showLeaderboard && (
          <div style={{ padding: "0 32px", marginBottom: 16 }}>
            <span style={{ color: "#AAB2BF", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>COMMUNITY</span>
          </div>
        )}

        {/* Content */}
        {showLeaderboard ? (
          <LeaderboardSection />
        ) : loading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, padding: "0 32px" }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton rounded-xl" style={{ aspectRatio: "16/9" }} />
            ))}
          </div>
        ) : displayItems.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, padding: "0 32px" }}>
            {displayItems.map((gen) => (
              <MediaCard key={gen.id} gen={gen} onLike={handleLike} onOpen={handleOpen} />
            ))}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxItem && (
        <LightboxModal item={lightboxItem} onClose={() => setLightboxItem(null)} />
      )}
    </main>
  );
}
