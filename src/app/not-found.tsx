import Link from "next/link";

export default function NotFound() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "#000000" }}
    >
      <div className="text-center max-w-lg">
        {/* 404 number with glow */}
        <div className="relative mb-8">
          <p
            className="text-[120px] font-black leading-none select-none"
            style={{
              background: "linear-gradient(135deg, #7B61FF 0%, #3BE7FF 50%, rgba(255,255,255,0.1) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              filter: "drop-shadow(0 0 40px rgba(123,97,255,0.4))",
            }}
          >
            404
          </p>
          <div
            className="absolute inset-0 blur-3xl opacity-20 pointer-events-none"
            style={{ background: "radial-gradient(ellipse, #7B61FF, transparent 70%)" }}
          />
        </div>

        <h1 className="text-2xl font-bold text-white mb-3">Page not found</h1>
        <p className="text-white/50 text-sm leading-relaxed mb-8">
          The page you are looking for does not exist or has been moved.
          Check the URL or go back to the home page.
        </p>

        <div className="flex items-center justify-center gap-3">
          <Link
            href="/"
            className="px-6 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95 inline-block"
            style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
          >
            Home page
          </Link>
          <Link
            href="/dashboard"
            className="px-6 py-3 rounded-xl text-sm font-medium text-white/70 hover:text-white transition-all inline-block"
            style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          >
            Dashboard
          </Link>
        </div>

        {/* Decorative grid */}
        <div className="mt-12 opacity-20 pointer-events-none">
          <div className="grid grid-cols-5 gap-2 justify-center">
            {Array.from({ length: 15 }).map((_, i) => (
              <div
                key={i}
                className="w-8 h-8 rounded-lg"
                style={{
                  background: `rgba(123,97,255,${0.1 + (i % 5) * 0.05})`,
                  border: "1px solid rgba(255,255,255,0.05)",
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
