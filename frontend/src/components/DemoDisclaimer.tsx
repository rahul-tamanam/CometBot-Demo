import { DEMO_DISCLAIMER, DEMO_DISCLAIMER_SHORT } from '@/lib/demoMessages'

type Props = {
  variant?: 'banner' | 'footer' | 'compact'
}

export function DemoDisclaimer({ variant = 'banner' }: Props) {
  if (variant === 'compact') {
    return (
      <p
        className="text-center text-[11px] leading-snug"
        style={{ color: 'var(--text-muted)' }}
        role="note"
      >
        {DEMO_DISCLAIMER_SHORT}
      </p>
    )
  }

  if (variant === 'footer') {
    return (
      <footer
        className="border-t px-4 py-3 text-center text-[11px] leading-relaxed"
        style={{
          borderColor: 'var(--border)',
          color: 'var(--text-muted)',
          background: 'var(--surface2)',
        }}
        role="contentinfo"
      >
        {DEMO_DISCLAIMER}
      </footer>
    )
  }

  return (
    <div
      className="mx-auto mb-4 max-w-2xl rounded-xl border px-4 py-3 text-center text-xs leading-relaxed"
      style={{
        borderColor: 'var(--border)',
        background: 'rgba(254, 101, 7, 0.06)',
        color: 'var(--text-muted)',
      }}
      role="note"
    >
      <strong className="font-semibold text-[color:var(--text)]">Portfolio demo only.</strong>{' '}
      {DEMO_DISCLAIMER}
    </div>
  )
}
