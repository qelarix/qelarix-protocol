/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/

async function handler(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { username, full_name, bio, avatar_url } = body

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    }
    if (username !== undefined) {
      const clean = typeof username === 'string' ? username.trim() : ''
      if (clean && !USERNAME_RE.test(clean)) {
        return NextResponse.json(
          { error: 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore.' },
          { status: 400 },
        )
      }
      updateData.username = clean || null
    }
    // Settings sends "full_name"; public pages (creators, /u/[username], community) read "display_name".
    // Keep both columns in sync so the name shows everywhere.
    if (full_name !== undefined) {
      const name = typeof full_name === 'string' ? full_name.trim().slice(0, 80) || null : null
      updateData.full_name = name
      updateData.display_name = name
    }
    if (bio !== undefined) updateData.bio = bio?.trim() || null
    if (avatar_url !== undefined) updateData.avatar_url = avatar_url || null

    const { data, error } = await admin
      .from('profiles')
      .update(updateData)
      .eq('id', authUser.id)
      .select()
      .single()

    if (error) {
      if (error.code === '23505' && String(error.message).includes('username')) {
        return NextResponse.json({ error: 'This username is already taken. Please choose another one.' }, { status: 409 })
      }
      console.error('[settings/profile]', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, profile: data })
  } catch (err: any) {
    console.error('[settings/profile]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export const POST = handler
export const PATCH = handler
