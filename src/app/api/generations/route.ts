import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { createSupabaseAdmin } from '@/lib/supabase/admin'

export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 200)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createSupabaseAdmin() as any
  let query = admin
    .from('generations')
    .select('id, type, model, prompt, status, output_url, credits_used, settings, is_public, created_at')
    .eq('user_id', authUser.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (type) query = query.eq('type', type)

  const { data, error } = await query
  if (error) {
    console.error('[generations] Supabase error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data || []) as Record<string, unknown>[]
  const isCinemaRow = (row: Record<string, unknown>) => {
    const settings = row.settings && typeof row.settings === 'object' ? (row.settings as Record<string, unknown>) : {}
    return settings.cinema_scene === true
  }

  // Attach a SAFE reusable still for Cinema Studio items only: the linked scene's thumbnail, and
  // ONLY when it is one of OUR OWN public generations-bucket https images (same expectations as the
  // Cinema reference-by-URL ingestion validator). Never the mp4, never fal-hosted last_frame_url.
  // Linkage: generations.id === cinema_scenes.generation_id — one read-only lookup, NO schema change.
  const cinemaGenIds = rows.filter(isCinemaRow).map((r) => r.id).filter((id): id is string => typeof id === 'string')
  const thumbByGenId = new Map<string, string>()
  if (cinemaGenIds.length > 0) {
    const { data: scenes } = await admin
      .from('cinema_scenes')
      .select('generation_id, thumbnail_url')
      .in('generation_id', cinemaGenIds)
    for (const sc of (scenes || []) as { generation_id: string | null; thumbnail_url: string | null }[]) {
      if (sc.generation_id && typeof sc.thumbnail_url === 'string' && sc.thumbnail_url) {
        thumbByGenId.set(sc.generation_id, sc.thumbnail_url)
      }
    }
  }

  const supabaseHost = (() => { try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '').hostname } catch { return '' } })()
  const isOwnGenerationsImageUrl = (u: string): boolean => {
    let parsed: URL
    try { parsed = new URL(u) } catch { return false }
    if (parsed.protocol !== 'https:') return false // reject http / blob / data / relative
    const isOwnHost = supabaseHost ? parsed.hostname === supabaseHost : parsed.hostname.endsWith('.supabase.co')
    if (!isOwnHost) return false // reject foreign / fal-hosted hosts
    if (!parsed.pathname.includes('/storage/v1/object/public/generations/')) return false
    if (authUser.id && !parsed.pathname.includes(authUser.id)) return false // own objects only
    return true
  }

  const generations = rows.map((row) => {
    // Derive a truthful source from existing stored metadata — NO schema change.
    // Cinema Studio scene generations are tagged settings.cinema_scene === true; everything
    // else (the standalone Playground generate routes) is treated as a Playground generation.
    const source = isCinemaRow(row) ? 'cinema_studio' : 'playground'
    // Optional, additive still_url: Cinema items only, own-bucket thumbnail only (else omitted).
    let still_url: string | undefined
    if (source === 'cinema_studio' && typeof row.id === 'string') {
      const thumb = thumbByGenId.get(row.id)
      if (thumb && isOwnGenerationsImageUrl(thumb)) still_url = thumb
    }
    return {
      ...row,
      url: (() => { try { const p = JSON.parse(row.output_url as string || ''); return Array.isArray(p) ? p[0] : row.output_url } catch { return row.output_url } })(),
      source,
      ...(still_url ? { still_url } : {}),
    }
  })

  return NextResponse.json({ generations })
}
