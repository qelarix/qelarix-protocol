import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createSupabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface Character {
  id: string
  user_id: string
  name: string
  description: string | null
  reference_images: string[]
  type: string
  created_at: string
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const admin: AdminAny = createSupabaseAdmin()

    const { data, error } = await admin
      .from('characters')
      .select('*')
      .eq('user_id', authUser.id)
      .eq('type', 'character')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[influencer/list]', error)
      return NextResponse.json({ error: 'Could not load influencers' }, { status: 500 })
    }

    // Filter only records saved as influencers
    const influencers = (data as Character[]).filter((c) => {
      try {
        const desc = JSON.parse(c.description ?? '{}')
        return desc.type === 'influencer'
      } catch {
        return false
      }
    })

    return NextResponse.json({ influencers })
  } catch (err) {
    console.error('[influencer/list]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
