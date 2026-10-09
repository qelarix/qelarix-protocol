"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import QelarixBackdrop from "@/components/ui/QelarixBackdrop"
import { QLC_COLORS, qlcPrimaryButtonClass } from "@/components/payments/qlcUi"

// ─── Look ────────────────────────────────────────────────────────────────────
// Emerald palette for Community. Primary actions keep the single brand accent.
const G = {
  text: "#ECFDF5",
  muted: "#9CC7B5",
  faint: "#5E8A78",
  mint: "#6EE7B7",
  mintStrong: "#34D399",
  surface: "rgba(8, 32, 24, 0.58)",
  surfaceSoft: "rgba(110, 231, 183, 0.05)",
  line: "rgba(110, 231, 183, 0.16)",
  lineStrong: "rgba(110, 231, 183, 0.38)",
}

const glass: CSSProperties = {
  background: G.surface,
  border: `1px solid ${G.line}`,
  borderRadius: 18,
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 24px 60px rgba(0,0,0,0.35)",
}

const REWARDS = [500, 300, 100]
const PLACE = ["1st", "2nd", "3rd"]

// ─── Types ───────────────────────────────────────────────────────────────────

type TypeTab = "creators" | "leaderboard"

interface Standing {
  user_id: string
  username?: string | null
  full_name: string | null
  avatar_url: string | null
  likes_count: number
}

interface HallEntry {
  user_id: string
  month: number
  year: number
  rank: number
  likes_count: number
  credits_awarded: number
  profiles: { username?: string | null; full_name: string | null; avatar_url: string | null } | null
}

// ─── Small parts ─────────────────────────────────────────────────────────────

function Avatar({ url, name, size, ring }: { url?: string | null; name?: string | null; size: number; ring?: boolean }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", padding: ring ? 2 : 0, flexShrink: 0,
      background: ring ? `conic-gradient(from 200deg, ${G.mintStrong}, #A7F3D0, #10B981, ${G.mintStrong})` : "transparent",
    }}>
      <div style={{
        width: "100%", height: "100%", borderRadius: "50%", overflow: "hidden",
        background: "#0B1F18", border: ring ? "none" : `1px solid ${G.line}`, color: G.muted,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.round(size * 0.38), fontWeight: 600,
      }}>
        {url
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : (name?.trim()?.charAt(0) || "?").toUpperCase()}
      </div>
    </div>
  )
}

function RankTag({ rank }: { rank: number }) {
  const top = rank <= 3
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", fontVariantNumeric: "tabular-nums",
      padding: "3px 9px", borderRadius: 999,
      color: top ? "#04110C" : G.muted,
      background: top ? G.mint : "rgba(110,231,183,0.08)",
      border: top ? "none" : `1px solid ${G.line}`,
    }}>
      #{rank}
    </span>
  )
}

function useCountdown() {
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 })
  useEffect(() => {
    const calc = () => {
      const now = new Date()
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)
      const diff = end.getTime() - now.getTime()
      if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 }
      return {
        days: Math.floor(diff / 86400000),
        hours: Math.floor((diff % 86400000) / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
      }
    }
    setTimeLeft(calc())
    const id = setInterval(() => setTimeLeft(calc()), 1000)
    return () => clearInterval(id)
  }, [])
  return timeLeft
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

function LeaderboardSection() {
  const [standings, setStandings] = useState<Standing[]>([])
  const [hallOfFame, setHallOfFame] = useState<HallEntry[]>([])
  const [hofOpen, setHofOpen] = useState(false)
  const [loadingLB, setLoadingLB] = useState(true)
  const countdown = useCountdown()

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => { setStandings(d.standings ?? []); setHallOfFame(d.hallOfFame ?? []) })
      .catch(() => {})
      .finally(() => setLoadingLB(false))
  }, [])

  const hofByPeriod = hallOfFame.reduce<Record<string, HallEntry[]>>((acc, e) => {
    const key = `${e.year}-${String(e.month).padStart(2, "0")}`
    if (!acc[key]) acc[key] = []
    acc[key].push(e)
    return acc
  }, {})

  const monthName = (m: number, y: number) =>
    new Date(y, m - 1, 1).toLocaleString("en", { month: "long", year: "numeric" })
  const pad = (n: number) => String(n).padStart(2, "0")
  const currentMonthLabel = new Date().toLocaleString("en", { month: "long", year: "numeric" })

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ textAlign: "center", marginBottom: 4 }}>
        <p style={{ margin: 0, color: G.mint, fontSize: 12, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase" }}>Monthly competition</p>
        <h2 style={{ margin: "8px 0 0", color: G.text, fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em" }}>{currentMonthLabel}</h2>
        <p style={{ margin: "8px auto 0", color: G.muted, fontSize: 14, maxWidth: 520, lineHeight: 1.55 }}>
          Put your creations live from your profile. The community votes with likes, and the three most-liked creators of the month win QLC.
        </p>
      </div>

      {/* Rewards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        {REWARDS.map((amount, i) => (
          <div key={amount} style={{
            ...glass, padding: "22px 16px", textAlign: "center",
            borderColor: i === 0 ? G.lineStrong : G.line,
            background: i === 0 ? "rgba(16, 64, 46, 0.62)" : G.surface,
          }}>
            <p style={{ margin: 0, color: i === 0 ? G.mint : G.muted, fontSize: 12, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase" }}>{PLACE[i]} place</p>
            <p style={{ margin: "10px 0 0", color: G.text, fontSize: 34, fontWeight: 700, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{amount}</p>
            <p style={{ margin: "2px 0 0", color: G.muted, fontSize: 12, letterSpacing: "0.12em" }}>QLC</p>
          </div>
        ))}
      </div>
      <p style={{ margin: "-6px 0 0", textAlign: "center", color: G.faint, fontSize: 12 }}>
        Devnet beta: rewards are sent by the Qelarix team after the month closes.
      </p>

      {/* Countdown */}
      <div style={{ ...glass, padding: "20px 24px", textAlign: "center" }}>
        <p style={{ margin: 0, color: G.muted, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase" }}>Time remaining</p>
        <div style={{ display: "flex", justifyContent: "center", gap: 28, marginTop: 12, flexWrap: "wrap" }}>
          {[{ val: countdown.days, label: "Days" }, { val: countdown.hours, label: "Hours" }, { val: countdown.minutes, label: "Min" }, { val: countdown.seconds, label: "Sec" }].map(({ val, label }) => (
            <div key={label} style={{ minWidth: 56 }}>
              <p style={{ margin: 0, color: G.mint, fontSize: 34, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{pad(val)}</p>
              <p style={{ margin: 0, color: G.muted, fontSize: 11, letterSpacing: "0.08em" }}>{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Standings */}
      <div style={{ ...glass, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${G.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, color: G.text, fontSize: 15, fontWeight: 600 }}>Current standings</h3>
          <span style={{ color: G.faint, fontSize: 12 }}>{currentMonthLabel}</span>
        </div>
        {loadingLB ? (
          <div style={{ padding: 28, textAlign: "center", color: G.muted, fontSize: 13 }}>Loading…</div>
        ) : standings.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <p style={{ margin: 0, color: G.text, fontSize: 15, fontWeight: 600 }}>No entries yet this month</p>
            <p style={{ margin: "6px 0 0", color: G.muted, fontSize: 13 }}>Be the first: create something and put it live from your profile.</p>
            <a
              href="/profile"
              className={qlcPrimaryButtonClass}
              style={{ display: "inline-block", marginTop: 16, padding: "10px 20px", borderRadius: 10, background: QLC_COLORS.accent, color: "#FFFFFF", fontSize: 14, fontWeight: 600, textDecoration: "none" }}
            >
              Go to my profile
            </a>
          </div>
        ) : (
          standings.map((s, i) => (
            <div key={s.user_id} style={{
              display: "flex", alignItems: "center", gap: 14, padding: "14px 20px",
              borderBottom: i < standings.length - 1 ? `1px solid ${G.line}` : "none",
              background: i < 3 ? G.surfaceSoft : "transparent",
            }}>
              <RankTag rank={i + 1} />
              <Avatar url={s.avatar_url} name={s.username ?? s.full_name} size={36} />
              <p style={{ flex: 1, margin: 0, color: G.text, fontSize: 14, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.username ?? s.full_name ?? "Creator"}
              </p>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <p style={{ margin: 0, color: G.text, fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {Number(s.likes_count).toLocaleString()} <span style={{ color: G.muted, fontSize: 12, fontWeight: 500 }}>likes</span>
                </p>
                {i < 3 && <p style={{ margin: 0, color: G.mint, fontSize: 11 }}>{REWARDS[i]} QLC</p>}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Hall of Fame */}
      {Object.keys(hofByPeriod).length > 0 && (
        <div style={{ ...glass, overflow: "hidden" }}>
          <button onClick={() => setHofOpen((v) => !v)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", background: "transparent", border: "none", cursor: "pointer" }}>
            <span style={{ color: G.text, fontSize: 15, fontWeight: 600 }}>Hall of Fame</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={G.muted} strokeWidth={2} style={{ transform: hofOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {hofOpen && (
            <div style={{ borderTop: `1px solid ${G.line}` }}>
              {Object.entries(hofByPeriod).map(([key, entries]) => {
                const [y, m] = key.split("-")
                return (
                  <div key={key} style={{ padding: "16px 20px", borderBottom: `1px solid ${G.line}` }}>
                    <p style={{ margin: "0 0 12px", color: G.muted, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.14em" }}>{monthName(Number(m), Number(y))}</p>
                    {entries.map((e) => (
                      <div key={`${e.user_id}-${e.rank}`} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                        <RankTag rank={e.rank} />
                        <div style={{ flex: 1 }}>
                          <p style={{ margin: 0, color: G.text, fontSize: 13 }}>{e.profiles?.username ?? e.profiles?.full_name ?? "Creator"}</p>
                          <p style={{ margin: 0, color: G.faint, fontSize: 11 }}>{e.likes_count} likes</p>
                        </div>
                        <span style={{ color: G.mint, fontSize: 13, fontWeight: 600 }}>+{e.credits_awarded}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CommunityPage() {
  const router = useRouter()

  const [typeTab, setTypeTab] = useState<TypeTab>("creators")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [creators, setCreators] = useState<any[]>([])
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set())
  const [topCount, setTopCount] = useState(10)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [newCreators, setNewCreators] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Load creators when tab is active (real data only, no injected placeholders)
  useEffect(() => {
    if (typeTab !== "creators") return
    fetch("/api/creators")
      .then((r) => r.json())
      .then((creatorsData) => {
        const topList = creatorsData.creators || []
        setCreators(topList)
        setTopCount(creatorsData.topCount || topList.length || 10)
        setNewCreators(creatorsData.newCreators || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [typeTab])

  const toggleFollow = async (id: string) => {
    const res = await fetch("/api/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ following_id: id }) })
    const data = await res.json().catch(() => ({}))
    if (data.following !== undefined) {
      setFollowingIds((prev) => { const next = new Set(prev); if (data.following) { next.add(id) } else { next.delete(id) } return next })
      setCreators((prev) => prev.map((c) => c.id === id ? { ...c, followers_count: data.following ? (c.followers_count || 0) + 1 : Math.max((c.followers_count || 1) - 1, 0) } : c))
    }
  }

  const TYPE_TABS: { id: TypeTab; label: string }[] = [
    { id: "creators", label: "Creators" },
    { id: "leaderboard", label: "Leaderboard" },
  ]
  const monthLabel = new Date().toLocaleString("en", { month: "long", year: "numeric" })

  return (
    <div style={{ position: "relative", minHeight: "100%", color: G.text }}>
      <QelarixBackdrop tone="emerald" />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 1120, margin: "0 auto", padding: "36px 16px 96px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 28 }}>
          <div>
            <p style={{ margin: 0, color: G.mint, fontSize: 12, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase" }}>Qelarix community</p>
            <h1 style={{ margin: "6px 0 0", fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }}>Community</h1>
            <p style={{ margin: "6px 0 0", color: G.muted, fontSize: 14 }}>Creators, live work and the monthly leaderboard.</p>
          </div>
          <div style={{ ...glass, borderRadius: 12, padding: 4, display: "flex", gap: 4 }}>
            {TYPE_TABS.map((tab) => {
              const active = typeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setTypeTab(tab.id)}
                  className="transition-colors"
                  style={{
                    padding: "8px 16px", borderRadius: 9, border: "none", cursor: "pointer",
                    fontSize: 13, fontWeight: 600,
                    color: active ? "#04110C" : G.muted,
                    background: active ? G.mint : "transparent",
                  }}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
        </div>

        {typeTab === "creators" ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Top {topCount} creators</h2>
              <span style={{ color: G.faint, fontSize: 12 }}>{monthLabel}</span>
            </div>

            {loading ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 }}>
                {[...Array(4)].map((_, i) => <div key={i} style={{ ...glass, height: 250, opacity: 0.6 }} />)}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14, marginBottom: 36 }}>
                {creators.map((creator, idx) => {
                  const rank = creator.rank || idx + 1
                  const following = followingIds.has(creator.id)
                  return (
                    <div
                      key={creator.id || creator.username}
                      onClick={() => { if (creator.username) router.push("/u/" + creator.username) }}
                      className="transition-transform duration-200 hover:-translate-y-0.5"
                      style={{
                        ...glass, padding: "20px 18px", textAlign: "center", position: "relative",
                        cursor: creator.username ? "pointer" : "default",
                        borderColor: rank <= 3 ? G.lineStrong : G.line,
                      }}
                    >
                      <div style={{ position: "absolute", top: 14, left: 14 }}><RankTag rank={rank} /></div>
                      <div style={{ display: "flex", justifyContent: "center", margin: "6px 0 12px" }}>
                        <Avatar url={creator.avatar_url} name={creator.display_name} size={72} ring={rank <= 3} />
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{creator.display_name}</div>
                      <div style={{ color: G.faint, fontSize: 12, marginTop: 2, minHeight: 16 }}>{creator.username ? `@${creator.username}` : ""}</div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", margin: "14px 0", borderTop: `1px solid ${G.line}`, borderBottom: `1px solid ${G.line}` }}>
                        {[{ v: creator.total_likes || 0, l: "Likes" }, { v: creator.followers_count || 0, l: "Followers" }].map((s, i) => (
                          <div key={s.l} style={{ padding: "10px 4px", borderLeft: i ? `1px solid ${G.line}` : "none" }}>
                            <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{Number(s.v).toLocaleString()}</div>
                            <div style={{ fontSize: 10, color: G.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>{s.l}</div>
                          </div>
                        ))}
                      </div>

                      {creator.id && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFollow(creator.id) }}
                          className="transition-colors hover:bg-white/10"
                          style={{
                            width: "100%", padding: "9px", borderRadius: 10, border: "none", cursor: "pointer",
                            fontSize: 13, fontWeight: 600,
                            background: following ? "transparent" : "rgba(110,231,183,0.10)",
                            color: following ? G.muted : G.text,
                          }}
                        >
                          {following ? "Following" : "Follow"}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {newCreators.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>New creators</h2>
                  <span style={{ color: G.faint, fontSize: 12 }}>Recently joined</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
                  {newCreators.map((creator) => (
                    <div
                      key={creator.id || creator.username}
                      onClick={() => { if (creator.username) router.push("/u/" + creator.username) }}
                      className="transition-colors"
                      style={{ ...glass, borderRadius: 14, padding: 14, cursor: creator.username ? "pointer" : "default", display: "flex", alignItems: "center", gap: 12 }}
                    >
                      <Avatar url={creator.avatar_url} name={creator.display_name} size={44} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{creator.display_name}</div>
                        <div style={{ color: G.faint, fontSize: 12 }}>{creator.username ? `@${creator.username}` : "New on Qelarix"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <LeaderboardSection />
        )}
      </div>
    </div>
  )
}
