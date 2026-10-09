/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const authUser = await getRequestAuthUser(req)
    if (!authUser?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await req.json()
    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    }

    // Load the generation
    const { data: gen, error: fetchError } = await admin
      .from('generations')
      .select('*')
      .eq('id', id)
      .eq('user_id', authUser.id)
      .single()

    if (fetchError || !gen) {
      return NextResponse.json({ error: 'Generation not found' }, { status: 404 })
    }

    // Upload u Supabase Storage 'public' bucket za permanentni URL
    let permanentUrl = gen.output_url
    try {
      const fileRes = await fetch(gen.output_url)
      if (fileRes.ok) {
        const buffer = await fileRes.arrayBuffer()
        const ext = gen.type === 'video' ? 'mp4'
          : gen.type === 'audio' ? 'mp3' : 'jpg'
        const path = `${authUser.id}/${id}.${ext}`
        const contentType = gen.type === 'video' ? 'video/mp4'
          : gen.type === 'audio' ? 'audio/mpeg' : 'image/jpeg'

        await admin.storage
          .from('public')
          .upload(path, buffer, { contentType, upsert: true })

        const { data } = admin.storage.from('public').getPublicUrl(path)
        if (data.publicUrl) permanentUrl = data.publicUrl
      }
    } catch (uploadErr) {
      console.error('[publish upload]', uploadErr)
      // Continue without the upload — only set is_public
    }

    // Update generations tabela
    const { error: updateError } = await admin
      .from('generations')
      .update({
        is_public: true,
        output_url: permanentUrl,
      })
      .eq('id', id)
      .eq('user_id', authUser.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      url: permanentUrl,
      type: gen.type,
    })
  } catch (err: any) {
    console.error('[publish]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
