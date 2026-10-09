"use client";

import { useEffect } from "react";
import { Toaster as SonnerToaster, toast } from "sonner";

export default function Toaster() {
  // A wallet status queued before a full page load (sign-out navigates) shows once the toaster is mounted.
  useEffect(() => flushWalletStatus(), []);

  return (
    <SonnerToaster
      position="bottom-right"
      // Above the cookie banner while it is shown (CookieConsent sets --cookie-banner-height); Sonner's defaults otherwise.
      offset={{ bottom: "calc(24px + var(--cookie-banner-height, 0px))" }}
      mobileOffset={{ bottom: "calc(16px + var(--cookie-banner-height, 0px))" }}
      toastOptions={{
        style: {
          background: "rgba(15, 15, 25, 0.95)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "#fff",
          borderRadius: "12px",
          fontSize: "14px",
          fontFamily: "var(--font-geist-sans, sans-serif)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        },
        classNames: {
          success: "border-l-4 border-l-green-500",
          error: "border-l-4 border-l-red-500",
          warning: "border-l-4 border-l-yellow-500",
          info: "border-l-4 border-l-blue-500",
        },
      }}
      richColors
      closeButton
      duration={5000}
    />
  );
}

// Re-export toast for easy use throughout the app
export { toast } from "sonner";

// ─── Wallet status toasts ─────────────────────────────────────────────────────

export type WalletStatus = "connected" | "disconnected" | "failed" | "cancelled";

// One slot: a newer wallet status replaces the visible one instead of stacking a duplicate.
const WALLET_TOAST_ID = "wallet-status";
const WALLET_TOAST_QUEUE = "qelarix.walletStatus";
const WALLET_STATUSES: readonly WalletStatus[] = ["connected", "disconnected", "failed", "cancelled"];

const WALLET_TONES = {
  success: { color: "#34D399", icon: "!text-[#34D399]" },
  warning: { color: "#F5B85A", icon: "!text-[#F5B85A]" },
  error: { color: "#F87171", icon: "!text-[#F87171]" },
};

function walletToastOptions(tone: keyof typeof WALLET_TONES) {
  const { color, icon } = WALLET_TONES[tone];
  return {
    id: WALLET_TOAST_ID,
    duration: 3500,
    style: { border: `1px solid ${color}40`, padding: "12px 14px", fontSize: "13px" },
    // Dark close button (the global rich colors would give it a light pastel circle).
    classNames: { icon, closeButton: "!bg-[#0f0f19] !border-white/15 !text-white/70 hover:!text-white" },
  };
}

/** Compact bottom-right status for a wallet sign-in, sign-out, failure or cancellation. */
export function showWalletStatus(status: WalletStatus, walletName?: string | null) {
  const wallet = walletName?.trim() ? `${walletName.trim()} wallet` : "Wallet";
  if (status === "connected") toast.success(`${wallet} connected successfully`, walletToastOptions("success"));
  else if (status === "disconnected") toast.success(`${wallet} disconnected`, walletToastOptions("success"));
  else if (status === "failed") toast.error(`${wallet} connection failed`, walletToastOptions("error"));
  else toast.warning("Wallet connection cancelled", walletToastOptions("warning"));
}

/** Shows the status after the next full page load (for actions that navigate away). */
export function queueWalletStatus(status: WalletStatus, walletName?: string | null) {
  try {
    sessionStorage.setItem(WALLET_TOAST_QUEUE, JSON.stringify({ status, walletName: walletName ?? null }));
  } catch {
    // Storage unavailable: the status is simply not shown.
  }
}

function flushWalletStatus() {
  try {
    const raw = sessionStorage.getItem(WALLET_TOAST_QUEUE);
    if (!raw) return;
    sessionStorage.removeItem(WALLET_TOAST_QUEUE);
    const { status, walletName } = JSON.parse(raw) as { status: WalletStatus; walletName: string | null };
    if (WALLET_STATUSES.includes(status)) showWalletStatus(status, walletName);
  } catch {
    // Storage unavailable or malformed entry: nothing to show.
  }
}
