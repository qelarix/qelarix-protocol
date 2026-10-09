import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuthUser } from '@/lib/authSession'
import { generationBillingMode, getGenerationBalance } from '@/lib/billing/generationBilling'
import { isInternalUser } from '@/lib/planAccess'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const authUser = await getRequestAuthUser(req)
  if (!authUser?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { data, error } = await admin
    .from('profiles')
    .select('*')
    .eq('id', authUser.id)
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  // In QLC billing mode the spendable balance is the wallet's on-chain QLC, not profiles.credits.
  const profile = generationBillingMode() === 'qlc'
    ? { ...data, credits: await getGenerationBalance(authUser).catch(() => 0) }
    : data
  return NextResponse.json({ profile, internal: isInternalUser(authUser) })
}
