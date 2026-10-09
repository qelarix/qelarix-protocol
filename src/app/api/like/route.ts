import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { generation_id } = await req.json()
  if (!generation_id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const { data: existing } = await admin
    .from('likes')
    .select('id')
    .eq('user_id', authUser.id)
    .eq('generation_id', generation_id)
    .single()

  if (existing) {
    await admin.from('likes').delete().eq('id', existing.id)
    await admin.rpc('decrement_likes', { gen_id: generation_id })
    // Update monthly stats za kreatora
    const { data: gen } = await admin
      .from('generations')
      .select('user_id')
      .eq('id', generation_id)
      .single()
    if (gen?.user_id) {
      await admin.rpc('update_monthly_stats_like', {
        p_user_id: gen.user_id,
        p_amount: -1,
      })
    }
    return NextResponse.json({ liked: false })
  } else {
    await admin.from('likes').insert({ user_id: authUser.id, generation_id })
    await admin.rpc('increment_likes', { gen_id: generation_id })
    // Update monthly stats za kreatora
    const { data: gen } = await admin
      .from('generations')
      .select('user_id')
      .eq('id', generation_id)
      .single()
    if (gen?.user_id) {
      await admin.rpc('update_monthly_stats_like', {
        p_user_id: gen.user_id,
        p_amount: 1,
      })
    }
    return NextResponse.json({ liked: true })
  }
}

export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  const { searchParams } = new URL(req.url)
  const generation_id = searchParams.get('generation_id')
  if (!generation_id) return NextResponse.json({ liked: false, count: 0 })

  const { count } = await admin
    .from('likes')
    .select('*', { count: 'exact', head: true })
    .eq('generation_id', generation_id)

  let liked = false
  if (authUser?.id) {
    const { data } = await admin
      .from('likes')
      .select('id')
      .eq('user_id', authUser.id)
      .eq('generation_id', generation_id)
      .single()
    liked = !!data
  }

  return NextResponse.json({ liked, count: count || 0 })
}
