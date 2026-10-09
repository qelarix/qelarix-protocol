"use client";

import { useEffect } from "react";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("[AppError]", error);
  }, [error]);

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "#050505" }}
    >
      <div className="text-center max-w-md">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6"
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.2)",
          }}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(239,68,68,0.8)" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">Something went wrong</h1>
        <p className="text-white/50 text-sm mb-2 leading-relaxed">
          An unexpected error occurred. Our team has been automatically notified.
        </p>
        {error?.digest && (
          <p className="text-white/25 text-xs mb-6 font-mono">
            Error ID: {error.digest}
          </p>
        )}

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="px-6 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95"
            style={{ background: "linear-gradient(135deg, #7B61FF, #3BE7FF)" }}
          >
            Try again
          </button>
          <a
            href="/"
            className="px-6 py-3 rounded-xl text-sm font-medium text-white/70 hover:text-white transition-all"
            style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          >
            Go to homepage
          </a>
        </div>
      </div>
    </div>
  );
}
