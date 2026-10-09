import { NextResponse } from 'next/server'
import { createSupabaseAdmin } from '@/lib/supabase/admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin = createSupabaseAdmin() as any

// Live data: never serve a cached/static response (Next.js would otherwise freeze this GET at build time).
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()

  // Try monthly_creator_stats for current month
  const { data: statsData } = await admin
    .from('monthly_creator_stats')
    .select('user_id, score, likes_count, profiles(id, username, display_name, avatar_url, followers_count, total_likes, bio)')
    .eq('month', month)
    .eq('year', year)
    .order('score', { ascending: false })
    .limit(10)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let topCreators: any[] = []

  if (statsData && statsData.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    topCreators = statsData.map((s: any, i: number) => ({
      id: s.profiles?.id || s.user_id,
      username: s.profiles?.username,
      display_name: s.profiles?.display_name || s.profiles?.username || 'Creator',
      avatar_url: s.profiles?.avatar_url,
      followers_count: s.profiles?.followers_count || 0,
      total_likes: s.likes_count || s.profiles?.total_likes || 0,
      bio: s.profiles?.bio,
      rank: i + 1,
      isTop10: true,
    }))
  } else {
    // Fallback: profiles ordered by total_likes
    const { data: profilesData } = await admin
      .from('profiles')
      .select('id, username, display_name, avatar_url, followers_count, total_likes, bio')
      .order('total_likes', { ascending: false })
      .limit(10)

    if (profilesData && profilesData.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      topCreators = profilesData.map((p: any, i: number) => ({
        id: p.id,
        username: p.username,
        display_name: p.display_name || p.username || 'Creator',
        avatar_url: p.avatar_url,
        followers_count: p.followers_count || 0,
        total_likes: p.total_likes || 0,
        bio: p.bio,
        rank: i + 1,
        isTop10: true,
      }))
    } else {
      // Final fallback: demo_creators
      const { data: demoData } = await admin
        .from('demo_creators')
        .select('*')
        .order('followers_count', { ascending: false })
        .limit(10)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      topCreators = (demoData || []).map((d: any, i: number) => ({
        ...d,
        rank: i + 1,
        isTop10: true,
        isDemo: true,
      }))
    }
  }

  // Newest profiles as "new creators"
  const { data: newData } = await admin
    .from('profiles')
    .select('id, username, display_name, avatar_url, followers_count, total_likes, bio, created_at')
    .order('created_at', { ascending: false })
    .limit(8)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newCreators = (newData || []).map((p: any) => ({
    id: p.id,
    username: p.username,
    display_name: p.display_name || p.username || 'New Creator',
    avatar_url: p.avatar_url,
    followers_count: p.followers_count || 0,
    total_likes: p.total_likes || 0,
    bio: p.bio,
    isNew: true,
  }))

  return NextResponse.json({
    creators: topCreators,
    newCreators,
    month,
    year,
    topCount: topCreators.length,
  })
}
