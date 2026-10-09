import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(
  req: NextRequest,
  { params }: { params: { username: string } }
) {
  const { username } = params

  const { data: profile } = await admin
    .from('profiles')
    .select('*')
    .eq('username', username)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const { data: generations } = await admin
    .from('generations')
    .select('*')
    .eq('user_id', profile.id)
    .eq('is_public', true)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({ profile, generations: generations || [] })
}
