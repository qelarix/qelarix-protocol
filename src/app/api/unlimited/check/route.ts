import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ unlimited: false })

  const { searchParams } = new URL(req.url)
  const model_id = searchParams.get('model')
  if (!model_id) return NextResponse.json({ unlimited: false })

  const now = new Date().toISOString()

  const { data } = await admin
    .from('unlimited_periods')
    .select('*')
    .eq('user_id', authUser.id)
    .eq('model_id', model_id)
    .eq('is_active', true)
    .gt('expires_at', now)
    .single()

  if (!data) return NextResponse.json({ unlimited: false })

  const row = data as {
    limit_count: number | null
    used_count: number
    expires_at: string
  }

  if (row.limit_count !== null && row.used_count >= row.limit_count) {
    return NextResponse.json({ unlimited: false, reason: 'limit_reached' })
  }

  const daysLeft = Math.ceil(
    (new Date(row.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  )

  return NextResponse.json({
    unlimited: true,
    limit: row.limit_count,
    used: row.used_count,
    remaining: row.limit_count !== null ? row.limit_count - row.used_count : null,
    daysLeft,
    expires_at: row.expires_at,
  })
}
