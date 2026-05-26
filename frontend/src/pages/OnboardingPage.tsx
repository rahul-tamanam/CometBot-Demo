import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, Pencil, Save, Trash2, Upload } from 'lucide-react'
import { CustomSelect } from '@/components/ui/custom-select'
import { AnimatedText } from '@/components/ui/animated-shiny-text'
import useFileUpload from '@/hooks/useFileUpload'
import { useProfile, type ProfileSemester } from '@/hooks/useProfile'
import { mapTranscriptApiToParseResult, type TranscriptApiData } from '@/lib/mapTranscriptApi'
import { parseTranscript, type ParsedProgram, type ParseTranscriptResult } from '@/lib/parseTranscript'
import { DemoDisclaimer } from '@/components/DemoDisclaimer'
import { API_BASE } from '@/api'
import { transcriptNetworkFallback } from '@/lib/demoMessages'

const ONBOARDING_COMPLETE_KEY = 'cometbot_onboarding_complete'

const ONBOARDING_BG = '#FAF7F2'

const API_ROOT = API_BASE

function normalizeCourseCode(c: string) {
  return (c || '').trim().toUpperCase().replace(/\s+/g, ' ')
}

/** Course code + title for read-only rows (catalog / transcript titles). */
function courseRowDisplayParts(
  norm: string,
  courseTitles: Record<string, string>,
  courseOptions: { id: string; label: string }[],
): { code: string; title: string } {
  const code = norm.trim() || '—'
  const fromMap = courseTitles[norm]?.trim()
  if (fromMap) return { code, title: fromMap }
  const opt = courseOptions.find((o) => o.id === norm)
  if (opt) {
    const sep = ' — '
    const i = opt.label.indexOf(sep)
    const title = i >= 0 ? opt.label.slice(i + sep.length).trim() : opt.label.trim()
    return { code, title }
  }
  return { code, title: '' }
}

type Step =
  | 'landing'
  | 'program'
  | 'upload'
  | 'confirm-programs'
  | 'confirm-classes'

type StudentType = 'new' | 'current'

type ProgramId = 'msba' | 'msitm'

const PROGRAM_OPTIONS: {
  id: ProgramId
  name: string
  description: string
}[] = [
  {
    id: 'msba',
    name: 'MS in Business Analytics & AI',
    description: 'Analytics, ML, and business intelligence focus.',
  },
  {
    id: 'msitm',
    name: 'MS in Information Technology & Management',
    description: 'IT leadership, systems, and digital strategy.',
  },
]

function programNameFor(id: ProgramId) {
  return id === 'msitm'
    ? 'MS in Information Technology and Management'
    : 'MS in Business Analytics and Artificial Intelligence'
}

type ProgramRow = ParsedProgram & { status: 'In Progress' | 'Completed' | 'Not Mine' }

function markOnboardingComplete() {
  try {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true')
  } catch {
    // ignore
  }
}

function cloneSemesters(s: ProfileSemester[]): ProfileSemester[] {
  return s.map((sem) => ({
    id: sem.id,
    label: sem.label,
    courses: [...sem.courses],
  }))
}

const TRANSCRIPT_API = (import.meta.env.VITE_TRANSCRIPTPARSER_API ?? '').trim()
/** Default: client pdf.js parser (matches local dev). Set true only to force Render/pdfplumber. */
const PREFER_SERVER_TRANSCRIPT =
  (import.meta.env.VITE_TRANSCRIPTPARSER_PREFER_SERVER ?? '').trim() === 'true'

/** Quadratic bezier ~ M 8vw 85vh Q 25vw 20vh 58vw 32vh at ~1280×800 reference */
const COMET_PATH_D = 'M 120 680 Q 380 160 870 290'

const COMET_P0 = [120, 680] as const
const COMET_P1 = [380, 160] as const
const COMET_P2 = [870, 290] as const

function quadBezierPoint(t: number): readonly [number, number] {
  const u = 1 - t
  const x = u * u * COMET_P0[0] + 2 * u * t * COMET_P1[0] + t * t * COMET_P2[0]
  const y = u * u * COMET_P0[1] + 2 * u * t * COMET_P1[1] + t * t * COMET_P2[1]
  return [x, y]
}

const COMET_FRAME_N = 48
const COMET_TIMES = Array.from({ length: COMET_FRAME_N + 1 }, (_, i) => i / COMET_FRAME_N)
const COMET_CX = COMET_TIMES.map((t) => quadBezierPoint(t)[0])
const COMET_CY = COMET_TIMES.map((t) => quadBezierPoint(t)[1])
/** Fade in early, hold, fade out — aligned to path progress */
const COMET_HEAD_OPACITY = COMET_TIMES.map((t) => {
  if (t < 0.06) return t / 0.06
  if (t > 0.78) return Math.max(0, 1 - (t - 0.78) / 0.22)
  return 1
})
const COMET_HALO_OPACITY = COMET_TIMES.map((t) => {
  if (t < 0.06) return (t / 0.06) * 0.6
  if (t > 0.78) return Math.max(0, 0.6 * (1 - (t - 0.78) / 0.22))
  return 0.6
})

function CometAnimation() {
  return (
    <svg
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 5,
        overflow: 'visible',
      }}
      aria-hidden
    >
      <defs>
        <linearGradient id="cometTail" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#FE6507" stopOpacity={0} />
          <stop offset="60%" stopColor="#FE6507" stopOpacity={0.15} />
          <stop offset="100%" stopColor="#FE6507" stopOpacity={0.7} />
        </linearGradient>
        <filter id="cometGlow">
          <feGaussianBlur stdDeviation="4" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <motion.path
        d={COMET_PATH_D}
        stroke="url(#cometTail)"
        strokeWidth={18}
        fill="none"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: [0, 1, 1, 0] }}
        transition={{
          pathLength: { duration: 1.2, ease: 'easeInOut' },
          opacity: {
            duration: 1.4,
            times: [0, 0.1, 0.7, 1],
            ease: 'easeInOut',
          },
        }}
      />

      <motion.path
        d={COMET_PATH_D}
        stroke="#FE6507"
        strokeWidth={3}
        fill="none"
        strokeLinecap="round"
        opacity={0.4}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: 'easeInOut' }}
      />

      <motion.circle
        r={8}
        fill="#FE6507"
        filter="url(#cometGlow)"
        initial={{ cx: COMET_CX[0], cy: COMET_CY[0], opacity: COMET_HEAD_OPACITY[0] }}
        animate={{ cx: COMET_CX, cy: COMET_CY, opacity: COMET_HEAD_OPACITY }}
        transition={{
          duration: 1.2,
          ease: 'easeInOut',
          times: COMET_TIMES,
        }}
      />

      <motion.circle
        r={16}
        fill="rgba(254,101,7,0.2)"
        initial={{ cx: COMET_CX[0], cy: COMET_CY[0], opacity: COMET_HALO_OPACITY[0] }}
        animate={{ cx: COMET_CX, cy: COMET_CY, opacity: COMET_HALO_OPACITY }}
        transition={{
          duration: 1.2,
          ease: 'easeInOut',
          times: COMET_TIMES,
        }}
      />
    </svg>
  )
}

export default function OnboardingPage() {
  const navigate = useNavigate()
  const { saveProfile, profile } = useProfile()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { selectedFile, isUploading, handleFileChange, uploadFile, selectFile } =
    useFileUpload(TRANSCRIPT_API)

  const [step, setStep] = useState<Step>('landing')
  const [studentType, setStudentType] = useState<StudentType | null>(null)
  const [programId, setProgramId] = useState<ProgramId | null>(null)
  const [parsing, setParsing] = useState(false)
  const [parsed, setParsed] = useState<ParseTranscriptResult | null>(null)
  const [programRows, setProgramRows] = useState<ProgramRow[]>([])
  const [semestersDraft, setSemestersDraft] = useState<ProfileSemester[]>([])
  const [courseOptions, setCourseOptions] = useState<{ id: string; label: string }[]>([])
  const [coursesLoading, setCoursesLoading] = useState(false)

  const catalogProgramId = programId ?? profile.program_id ?? 'msba'

  useEffect(() => {
    if (step !== 'confirm-classes') return
    let cancelled = false
    setCoursesLoading(true)
    fetch(`${API_ROOT}/courses?program_id=${encodeURIComponent(catalogProgramId)}`)
      .then((res) => res.json())
      .then((data: { course_id?: string; title?: string }[]) => {
        if (cancelled || !Array.isArray(data)) return
        const opts = data
          .map((c) => {
            const id = normalizeCourseCode(String(c.course_id ?? ''))
            if (!id) return null
            const title = String(c.title ?? '').trim()
            return {
              id,
              label: `${id} — ${title}`,
            }
          })
          .filter((x): x is { id: string; label: string } => x !== null)
          .sort((a, b) => a.id.localeCompare(b.id))
        setCourseOptions(opts)
      })
      .catch(() => {
        if (!cancelled) setCourseOptions([])
      })
      .finally(() => {
        if (!cancelled) setCoursesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [step, catalogProgramId])

  const goDashboard = useCallback(() => {
    markOnboardingComplete()
    navigate('/chat', { replace: true })
  }, [navigate])

  const startProgramRows = useCallback((data: TranscriptApiData | ParseTranscriptResult) => {
    // API `/parse-transcript` shape: separate majors / certifications / minors
    if (
      typeof data === 'object' &&
      data !== null &&
      ('majors' in data || 'certifications' in data || 'minors' in data)
    ) {
      const d = data as TranscriptApiData
      const rows: ProgramRow[] = [
        ...(d.majors ?? []).map((m) => ({
          id: `${m.name}-${m.start_date ?? ''}`,
          name: m.name,
          type: 'Master',
          status: 'In Progress' as const,
        })),
        ...(d.certifications ?? []).map((c) => ({
          id: `${c.name}-${c.start_date ?? ''}`,
          name: `Graduate Certificate in ${c.name}`,
          type: 'Graduate Certificate',
          status: 'In Progress' as const,
        })),
        ...(d.minors ?? []).map((m) => ({
          id: `${m.name}-${m.start_date ?? ''}`,
          name: m.name,
          type: 'Minor',
          status: 'In Progress' as const,
        })),
      ]
      setProgramRows(
        rows.length > 0
          ? rows
          : [
              {
                id: `synthetic-${Date.now()}`,
                name: 'Program not detected — add manually',
                type: 'Master',
                status: 'In Progress' as const,
              },
            ],
      )
      return
    }

    const pr = data as ParseTranscriptResult
    const rows: ProgramRow[] =
      pr.programs.length > 0
        ? pr.programs.map((p) => ({ ...p, status: 'In Progress' as const }))
        : [
            {
              id: `synthetic-${Date.now()}`,
              name: 'Program not detected — add manually',
              type: 'Master',
              status: 'In Progress' as const,
            },
          ]
    setProgramRows(rows)
  }, [])

  /** New students only — program step → dashboard with chosen MSBA/MSITM. */
  const handleNewStudentContinue = () => {
    if (!programId) return
    saveProfile((prev) => ({
      ...prev,
      program_id: programId,
      program_name: programNameFor(programId),
      semesters: [],
    }))
    goDashboard()
  }

  const handleFilePick = () => fileInputRef.current?.click()

  const applyTranscriptResult = useCallback(
    (result: ParseTranscriptResult) => {
      setParsed(result)
      startProgramRows(result)
      if (studentType === 'current') {
        const master = result.programs.find(
          (p) => p.type === 'Master' || p.type === 'Program',
        )
        const primary = master ?? result.programs[0]
        if (primary?.name) {
          saveProfile((prev) => ({
            ...prev,
            program_name: primary.name,
            semesters: prev.semesters,
          }))
        }
      }
    },
    [saveProfile, startProgramRows, studentType],
  )

  const handleUploadSubmit = async () => {
    if (!selectedFile) return
    setParsing(true)
    try {
      const buf = await selectedFile.arrayBuffer()

      // Same parser as local dev when VITE_TRANSCRIPTPARSER_API is unset.
      const clientResult = await parseTranscript(buf)

      if (PREFER_SERVER_TRANSCRIPT && TRANSCRIPT_API) {
        try {
          const response = (await uploadFile('user-123', null)) as {
            message?: string
            transcript_data?: TranscriptApiData
          }
          if (
            response?.message === 'Transcript processed successfully' &&
            response.transcript_data
          ) {
            const apiResult = mapTranscriptApiToParseResult(response.transcript_data)
            const hasApiCourses = apiResult.semesters.some((s) => s.courses.length > 0)
            const hasClientCourses = clientResult.semesters.some((s) => s.courses.length > 0)
            if (hasApiCourses && apiResult.semesters.length >= clientResult.semesters.length) {
              setParsed(apiResult)
              startProgramRows(response.transcript_data)
              const primaryMajor = response.transcript_data.majors?.[0]
              if (studentType === 'current' && primaryMajor?.name) {
                saveProfile((prev) => ({
                  ...prev,
                  program_name: primaryMajor.name,
                  semesters: prev.semesters,
                }))
              }
              setStep('confirm-programs')
              return
            }
            if (!hasClientCourses && !hasApiCourses) {
              throw new Error('No courses detected on transcript.')
            }
          }
        } catch (err) {
          console.warn('Server transcript parse unavailable, using client parser.', err)
        }
      }

      applyTranscriptResult(clientResult)
      setStep('confirm-programs')
    } catch {
      alert(transcriptNetworkFallback)
    } finally {
      setParsing(false)
    }
  }

  const handleConfirmProgramsNext = () => {
    if (!parsed) return
    setSemestersDraft(cloneSemesters(parsed.semesters))
    setStep('confirm-classes')
  }

  const handleClassesDone = () => {
    if (studentType === 'new') {
      if (!programId) return
      saveProfile((prev) => ({
        ...prev,
        program_id: programId,
        program_name: programNameFor(programId),
        semesters: cloneSemesters(semestersDraft),
      }))
    } else {
      const primaryMajor = parsed?.programs?.find((p) => p.type === 'Master')
      saveProfile((prev) => ({
        ...prev,
        program_name: primaryMajor?.name ?? prev.program_name,
        semesters: cloneSemesters(semestersDraft),
      }))
    }
    goDashboard()
  }

  const updateCourseCode = (semId: string, courseIndex: number, code: string) => {
    setSemestersDraft((rows) =>
      rows.map((r) => {
        if (r.id !== semId) return r
        const courses = [...r.courses]
        courses[courseIndex] = normalizeCourseCode(code)
        return { ...r, courses }
      }),
    )
  }

  const removeCourseAt = (semId: string, courseIndex: number) => {
    setSemestersDraft((rows) =>
      rows.map((r) => {
        if (r.id !== semId) return r
        return { ...r, courses: r.courses.filter((_, i) => i !== courseIndex) }
      }),
    )
  }

  const addCourseToSemester = (semId: string) => {
    const first = courseOptions[0]?.id ?? ''
    setSemestersDraft((rows) =>
      rows.map((r) => (r.id === semId ? { ...r, courses: [...r.courses, first] } : r)),
    )
  }

  const [openCustomSelectKey, setOpenCustomSelectKey] = useState<string | null>(null)
  /** Semester card showing dropdowns + trash (matches reference); null = summary rows + Edit. */
  const [editingCoursesSemId, setEditingCoursesSemId] = useState<string | null>(null)

  const addProgramRow = () => {
    setProgramRows((r) => [
      ...r,
      {
        id: `manual-${Date.now()}`,
        name: '',
        type: 'Master',
        status: 'In Progress',
      },
    ])
  }

  const updateProgramRow = (id: string, patch: Partial<ProgramRow>) => {
    setProgramRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const courseTitles = parsed?.courseTitles ?? {}

  const panelCardClass =
    'w-full max-w-xl rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-8 shadow-2xl'

  const widePanelClass =
    'relative w-full max-w-2xl rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-8 shadow-2xl'

  return (
    <div
      className="relative min-h-screen w-full overflow-hidden text-[color:var(--text)]"
      style={{ backgroundColor: ONBOARDING_BG }}
    >
      {step === 'landing' && <CometAnimation />}

      <div className="relative z-10 flex min-h-screen flex-col">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            className="flex min-h-screen w-full flex-1 flex-col"
          >
        {step === 'landing' && (
          <div
            className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-16"
            style={{ background: '#FAF7F2' }}
          >
            <div
              style={{
                position: 'absolute',
                bottom: '-80px',
                left: '-60px',
                width: '420px',
                height: '380px',
                background:
                  'radial-gradient(ellipse, rgba(255,180,120,0.45) 0%, rgba(255,160,100,0.15) 50%, transparent 70%)',
                borderRadius: '60% 40% 70% 30% / 50% 60% 40% 50%',
                filter: 'blur(40px)',
                zIndex: 0,
                pointerEvents: 'none',
              }}
              aria-hidden
            />
            {[
              { top: '15%', right: '8%', size: 12, opacity: 0.4 },
              { top: '25%', right: '12%', size: 8, opacity: 0.3 },
              { top: '10%', right: '18%', size: 18, opacity: 0.25 },
            ].map((dot, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  top: dot.top,
                  right: dot.right,
                  width: dot.size,
                  height: dot.size,
                  background: '#A8C5A0',
                  borderRadius: '50%',
                  opacity: dot.opacity,
                  zIndex: 0,
                  pointerEvents: 'none',
                }}
                aria-hidden
              />
            ))}
            {[
              { top: '30%', left: '15%' },
              { top: '20%', right: '30%' },
              { bottom: '35%', right: '20%' },
            ].map((pos, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  ...pos,
                  color: '#E8C84A',
                  fontSize: '20px',
                  opacity: 0.65,
                  zIndex: 0,
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
                aria-hidden
              >
                ✦
              </div>
            ))}
            <div className="relative z-10 flex w-full max-w-6xl flex-col items-center px-4 text-center sm:px-8">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.04, duration: 0.45 }}
                className="w-full max-w-[56rem] text-center font-extrabold leading-[1.12] text-[#1a1a1a]"
                style={{ fontSize: 'clamp(2.75rem, 9vw, 4.75rem)' }}
              >
                <div className="flex flex-wrap items-baseline justify-center gap-x-2">
                  <span>Meet </span>
                  <AnimatedText
                    as="span"
                    text="CometBot"
                    gradientColors="linear-gradient(90deg, #ffd3a1 0%, #e87500 35%, #f5b56d 60%, #159647 100%)"
                    gradientAnimationDuration={2.2}
                    textClassName="font-extrabold tracking-tight"
                    className="py-0"
                  />
                </div>
                <div className="mt-1 block w-full">your smartest academic move.</div>
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12, duration: 0.45 }}
                className="mx-auto mb-4 mt-3 max-w-2xl text-pretty text-base leading-[1.6] text-[#777] sm:text-lg"
              >
                Personalized course recommendations, degree tracking, and career guidance—portfolio demo.
              </motion.p>
              <div className="mx-auto mb-9 w-full max-w-xl px-2">
                <DemoDisclaimer variant="compact" />
              </div>
              <div className="mx-auto grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2 sm:items-stretch sm:gap-3">
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.03, y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="group box-border flex min-h-[4.25rem] w-full cursor-pointer flex-col items-center justify-center rounded-full border-2 border-[#FE6507] bg-transparent px-4 py-2.5 text-center transition-all duration-200 ease-out hover:border-[#FE6507] hover:bg-[#FE6507] hover:shadow-[0_4px_14px_rgba(254,101,7,0.35)] sm:min-h-[4.35rem] sm:px-5"
                  onClick={() => {
                    setStudentType('new')
                    setStep('program')
                  }}
                >
                  <div className="text-sm font-bold leading-tight text-neutral-900 transition-colors group-hover:text-white">
                    Prospective Student
                  </div>
                  <div className="mt-0.5 text-[0.65rem] font-medium leading-snug text-neutral-600 transition-colors group-hover:text-white/85">
                    Just starting at UTD
                  </div>
                </motion.button>
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.03, y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="box-border flex min-h-[4.25rem] w-full cursor-pointer flex-col items-center justify-center rounded-full border-2 border-[#FE6507] bg-[#FE6507] px-4 py-2.5 text-center shadow-[0_2px_8px_rgba(254,101,7,0.3)] transition-all duration-200 ease-out hover:bg-[#e85a06] hover:shadow-[0_4px_16px_rgba(254,101,7,0.4)] sm:min-h-[4.35rem] sm:px-5"
                  onClick={() => {
                    setStudentType('current')
                    setStep('upload')
                  }}
                >
                  <div className="text-sm font-bold leading-tight text-white">
                    Current Student
                  </div>
                  <div className="mt-0.5 text-[0.65rem] font-medium leading-snug text-white/80">
                    Upload your transcript
                  </div>
                </motion.button>
              </div>
            </div>
          </div>
        )}

        {step === 'program' && (
          <div className="flex w-full flex-1 flex-col items-center justify-center px-4 py-8">
            <h2 className="text-center text-2xl font-bold tracking-tight text-[color:var(--text)] sm:text-3xl">
              What are you studying?
            </h2>
            <div className="mt-10 grid w-full max-w-3xl gap-4 sm:grid-cols-2">
              {PROGRAM_OPTIONS.map((opt) => {
                const selected = programId === opt.id
                return (
                  <motion.button
                    key={opt.id}
                    type="button"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setProgramId(opt.id)}
                    className={`rounded-2xl border-2 p-6 text-left transition-all ${
                      selected
                        ? 'border-[#0f6b44] bg-[color-mix(in_oklab,#0f6b44_18%,var(--surface)_82%)] ring-2 ring-[#0f6b44]/40'
                        : 'border-[color:var(--border)] bg-[color:var(--surface)] hover:border-[#13724f]/50'
                    }`}
                  >
                    <div className="font-bold text-[color:var(--text)]">{opt.name}</div>
                    <p className="mt-2 text-sm text-[color:var(--text-muted)]">{opt.description}</p>
                  </motion.button>
                )
              })}
            </div>
            <motion.button
              type="button"
              disabled={!programId}
              whileHover={programId ? { scale: 1.03 } : {}}
              whileTap={programId ? { scale: 0.97 } : {}}
              className="mt-10 rounded-full bg-[#0f6b44] px-8 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#13724f] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={handleNewStudentContinue}
            >
              Continue →
            </motion.button>
          </div>
        )}

        {step === 'upload' && (
          <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
            <div className={panelCardClass}>
              <h2 className="text-2xl font-bold text-[color:var(--text)]">Let&apos;s get started!</h2>
              <p className="mt-2 font-medium text-[color:var(--text)]">Upload your unofficial transcript</p>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--text-muted)]">
                This will allow us to automatically fill in your past classes. The file is likely named
                SSR_TSRPT.pdf
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                type="button"
                onClick={handleFilePick}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const f = e.dataTransfer.files?.[0]
                  if (f && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))) {
                    selectFile(f)
                  }
                }}
                className="mt-8 flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[color:var(--border)] bg-[color-mix(in_oklab,var(--surface)_92%,#0f6b44_8%)] py-12 transition-colors hover:border-[#0f6b44]"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#0f6b44] text-white">
                  <Upload className="h-7 w-7" aria-hidden />
                </span>
                <span className="mt-4 text-sm font-medium text-[color:var(--text)]">
                  Click here to upload or drag and drop
                </span>
                {selectedFile && (
                  <span className="mt-2 text-xs text-[color:var(--text-muted)]">{selectedFile.name}</span>
                )}
              </button>
              <div className="mt-6 flex justify-end">
                <motion.button
                  type="button"
                  disabled={!selectedFile || parsing || isUploading}
                  whileHover={selectedFile && !parsing && !isUploading ? { scale: 1.03 } : {}}
                  whileTap={selectedFile && !parsing && !isUploading ? { scale: 0.97 } : {}}
                  className="inline-flex items-center gap-2 rounded-full bg-[#0f6b44] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#13724f] disabled:opacity-40"
                  onClick={() => void handleUploadSubmit()}
                >
                  {(parsing || isUploading) && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Upload
                </motion.button>
              </div>
            </div>
          </div>
        )}

        {step === 'confirm-programs' && (
          <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
            <div className={panelCardClass}>
              <h2 className="text-2xl font-bold text-[color:var(--text)]">Are these programs right?</h2>
              <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                We detected these programs on your transcript — let us know which ones you&apos;re still working
                on.
              </p>
              <ul className="mt-6 space-y-3">
                {programRows.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-2 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface2)] p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      {!row.name.trim() ? (
                        <input
                          value={row.name}
                          onChange={(e) => updateProgramRow(row.id, { name: e.target.value })}
                          placeholder="Program name"
                          className="w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-sm font-bold text-[color:var(--text)]"
                        />
                      ) : (
                        <div className="font-bold text-[color:var(--text)]">{row.name}</div>
                      )}
                      <div className="text-xs text-[color:var(--text-muted)]">{row.type}</div>
                    </div>
                    <div className="relative shrink-0 self-start sm:self-center">
                      <CustomSelect
                        instanceKey={`status-${row.id}`}
                        openInstanceKey={openCustomSelectKey}
                        setOpenInstanceKey={setOpenCustomSelectKey}
                        value={row.status}
                        onChange={(v) =>
                          updateProgramRow(row.id, {
                            status: v as ProgramRow['status'],
                          })
                        }
                        options={[
                          { value: 'In Progress', label: 'In Progress' },
                          { value: 'Completed', label: 'Completed' },
                          { value: 'Not Mine', label: 'Not Mine' },
                        ]}
                        variant="status"
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={addProgramRow}
                className="mt-4 rounded-full border border-[#ff7a1a] px-4 py-1.5 text-xs font-semibold text-[#ff7a1a] hover:bg-[#ff7a1a]/10"
              >
                + Add program
              </button>
              <div className="mt-8 flex justify-end">
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  className="rounded-full bg-[#0f6b44] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#13724f]"
                  onClick={handleConfirmProgramsNext}
                >
                  Next →
                </motion.button>
              </div>
            </div>
          </div>
        )}

        {step === 'confirm-classes' && (
          <div className="flex min-h-0 flex-1 flex-col items-center px-4 py-10">
            <div
              className={`${widePanelClass} flex min-h-0 w-full max-w-2xl max-h-[min(92vh,900px)] flex-col overflow-hidden bg-white shadow-[0_2px_16px_rgba(0,0,0,0.06)]`}
            >
              <h2 className="shrink-0 text-2xl font-bold text-[color:var(--text)]">
                Are these classes right?
              </h2>
              <p className="mt-2 shrink-0 text-sm text-[color:var(--text-muted)]">
                We detected these classes on your transcript — do these look right?
              </p>
              {coursesLoading && (
                <p className="mt-2 shrink-0 text-xs text-[color:var(--text-muted)]">Loading course catalog…</p>
              )}
              <div className="relative mt-6 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                <div className="space-y-8 pb-4">
                  {semestersDraft.map((sem) => {
                    const isEditingCourses = editingCoursesSemId === sem.id
                    return (
                      <motion.div
                        key={sem.id}
                        layout
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        className="rounded-xl border border-[#e5e7eb] bg-white p-5 sm:p-6"
                      >
                        <div className="flex items-start justify-between gap-3 border-b border-[#e5e7eb] pb-3">
                          <h3 className="text-base font-bold text-[#1a1a1a]">{sem.label}</h3>
                          {isEditingCourses ? (
                            <button
                              type="button"
                              className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
                              onClick={() => {
                                setOpenCustomSelectKey(null)
                                setEditingCoursesSemId(null)
                              }}
                            >
                              <Save className="h-4 w-4" strokeWidth={2} aria-hidden />
                              Save
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-[#2563eb] underline decoration-[#2563eb] underline-offset-4 transition-colors hover:text-[#1d4ed8]"
                              onClick={() => {
                                setOpenCustomSelectKey(null)
                                setEditingCoursesSemId(sem.id)
                              }}
                            >
                              <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden />
                              Edit
                            </button>
                          )}
                        </div>

                        {!isEditingCourses ? (
                          <ul className="mt-4 space-y-2.5">
                            {sem.courses.length === 0 ? (
                              <li className="text-sm text-[color:var(--text-muted)]">
                                No courses in this term. Click Edit to add some.
                              </li>
                            ) : (
                              sem.courses.map((code, idx) => {
                                const norm = normalizeCourseCode(code)
                                const { code: displayCode, title } = courseRowDisplayParts(
                                  norm,
                                  courseTitles,
                                  courseOptions,
                                )
                                const titleUpper = (title || '—').toUpperCase()
                                return (
                                  <li
                                    key={`${sem.id}-view-${idx}`}
                                    className="grid grid-cols-[minmax(5.5rem,auto)_1fr] items-baseline gap-x-6 gap-y-0.5 text-sm sm:grid-cols-[7.5rem_1fr]"
                                  >
                                    <span className="font-medium text-[#1a1a1a]">{displayCode}</span>
                                    <span className="text-[0.8125rem] font-normal uppercase leading-snug tracking-wide text-[#374151]">
                                      {titleUpper}
                                    </span>
                                  </li>
                                )
                              })
                            )}
                          </ul>
                        ) : (
                          <>
                            <p className="mt-3 text-xs text-[color:var(--text-muted)]">
                              Pick a course from each dropdown. Use the trash icon to remove a row.
                            </p>
                            <ul className="mt-3 space-y-3">
                              {sem.courses.map((code, idx) => {
                                const norm = normalizeCourseCode(code)
                                const inCatalog = courseOptions.some((o) => o.id === norm)
                                const rowKey = `${sem.id}-${idx}`
                                const selectDomId = `course-pick-${sem.id}-${idx}`
                                return (
                                  <li key={rowKey} className="flex items-center gap-2 sm:gap-3">
                                    <div className="relative min-w-0 flex-1">
                                      {courseOptions.length > 0 ? (
                                        <CustomSelect
                                          instanceKey={`course-${sem.id}-${idx}`}
                                          openInstanceKey={openCustomSelectKey}
                                          setOpenInstanceKey={setOpenCustomSelectKey}
                                          id={selectDomId}
                                          value={norm}
                                          onChange={(v) => updateCourseCode(sem.id, idx, v)}
                                          placeholder="Select a course…"
                                          variant="course"
                                          options={[
                                            ...(norm === ''
                                              ? ([{ value: '', label: 'Select a course…' }] as const)
                                              : []),
                                            ...(!inCatalog && norm
                                              ? ([
                                                  {
                                                    value: norm,
                                                    label: `${norm} — ${courseTitles[norm] || 'NOT IN CATALOG'}`,
                                                  },
                                                ] as const)
                                              : []),
                                            ...courseOptions.map((o) => ({
                                              value: o.id,
                                              label: o.label,
                                            })),
                                          ]}
                                        />
                                      ) : (
                                        <input
                                          id={selectDomId}
                                          value={code}
                                          onChange={(e) =>
                                            updateCourseCode(sem.id, idx, e.target.value)
                                          }
                                          className="w-full rounded-lg border border-[#d1d5db] bg-white px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-[#0f172a] shadow-[0_1px_2px_rgba(0,0,0,0.05)] outline-none transition-all focus:border-[#FE6507] focus:ring-2 focus:ring-[#FE6507]/15"
                                          placeholder="BUAN 6320"
                                        />
                                      )}
                                    </div>
                                    <button
                                      type="button"
                                      aria-label={`Remove ${norm || 'course'}`}
                                      className="flex shrink-0 items-center justify-center rounded-lg p-2 text-[#d9534f] transition-colors hover:bg-red-50"
                                      onClick={() => removeCourseAt(sem.id, idx)}
                                    >
                                      <Trash2 className="h-5 w-5" strokeWidth={2} aria-hidden />
                                    </button>
                                  </li>
                                )
                              })}
                            </ul>
                            <button
                              type="button"
                              className="mt-3 text-left text-xs font-semibold text-[#FE6507] transition-colors hover:underline"
                              onClick={() => addCourseToSemester(sem.id)}
                            >
                              + Add course
                            </button>
                          </>
                        )}
                      </motion.div>
                    )
                  })}
                </div>
              </div>
              <div className="mt-6 flex shrink-0 justify-end border-t border-[color:var(--border)] pt-4">
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  className="rounded-full bg-[#0f6b44] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#13724f]"
                  onClick={handleClassesDone}
                >
                  Looks good! →
                </motion.button>
              </div>
            </div>
          </div>
        )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
