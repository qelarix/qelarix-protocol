import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const UNLIMITED_CONFIG: Record<string, { model: string; limit: number | null }[]> = {
  pro: [
    { model: 'kling3', limit: null },
  ],
  business: [
    { model: 'kling3', limit: null },
    { model: 'nanobanana2', limit: 2000 },
    { model: 'nanobanana_pro', limit: 2000 },
  ],
  ultra: [
    { model: 'kling3', limit: null },
    { model: 'nanobanana2', limit: 2000 },
    { model: 'nanobanana_pro', limit: 2000 },
  ],
}

export async function POST(req: NextRequest) {
  const { user_id, plan } = await req.json() as { user_id?: string; plan?: string }
  if (!user_id || !plan) return NextResponse.json({ error: 'Missing params' }, { status: 400 })

  const config = UNLIMITED_CONFIG[plan]
  if (!config) return NextResponse.json({ ok: true, message: 'No unlimited for this plan' })

  const now = new Date()
  const expires = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)

  await admin
    .from('unlimited_periods')
    .update({ is_active: false })
    .eq('user_id', user_id)
    .eq('is_active', true)

  const inserts = config.map(c => ({
    user_id,
    model_id: c.model,
    plan,
    limit_count: c.limit,
    used_count: 0,
    started_at: now.toISOString(),
    expires_at: expires.toISOString(),
    is_active: true,
  }))

  await admin.from('unlimited_periods').insert(inserts)

  return NextResponse.json({ ok: true, expires_at: expires.toISOString() })
}
