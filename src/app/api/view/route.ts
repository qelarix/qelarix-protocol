import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  const { generation_id } = await req.json()
  if (!generation_id) return NextResponse.json({ ok: false })

  await admin.rpc('increment_views', { gen_id: generation_id })
  // Update monthly stats za kreatora
  const { data: gen } = await admin
    .from('generations')
    .select('user_id')
    .eq('id', generation_id)
    .single()
  if (gen?.user_id) {
    await admin.rpc('update_monthly_stats_view', {
      p_user_id: gen.user_id,
    })
  }
  return NextResponse.json({ ok: true })
}
