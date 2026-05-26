import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import {
  DEMO_ACK_STORAGE_KEY,
  DEMO_LEGAL_SECTIONS,
  DEMO_MODAL_CHECKBOX_LABEL,
  DEMO_MODAL_INTRO,
  DEMO_MODAL_TITLE,
} from '@/lib/demoMessages'

function hasAcknowledged(): boolean {
  try {
    return sessionStorage.getItem(DEMO_ACK_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function markAcknowledged() {
  try {
    sessionStorage.setItem(DEMO_ACK_STORAGE_KEY, 'true')
  } catch {
    // ignore
  }
}

type Props = {
  /** When true, modal can appear (e.g. chat dashboard mounted) */
  active?: boolean
}

/**
 * Blocking overlay on first visit to the chat dashboard each browser session.
 */
export function DemoAcknowledgmentModal({ active = true }: Props) {
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (!active) return
    setOpen(!hasAcknowledged())
  }, [active])

  const dismiss = useCallback(() => {
    if (!checked) return
    markAcknowledged()
    setOpen(false)
  }, [checked])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        aria-hidden
      />

      <div
        className="relative flex max-h-[min(90vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
        }}
      >
        <div
          className="flex items-start gap-3 border-b px-5 py-4"
          style={{ borderColor: 'var(--border)', background: 'var(--surface2)' }}
        >
          <div
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'rgba(254, 101, 7, 0.15)', color: '#e87500' }}
          >
            <AlertTriangle size={20} aria-hidden />
          </div>
          <div className="min-w-0 flex-1 pr-6">
            <h2 id="demo-modal-title" className="text-lg font-bold tracking-tight">
              {DEMO_MODAL_TITLE}
            </h2>
            <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {DEMO_MODAL_INTRO}
            </p>
          </div>
          <button
            type="button"
            className="absolute right-3 top-3 rounded-lg p-1 opacity-40"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Close (you must accept to continue)"
            disabled
            title="Accept the notice below to continue"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <ul className="space-y-4 text-sm leading-relaxed">
            {DEMO_LEGAL_SECTIONS.map((section) => (
              <li key={section.heading}>
                <h3 className="font-semibold text-[color:var(--text)]">{section.heading}</h3>
                <p className="mt-1" style={{ color: 'var(--text-muted)' }}>
                  {section.body}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div
          className="space-y-3 border-t px-5 py-4"
          style={{ borderColor: 'var(--border)', background: 'var(--surface2)' }}
        >
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-400 accent-[#FE6507]"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span style={{ color: 'var(--text)' }}>{DEMO_MODAL_CHECKBOX_LABEL}</span>
          </label>
          <button
            type="button"
            disabled={!checked}
            onClick={dismiss}
            className="w-full rounded-full px-4 py-2.5 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-45"
            style={{ background: checked ? '#FE6507' : '#ccc' }}
          >
            Continue to demo
          </button>
        </div>
      </div>
    </div>
  )
}

/** Small persistent badge after modal is dismissed */
export function DemoFloatingBadge() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    setShow(hasAcknowledged())
  }, [])

  if (!show) return null

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[90] max-w-[11rem] rounded-lg border px-3 py-2 text-center text-[10px] font-medium leading-snug shadow-lg"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface)',
        color: 'var(--text-muted)',
      }}
      role="note"
    >
      <span className="font-bold text-[#e87500]">Demo only</span>
      <br />
      Not official UT Dallas advising
    </div>
  )
}
