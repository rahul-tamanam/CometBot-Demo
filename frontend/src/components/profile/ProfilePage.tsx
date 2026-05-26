import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trash2, User, ChevronDown, ChevronUp, X } from 'lucide-react'
import { PROFILE_STORAGE_KEY, type CometbotProfile, type ProfileSemester } from '@/hooks/useProfile'

type TabId = 'account' | 'personalization'

const TERM_ORDER: Record<string, number> = { spring: 0, summer: 1, fall: 2, winter: 3 }

function initials(fullName: string) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'ST'
  const first = parts[0]?.[0] ?? ''
  const last = (parts.length > 1 ? parts[parts.length - 1]?.[0] : parts[0]?.[1]) ?? ''
  const out = (first + last).toUpperCase()
  return out || 'ST'
}

function normalizeCourseId(v: string) {
  const raw = (v || '').trim().toUpperCase()
  // Insert a space between prefix and number if missing (e.g., BUAN6341 -> BUAN 6341)
  return raw.replace(/^([A-Z]+)(\d)/, '$1 $2').replace(/\s+/g, ' ')
}

function parseSemesterLabel(label: string): { year: number; termIdx: number } | null {
  const m = (label || '').trim().match(/^(Spring|Summer|Fall|Winter)\s+(\d{4})$/i)
  if (!m) return null
  const term = m[1].toLowerCase()
  const year = Number(m[2])
  const termIdx = TERM_ORDER[term]
  if (!Number.isFinite(year) || termIdx === undefined) return null
  return { year, termIdx }
}

function nextSemesterLabel(prevLabel: string) {
  const parsed = parseSemesterLabel(prevLabel)
  if (!parsed) return 'Fall 2024'
  const { year, termIdx } = parsed
  const order = ['Spring', 'Summer', 'Fall', 'Winter'] as const
  const nextIdx = (termIdx + 1) % order.length
  const nextYear = termIdx === 2 ? year + 1 : year // after Fall -> next is Spring of next year
  const nextTerm = order[nextIdx]
  return `${nextTerm} ${nextYear}`
}

type CatalogRow = { course_id: string; title: string }

const COURSE_DATALIST_ID = 'msba-profile-courses'
const PROGRAMS = [
  {
    program_id: 'msba',
    program_name: 'MS in Business Analytics and Artificial Intelligence',
  },
  {
    program_id: 'msitm',
    program_name: 'MS in Information Technology and Management',
  },
] as const

async function fetchCourseCatalog(programId: string): Promise<{ ids: Set<string>; rows: CatalogRow[] }> {
  const res = await fetch(`http://localhost:8000/api/courses?program_id=${encodeURIComponent(programId || 'msba')}`)
  if (!res.ok) throw new Error('bad_status')
  const data = (await res.json()) as Array<{ course_id?: string; title?: string }>
  const ids = new Set<string>()
  const rows: CatalogRow[] = []
  for (const c of data || []) {
    const id = normalizeCourseId(String(c.course_id || ''))
    if (!id) continue
    ids.add(id)
    rows.push({ course_id: id, title: String(c.title || '').trim() })
  }
  rows.sort((a, b) => a.course_id.localeCompare(b.course_id))
  return { ids, rows }
}

function Row({
  label,
  children,
  action,
}: {
  label: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </div>
        <div className="mt-1 min-w-0 text-sm" style={{ color: 'var(--text)' }}>
          {children}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

function SmallButton({
  children,
  onClick,
  variant,
  disabled,
  title,
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'outline' | 'solid' | 'danger'
  disabled?: boolean
  title?: string
}) {
  const v = variant ?? 'outline'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={[
        'inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
        v === 'outline'
          ? 'hover:bg-slate-50'
          : v === 'danger'
            ? 'bg-transparent text-red-600 hover:text-red-700'
            : 'text-white',
        disabled ? 'opacity-50' : '',
      ].join(' ')}
      style={
        v === 'outline'
          ? { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }
          : v === 'solid'
            ? {
                background:
                  'linear-gradient(90deg, #ff4d4d 0%, #ff7a1a 55%, #ff9a33 100%)',
              }
            : undefined
      }
    >
      {children}
    </button>
  )
}

export function ProfilePage({
  profile,
  saveProfile,
  resetProfile,
  onProgramChanged,
}: {
  profile: CometbotProfile
  saveProfile: (next: CometbotProfile | ((p: CometbotProfile) => CometbotProfile)) => void
  resetProfile: () => void
  onProgramChanged?: (nextProgramId: string) => void
}) {
  const [tab, setTab] = useState<TabId>('account')

  const [editing, setEditing] = useState<null | 'fullName' | 'studentId' | 'email'>(null)
  const [draft, setDraft] = useState({ fullName: profile.fullName, studentId: profile.studentId, email: profile.email })
  const [emailError, setEmailError] = useState<string | null>(null)

  const [aboutDraft, setAboutDraft] = useState(profile.background)

  const [courseCatalog, setCourseCatalog] = useState<{ ids: Set<string>; rows: CatalogRow[] } | null>(null)
  const [activeSemesterInput, setActiveSemesterInput] = useState<string | null>(null)
  const [courseHistorySaveMsg, setCourseHistorySaveMsg] = useState<string | null>(null)

  const semesters = useMemo(() => profile.semesters || [], [profile.semesters])
  const totalCourses = useMemo(() => {
    const s = new Set<string>()
    for (const sem of semesters) for (const c of sem.courses) s.add(normalizeCourseId(c))
    s.delete('')
    return s.size
  }, [semesters])

  const loadCourseCatalog = useCallback(async () => {
    if (courseCatalog) return courseCatalog
    try {
      const cat = await fetchCourseCatalog(profile.program_id || 'msba')
      setCourseCatalog(cat)
      return cat
    } catch {
      return null
    }
  }, [courseCatalog, profile.program_id])

  useEffect(() => {
    if (tab !== 'personalization') return
    void loadCourseCatalog()
  }, [tab, loadCourseCatalog])

  useEffect(() => {
    setCourseCatalog(null)
  }, [profile.program_id])

  const handleProgramChange = (newProgramId: string) => {
    const normalized = newProgramId === 'msitm' ? 'msitm' : 'msba'
    if (normalized === profile.program_id) return
    const confirmed = window.confirm(
      'Changing your program will clear your saved course history since courses differ between programs. Continue?',
    )
    if (!confirmed) return
    const selected = PROGRAMS.find((p) => p.program_id === normalized)
    saveProfile((p) => ({
      ...p,
      program_id: normalized,
      program_name: selected?.program_name || '',
      semesters: [],
    }))
    onProgramChanged?.(normalized)
  }

  const updateField = (key: 'fullName' | 'studentId' | 'email', value: string) => {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const saveField = (key: 'fullName' | 'studentId' | 'email') => {
    const value = (draft as any)[key] as string
    if (key === 'email') {
      const v = value.trim()
      const ok = !v || v.toLowerCase().endsWith('@utdallas.edu')
      if (!ok) {
        setEmailError('Must be a UTD email address (@utdallas.edu)')
        return
      }
      setEmailError(null)
    }
    saveProfile((p) => ({ ...p, [key]: value }))
    setEditing(null)
  }

  const upsertSemester = (id: string, patch: (s: ProfileSemester) => ProfileSemester) => {
    saveProfile((p) => ({
      ...p,
      semesters: p.semesters.map((s) => (s.id === id ? patch(s) : s)),
    }))
  }

  const deleteSemester = (id: string) => {
    saveProfile((p) => ({ ...p, semesters: p.semesters.filter((s) => s.id !== id) }))
  }

  const moveSemester = (id: string, dir: -1 | 1) => {
    const idx = semesters.findIndex((s) => s.id === id)
    if (idx < 0) return
    const j = idx + dir
    if (j < 0 || j >= semesters.length) return
    const next = [...semesters]
    const [item] = next.splice(idx, 1)
    next.splice(j, 0, item)
    saveProfile((p) => ({ ...p, semesters: next }))
  }

  const addSemester = () => {
    const last = semesters[semesters.length - 1]
    const label = nextSemesterLabel(last?.label || 'Fall 2024')
    const newSem: ProfileSemester = {
      id: `sem_${Date.now().toString(16)}`,
      label,
      courses: [],
    }
    saveProfile((p) => ({ ...p, semesters: [...p.semesters, newSem] }))
  }

  const saveCourseHistory = () => {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile))
      setCourseHistorySaveMsg('Course history saved on this device.')
      window.setTimeout(() => setCourseHistorySaveMsg(null), 3200)
    } catch {
      setCourseHistorySaveMsg('Could not save. Check that storage is enabled for this site.')
      window.setTimeout(() => setCourseHistorySaveMsg(null), 4000)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full" style={{ backgroundColor: 'var(--surface)', color: 'var(--text)' }}>
      {/* sub-nav */}
      <div className="w-[200px] shrink-0" style={{ borderRight: '1px solid var(--border)', backgroundColor: 'var(--surface)' }}>
        <div className="px-4 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Profile
          </div>
        </div>
        <div className="px-2 pb-4">
          {([
            { id: 'account', label: 'Account' },
            { id: 'personalization', label: 'Personalization' },
          ] as const).map((t) => {
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={[
                  'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors',
                  active ? 'ring-1 ring-orange-200' : '',
                ].join(' ')}
                style={
                  active
                    ? { backgroundColor: 'color-mix(in oklab, var(--accent) 14%, var(--surface) 86%)', color: 'var(--text)' }
                    : { color: 'var(--text-muted)' }
                }
              >
                <User size={16} className={active ? 'text-orange-600' : 'text-slate-500'} />
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {tab === 'account' ? (
            <div>
              <div className="mb-4 text-lg font-extrabold tracking-tight" style={{ color: 'var(--text)' }}>
                Account
              </div>
              <div className="rounded-2xl" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div className="px-5">
                  <Row
                    label="Avatar"
                    action={
                      <div
                        className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-extrabold text-white ring-1 ring-orange-200"
                        style={{
                          background:
                            'linear-gradient(90deg, #ff4d4d 0%, #ff7a1a 55%, #ff9a33 100%)',
                        }}
                      >
                        {initials(profile.fullName)}
                      </div>
                    }
                  >
                    <span style={{ color: 'var(--text-muted)' }}>Your initials</span>
                  </Row>
                </div>
                <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />

                <div className="px-5">
                  <Row
                    label="Full Name"
                    action={
                      editing === 'fullName' ? (
                        <SmallButton variant="solid" onClick={() => saveField('fullName')}>
                          Save
                        </SmallButton>
                      ) : (
                        <SmallButton onClick={() => { setDraft((d) => ({ ...d, fullName: profile.fullName })); setEditing('fullName') }}>
                          Edit
                        </SmallButton>
                      )
                    }
                  >
                    {editing === 'fullName' ? (
                      <input
                        value={draft.fullName}
                        onChange={(e) => updateField('fullName', e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveField('fullName')
                        }}
                        className="h-10 w-full rounded-xl px-3 text-sm outline-none focus:ring-orange-200"
                        style={{ backgroundColor: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                        placeholder="Your full name"
                      />
                    ) : (
                      <div className="text-slate-700">{profile.fullName || <span className="text-slate-400">Not set</span>}</div>
                    )}
                  </Row>
                </div>
                <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />

                <div className="px-5">
                  <Row
                    label="Student ID"
                    action={
                      editing === 'studentId' ? (
                        <SmallButton variant="solid" onClick={() => saveField('studentId')}>
                          Save
                        </SmallButton>
                      ) : (
                        <SmallButton onClick={() => { setDraft((d) => ({ ...d, studentId: profile.studentId })); setEditing('studentId') }}>
                          Edit
                        </SmallButton>
                      )
                    }
                  >
                    {editing === 'studentId' ? (
                      <input
                        value={draft.studentId}
                        onChange={(e) => updateField('studentId', e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveField('studentId')
                        }}
                        className="h-10 w-full rounded-xl px-3 text-sm outline-none focus:ring-orange-200"
                        style={{ backgroundColor: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                        placeholder="Your student ID"
                      />
                    ) : (
                      <div className="text-slate-700">{profile.studentId || <span className="text-slate-400">Not set</span>}</div>
                    )}
                  </Row>
                </div>
                <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />

                <div className="px-5">
                  <Row
                    label="Email"
                    action={
                      editing === 'email' ? (
                        <SmallButton variant="solid" onClick={() => saveField('email')}>
                          Save
                        </SmallButton>
                      ) : (
                        <SmallButton onClick={() => { setDraft((d) => ({ ...d, email: profile.email })); setEditing('email') }}>
                          Edit
                        </SmallButton>
                      )
                    }
                  >
                    {editing === 'email' ? (
                      <div className="space-y-2">
                        <input
                          value={draft.email}
                          onChange={(e) => updateField('email', e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveField('email')
                          }}
                          className="h-10 w-full rounded-xl px-3 text-sm outline-none focus:ring-orange-200"
                          style={{ backgroundColor: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                          placeholder="you@utdallas.edu"
                        />
                        {emailError && <div className="text-xs font-medium text-red-600">{emailError}</div>}
                      </div>
                    ) : (
                      <div className="text-slate-700">{profile.email || <span className="text-slate-400">Not set</span>}</div>
                    )}
                  </Row>
                </div>
                <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />

                <div className="px-5">
                  <Row label="Program">
                    <div className="flex items-center gap-2 text-slate-700">
                      <select
                        value={profile.program_id || 'msba'}
                        onChange={(e) => handleProgramChange(e.target.value)}
                        className="h-10 w-full rounded-xl px-3 text-sm outline-none"
                        style={{ backgroundColor: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                      >
                        {PROGRAMS.map((p) => (
                          <option key={p.program_id} value={p.program_id}>
                            {p.program_name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </Row>
                </div>
                <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />

                <div className="px-5">
                  <Row label="Active Program Name">
                    <div className="flex items-center gap-2 text-slate-700">
                      <span>{profile.program_name}</span>
                    </div>
                  </Row>
                </div>
              </div>

              <div className="mt-6 h-px" style={{ backgroundColor: 'var(--border)' }} />
              <div className="mt-4">
                <SmallButton
                  variant="danger"
                  onClick={() => {
                    resetProfile()
                    setDraft({ fullName: '', studentId: '', email: '' })
                    setAboutDraft('')
                    setEditing(null)
                    setEmailError(null)
                  }}
                >
                  Clear all profile data
                </SmallButton>
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              <div>
                <div className="mb-1 text-lg font-extrabold tracking-tight" style={{ color: 'var(--text)' }}>
                  Personalization
                </div>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  This helps CometBot tailor recommendations to you.
                </div>
              </div>

              {/* About */}
              <div className="rounded-2xl p-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Tell Me About Yourself
                    </div>
                    <div className="mt-2 text-sm font-semibold" style={{ color: 'var(--text)' }}>About you</div>
                  </div>
                </div>
                <textarea
                  value={aboutDraft}
                  onChange={(e) => setAboutDraft(e.target.value.slice(0, 500))}
                  placeholder="Tell CometBot about your background, career goals, and interests. For example: I have a finance background and want to transition into data science. I am interested in machine learning and financial analytics."
                  className="mt-3 min-h-[120px] w-full resize-none rounded-2xl p-3 text-sm outline-none"
                  style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                />
                <div className="mt-2 flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                  <div>{aboutDraft.length} / 500</div>
                </div>
                <div className="mt-3">
                  <SmallButton
                    variant="solid"
                    onClick={() => saveProfile((p) => ({ ...p, background: aboutDraft }))}
                  >
                    Save
                  </SmallButton>
                </div>
                <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  This text will be used by the Career Mentor and Skills Gap Analyzer to personalize responses.
                </div>
              </div>

              {/* Course History */}
              <div className="rounded-2xl p-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Course History
                  </div>
                  <SmallButton variant="solid" onClick={addSemester}>
                    + Add Semester
                  </SmallButton>
                </div>
                <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Only courses from your selected program catalog can be added. Start typing to see suggestions, or enter an exact
                  course ID (for example BUAN 6341).
                </p>
                {courseCatalog && courseCatalog.rows.length > 0 ? (
                  <datalist id={COURSE_DATALIST_ID}>
                    {courseCatalog.rows.map((r) => (
                      <option key={r.course_id} value={r.course_id}>
                        {r.title}
                      </option>
                    ))}
                  </datalist>
                ) : null}

                <div className="mt-4 space-y-3">
                  {semesters.map((sem) => (
                    <SemesterCard
                      key={sem.id}
                      semester={sem}
                      courseDatalistId={courseCatalog && courseCatalog.rows.length > 0 ? COURSE_DATALIST_ID : undefined}
                      activeSemesterInput={activeSemesterInput}
                      setActiveSemesterInput={setActiveSemesterInput}
                      canMoveUp={semesters[0]?.id !== sem.id}
                      canMoveDown={semesters[semesters.length - 1]?.id !== sem.id}
                      onMoveUp={() => moveSemester(sem.id, -1)}
                      onMoveDown={() => moveSemester(sem.id, 1)}
                      onDelete={() => deleteSemester(sem.id)}
                      onRename={(label) => upsertSemester(sem.id, (s) => ({ ...s, label }))}
                      onRemoveCourse={(courseId) =>
                        upsertSemester(sem.id, (s) => ({
                          ...s,
                          courses: s.courses.filter((c) => normalizeCourseId(c) !== normalizeCourseId(courseId)),
                        }))
                      }
                      onAddCourse={async (courseId) => {
                        const cid = normalizeCourseId(courseId)
                        if (!cid) return { ok: false, message: 'Please enter a course ID.' }

                        const catalog = await loadCourseCatalog()
                        if (!catalog) {
                          return {
                            ok: false,
                            message:
                              'Course catalog is temporarily unavailable. You can still enter a valid course ID manually.',
                          }
                        }
                        if (!catalog.ids.has(cid)) {
                          return { ok: false, message: 'Please enter a valid course ID.' }
                        }

                        upsertSemester(sem.id, (s) => ({
                          ...s,
                          courses: Array.from(new Set([...s.courses.map(normalizeCourseId), cid])),
                        }))
                        return { ok: true, message: null }
                      }}
                    />
                  ))}

                  {semesters.length === 0 && (
                    <div className="rounded-2xl p-4 text-sm" style={{ backgroundColor: 'var(--surface2)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
                      No semesters added yet. Click <span className="font-semibold">+ Add Semester</span> to start tracking your course history.
                    </div>
                  )}
                </div>

                <div className="mt-5 pt-4 text-sm" style={{ borderTop: '1px solid var(--border)', color: 'var(--text)' }}>
                  {totalCourses === 0 ? (
                    <span>
                      No courses added yet. <span style={{ color: 'var(--text-muted)' }}>CometBot will treat you as a new student.</span>
                    </span>
                  ) : (
                    <span>
                      Total courses completed:{' '}
                      <span className="font-extrabold text-orange-600">{totalCourses}</span>{' '}
                      across <span className="font-semibold">{semesters.length}</span> semester(s)
                    </span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <SmallButton variant="solid" onClick={saveCourseHistory}>
                    Save course history
                  </SmallButton>
                  {courseHistorySaveMsg ? (
                    <span className="text-xs font-medium" style={{ color: 'var(--success)' }}>
                      {courseHistorySaveMsg}
                    </span>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Saves semesters and courses to this browser (same as auto-save).
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SemesterCard({
  semester,
  onDelete,
  onRename,
  onRemoveCourse,
  onAddCourse,
  courseDatalistId,
  activeSemesterInput,
  setActiveSemesterInput,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  semester: ProfileSemester
  onDelete: () => void
  onRename: (label: string) => void
  onRemoveCourse: (courseId: string) => void
  onAddCourse: (courseId: string) => Promise<{ ok: boolean; message: string | null }>
  courseDatalistId?: string
  activeSemesterInput: string | null
  setActiveSemesterInput: (id: string | null) => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(semester.label)

  useEffect(() => {
    setTitleDraft(semester.label)
  }, [semester.label])

  const [courseDraft, setCourseDraft] = useState('')
  const [courseError, setCourseError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [oneAtATimeHint, setOneAtATimeHint] = useState(false)

  const adding = activeSemesterInput === semester.id

  const saveTitle = () => {
    const v = (titleDraft || '').trim()
    if (!v) return
    onRename(v)
    setEditingTitle(false)
  }

  const tryAdd = async () => {
    setCourseError(null)
    setNote(null)
    const res = await onAddCourse(courseDraft)
    if (!res.ok) {
      setCourseError(res.message)
      return
    }
    setNote(res.message)
    setCourseDraft('')
    setActiveSemesterInput(null)
    setOneAtATimeHint(false)
  }

  return (
    <div
      className="rounded-2xl p-4"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Semester label
          </div>
          {editingTitle ? (
            <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveTitle()
                  if (e.key === 'Escape') {
                    setTitleDraft(semester.label)
                    setEditingTitle(false)
                  }
                }}
                placeholder="e.g. Spring 2026"
                className="h-10 min-w-0 flex-1 rounded-xl px-3 text-sm font-semibold outline-none focus:ring-orange-200"
                style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                autoFocus
              />
              <div className="flex shrink-0 gap-2">
                <SmallButton variant="solid" onClick={saveTitle}>
                  Save
                </SmallButton>
                <SmallButton
                  onClick={() => {
                    setTitleDraft(semester.label)
                    setEditingTitle(false)
                  }}
                >
                  Cancel
                </SmallButton>
              </div>
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-sm font-extrabold tracking-tight" style={{ color: 'var(--text)' }}>
                {semester.label}
              </span>
              <SmallButton
                onClick={() => {
                  setTitleDraft(semester.label)
                  setEditingTitle(true)
                }}
              >
                Change term
              </SmallButton>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Use format: Spring 2026, Fall 2025, etc.
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl disabled:opacity-40"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            title="Move up"
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl disabled:opacity-40"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            title="Move down"
          >
            <ChevronDown size={16} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            title="Delete semester"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {(semester.courses || []).map((c) => {
          const cid = normalizeCourseId(c)
          return (
            <div
              key={cid}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs"
              style={{ backgroundColor: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)' }}
            >
              <span className="font-normal">{cid}</span>
              <button
                type="button"
                onClick={() => onRemoveCourse(cid)}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                style={{ color: 'var(--text-muted)' }}
                title="Remove course"
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
        {(semester.courses || []).length === 0 && (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No courses added yet.</div>
        )}
      </div>

      <div className="mt-3">
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setActiveSemesterInput(semester.id)
              setCourseError(null)
              setNote(null)
              setCourseDraft('')
              setOneAtATimeHint(false)
            }}
            className="inline-flex items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
          >
            + Add Course
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={courseDraft}
                list={courseDatalistId}
                onChange={(e) => {
                  const v = e.target.value
                  const commaAt = v.indexOf(',')
                  if (commaAt >= 0) {
                    setCourseDraft(v.slice(0, commaAt))
                    setOneAtATimeHint(true)
                  } else {
                    setCourseDraft(v)
                    setOneAtATimeHint(false)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void tryAdd()
                  }
                }}
                placeholder="Type to search or enter course ID (e.g. BUAN 6341)"
                className="h-10 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none focus:ring-orange-200"
                style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                autoFocus
              />
              <button
                type="button"
                onClick={() => void tryAdd()}
                className="inline-flex h-10 items-center justify-center rounded-xl px-3 text-xs font-semibold text-white"
                style={{
                  background:
                    'linear-gradient(90deg, #ff4d4d 0%, #ff7a1a 55%, #ff9a33 100%)',
                }}
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveSemesterInput(null)
                  setCourseDraft('')
                  setCourseError(null)
                  setNote(null)
                  setOneAtATimeHint(false)
                }}
                className="inline-flex h-10 items-center justify-center rounded-xl px-3 text-xs font-semibold"
                style={{ backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
              >
                Cancel
              </button>
            </div>
            {oneAtATimeHint && (
              <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Add one course at a time</div>
            )}
            {courseError && <div className="text-xs font-medium text-red-600">{courseError}</div>}
            {note && <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{note}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

