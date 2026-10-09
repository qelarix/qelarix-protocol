'use client'
import { useRouter } from 'next/navigation'

interface UpgradeModalProps {
  isOpen: boolean
  onClose: () => void
  requiredPlan: 'starter' | 'pro' | 'business' | 'ultra'
  featureName: string
}

const PLAN_COLORS = {
  starter: '#7B61FF',
  pro: '#3BE7FF',
  business: '#F59E0B',
  ultra: '#EF4444',
}

const PLAN_PRICES = {
  starter: '€15/mo',
  pro: '€36/mo',
  business: '€237/mo',
  ultra: '€79/mo',
}

export default function UpgradeModal({ isOpen, onClose, requiredPlan, featureName }: UpgradeModalProps) {
  const router = useRouter()
  if (!isOpen) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.8)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#111318',
          border: `1px solid ${PLAN_COLORS[requiredPlan]}44`,
          borderRadius: 20,
          padding: 32,
          maxWidth: 400,
          width: '90%',
          textAlign: 'center',
          boxShadow: `0 0 40px ${PLAN_COLORS[requiredPlan]}22`,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
        <h2 style={{ color: '#F4F7FB', fontSize: 20, fontWeight: 800, marginBottom: 8 }}>
          {featureName} requires {requiredPlan.charAt(0).toUpperCase() + requiredPlan.slice(1)} plan
        </h2>
        <p style={{ color: '#AAB2BF', fontSize: 14, marginBottom: 24, lineHeight: 1.5 }}>
          Upgrade your plan to unlock {featureName} and many more powerful features.
        </p>
        <div style={{
          background: `${PLAN_COLORS[requiredPlan]}15`,
          border: `1px solid ${PLAN_COLORS[requiredPlan]}33`,
          borderRadius: 12, padding: '12px 20px',
          marginBottom: 24,
        }}>
          <div style={{ color: PLAN_COLORS[requiredPlan], fontSize: 22, fontWeight: 800 }}>
            {PLAN_PRICES[requiredPlan]}
          </div>
          <div style={{ color: '#AAB2BF', fontSize: 12 }}>
            {requiredPlan.charAt(0).toUpperCase() + requiredPlan.slice(1)} Plan
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '12px',
              background: 'transparent',
              border: '1px solid #2A2F3A',
              borderRadius: 10, color: '#AAB2BF',
              fontSize: 14, cursor: 'pointer',
            }}
          >
            Maybe later
          </button>
          <button
            onClick={() => { onClose(); router.push('/pricing') }}
            style={{
              flex: 1, padding: '12px',
              background: PLAN_COLORS[requiredPlan],
              border: 'none',
              borderRadius: 10, color: 'white',
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Upgrade Now →
          </button>
        </div>
      </div>
    </div>
  )
}
