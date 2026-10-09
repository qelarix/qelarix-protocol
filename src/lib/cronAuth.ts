import { timingSafeEqual } from "node:crypto"

/** Shortest CRON_SECRET accepted; a missing or short secret disables the protected job instead of opening it. */
export const MIN_CRON_SECRET_LENGTH = 32

export type CronAuthResult = "ok" | "unauthorized" | "not_configured"

/** Checks `Authorization: Bearer <CRON_SECRET>` (sent by Vercel Cron) in constant time. */
export function checkCronAuthorization(header: string | null, secret: string | undefined = process.env.CRON_SECRET): CronAuthResult {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) return "not_configured"
  const expected = Buffer.from(`Bearer ${secret}`)
  const received = Buffer.from(header ?? "")
  return received.length === expected.length && timingSafeEqual(received, expected) ? "ok" : "unauthorized"
}
