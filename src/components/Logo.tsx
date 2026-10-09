import Image from 'next/image'

export default function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const widths = { sm: 120, md: 140, lg: 160 }
  const heights = { sm: 48, md: 56, lg: 64 }
  return (
    <Image
      src="/qelarix_logo.png"
      alt="Qelarix"
      width={widths[size]}
      height={heights[size]}
      style={{ objectFit: 'contain' }}
    />
  )
}
