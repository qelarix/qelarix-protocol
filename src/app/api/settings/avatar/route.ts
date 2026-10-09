/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createClient } from '@supabase/supabase-js'
import { recordStorageAsset } from '@/lib/storageUsage'

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

    const formData = await req.formData()
    // Support both "file" (SettingsClient) and "avatar" (dashboard direct upload)
    const file = (formData.get('file') ?? formData.get('avatar')) as File | null
    if (!file) {
      return NextResponse.json({ error: 'No file' }, { status: 400 })
    }
    if (!file.type.startsWith('image/')) {
      return NextResponse.json({ error: 'File must be an image' }, { status: 400 })
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 })
    }

    const ext = file.name.split('.').pop() || 'jpg'
    const path = `avatars/${authUser.id}.${ext}`
    const buffer = await file.arrayBuffer()

    const { error: uploadError } = await admin.storage
      .from('avatars')
      .upload(path, buffer, {
        contentType: file.type,
        upsert: true,
      })

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    const { data } = admin.storage.from('avatars').getPublicUrl(path)
    const avatarUrl = `${data.publicUrl}?t=${Date.now()}`

    await admin
      .from('profiles')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('id', authUser.id)

    // Best-effort: record the stored avatar for global storage usage (Phase 3A).
    // Inner try/catch so tracking never fails the upload response (the outer
    // catch would otherwise turn a tracking error into a 500).
    try {
      await recordStorageAsset({
        userId: authUser.id,
        bucket: 'avatars',
        path,
        sizeBytes: file.size,
        assetType: 'avatar',
        sourceType: 'uploaded',
        sourceTable: 'profiles',
        sourceId: authUser.id,
        metadata: {
          mimeType: file.type,
          publicUrl: data.publicUrl,
        },
      })
    } catch (trackErr) {
      console.error(
        '[settings/avatar] storage tracking failed',
        trackErr instanceof Error ? trackErr.message : trackErr,
      )
    }

    return NextResponse.json({ avatarUrl })
  } catch (err: any) {
    console.error('[settings/avatar]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
