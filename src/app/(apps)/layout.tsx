// Apps Hub shell — full-width marketplace/gallery without the left Sidebar. URL stays /apps (route
// groups don't affect the URL). Global Header + SessionProvider come from the root layout.
// Open to everyone, signed in or not (owner decision 2026-10-08); generating still requires a
// wallet session, enforced by the API routes.
export default function AppsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full" style={{ background: "#050507" }}>
      {children}
    </div>
  )
}
