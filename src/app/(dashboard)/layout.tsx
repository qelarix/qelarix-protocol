// Studio pages are open to everyone, signed in or not (owner decision 2026-10-08). Actions that
// spend QLC still require a wallet session: the API routes check it and the pages send signed-out
// users to /login when they try. Personal pages (/dashboard, /settings) stay protected in middleware.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#050505]">
      <div className="flex-1 flex flex-col min-h-screen lg:min-h-0 overflow-x-hidden">
        <main className="flex-1">{children}</main>
      </div>
    </div>
  )
}
