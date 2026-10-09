"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type ConsentValue = "all" | "essential";

const STORAGE_KEY = "cookie_consent_v2";

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const [consent, setConsent] = useState<ConsentValue | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ConsentValue | null;
    if (!stored) {
      const t = setTimeout(() => setVisible(true), 1500);
      return () => clearTimeout(t);
    }
    setConsent(stored);
  }, []);

  // While the banner is shown, publish its height so the toaster (src/components/Toaster.tsx) sits above it.
  const bannerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const banner = bannerRef.current;
    if (!banner) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--cookie-banner-height", `${banner.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--cookie-banner-height");
    };
  }, [visible, consent]);

  const accept = (value: ConsentValue) => {
    localStorage.setItem(STORAGE_KEY, value);
    setConsent(value);
    setVisible(false);
    if (value === "all") {
      window.dispatchEvent(new CustomEvent("cookie-consent", { detail: { analytics: true, marketing: true } }));
    } else {
      window.dispatchEvent(new CustomEvent("cookie-consent", { detail: { analytics: false, marketing: false } }));
    }
  };

  if (!visible || consent) return null;

  return (
    <div
      ref={bannerRef}
      className="fixed bottom-0 left-0 right-0 z-[9999] px-4 py-5 animate-in slide-in-from-bottom duration-500"
      style={{
        background: "rgba(10, 10, 15, 0.92)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 -8px 32px rgba(0,0,0,0.4)",
      }}
    >
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3 flex-1">
          <span className="text-2xl flex-shrink-0 mt-0.5">🍪</span>
          <div>
            <p className="text-white font-semibold text-sm mb-1">
              We use cookies
            </p>
            <p className="text-white/55 text-xs leading-relaxed max-w-2xl">
              We use necessary cookies for platform functionality, and optional analytics cookies to improve your experience. Your data is processed in accordance with our{" "}
              <Link href="/privacy" className="text-purple-400 hover:text-purple-300 underline underline-offset-2">
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link href="/cookie-policy" className="text-purple-400 hover:text-purple-300 underline underline-offset-2">
                Cookie Policy
              </Link>
              . (GDPR)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0 self-end sm:self-auto">
          <button
            onClick={() => accept("essential")}
            className="px-5 py-2.5 rounded-xl text-sm font-medium text-white/70 hover:text-white transition-all hover:bg-white/5"
            style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          >
            Essential only
          </button>
          <button
            onClick={() => accept("all")}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95"
            style={{
              background: "linear-gradient(135deg, #7B61FF, #3BE7FF)",
              boxShadow: "0 0 20px rgba(123,97,255,0.35)",
            }}
          >
            Accept all
          </button>
        </div>
      </div>
    </div>
  );
}
