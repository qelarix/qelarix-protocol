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

  const { following_id } = await req.json()
  if (!following_id) return NextResponse.json({ error: 'Missing following_id' }, { status: 400 })

  if (authUser.id === following_id) return NextResponse.json({ error: 'Cannot follow yourself' }, { status: 400 })

  const { data: existing } = await admin
    .from('follows')
    .select('id')
    .eq('follower_id', authUser.id)
    .eq('following_id', following_id)
    .single()

  if (existing) {
    await admin.from('follows').delete().eq('id', existing.id)
    await admin.rpc('decrement_followers', { profile_id: following_id })
    const { data: followerProfile } = await admin
      .from('profiles').select('following_count').eq('id', authUser.id).single()
    await admin.from('profiles')
      .update({ following_count: Math.max((followerProfile?.following_count || 1) - 1, 0) })
      .eq('id', authUser.id)
    return NextResponse.json({ following: false })
  } else {
    await admin.from('follows').insert({ follower_id: authUser.id, following_id })
    await admin.rpc('increment_followers', { profile_id: following_id })
    const { data: followerProfile } = await admin
      .from('profiles').select('following_count').eq('id', authUser.id).single()
    await admin.from('profiles')
      .update({ following_count: (followerProfile?.following_count || 0) + 1 })
      .eq('id', authUser.id)
    return NextResponse.json({ following: true })
  }
}
