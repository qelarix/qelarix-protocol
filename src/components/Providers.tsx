'use client'
import { AuthSessionProvider } from '@/components/providers/AuthSessionProvider'
import QlcFundsPrompt from '@/components/payments/QlcFundsPrompt'

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthSessionProvider>
      {children}
      <QlcFundsPrompt />
    </AuthSessionProvider>
  )
}
