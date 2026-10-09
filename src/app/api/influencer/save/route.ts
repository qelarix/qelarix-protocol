import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createSupabaseAdmin } from '@/lib/supabase/admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any

interface SaveInfluencerBody {
  name: string
  niche: string
  personality: string
  voice: string
  language: string
  referenceImages?: string[]
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await req.json()) as SaveInfluencerBody
    const { name, niche, personality, voice, language, referenceImages } = body

    if (!name?.trim() || !niche) {
      return NextResponse.json({ error: 'Name and niche are required' }, { status: 400 })
    }

    const admin: AdminAny = createSupabaseAdmin()

    // Check if influencer with same name already exists for this user
    const { data: existing } = await admin
      .from('characters')
      .select('id')
      .eq('user_id', authUser.id)
      .eq('name', name.trim())
      .single()

    const description = JSON.stringify({
      type: 'influencer',
      niche: niche.trim(),
      personality: personality?.trim() || '',
      voice: voice?.trim() || '',
      language: language || 'English',
    })

    if (existing?.id) {
      // Update existing
      const { data, error } = await admin
        .from('characters')
        .update({
          description,
          reference_images: referenceImages ?? [],
        })
        .eq('id', existing.id)
        .select('*')
        .single()

      if (error) {
        console.error('[influencer/save] update error:', error)
        return NextResponse.json({ error: 'Could not update the influencer' }, { status: 500 })
      }

      return NextResponse.json({ influencer: data, updated: true })
    }

    // Create new
    const { data, error } = await admin
      .from('characters')
      .insert({
        user_id: authUser.id,
        name: name.trim(),
        description,
        reference_images: referenceImages ?? [],
        type: 'character',
      })
      .select('*')
      .single()

    if (error) {
      console.error('[influencer/save] insert error:', error)
      return NextResponse.json({ error: 'Could not save the influencer' }, { status: 500 })
    }

    return NextResponse.json({ influencer: data }, { status: 201 })
  } catch (err) {
    console.error('[influencer/save]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
