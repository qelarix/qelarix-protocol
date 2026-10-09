import { ReactNode } from 'react'

export default function CommunityLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: 'fixed',
      top: 56,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 40,
      background: '#04110c',
      overflowY: 'auto',
    }}>
      {children}
    </div>
  )
}
