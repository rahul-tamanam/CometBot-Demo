import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, GraduationCap, Menu, Moon, Sun, X } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { ResourcesPanel } from './ResourcesPanel'
import { PromptCard } from './PromptCard'
import { ChatBubble } from './ChatBubble'
import { InputBar } from './InputBar'
import type { ChatMessage, ChatThread, ModeId } from './types'
import {
  careerMentorChat,
  degreePlannerChat,
  getHighlightCertificates,
  getHighlightCourses,
  type DegreePlannerResponse,
  type Message as ApiMessage,
} from '@/api'
import { useProfile } from '@/hooks/useProfile'
import { ProfilePage } from '@/components/profile/ProfilePage'
import ProgressBar from '@/components/degree/ProgressBar'
import CourseCardComponent from '@/components/degree/CourseCardComponent'
import SemesterTimeline from '@/components/degree/SemesterTimeline'
import SkillsGapAnalyzer from '@/components/SkillsGapAnalyzer'
import { DemoDisclaimer } from '@/components/DemoDisclaimer'
import { DemoAcknowledgmentModal, DemoFloatingBadge } from '@/components/DemoAcknowledgmentModal'
import { degreePlannerNetworkFallback, careerMentorNetworkFallback } from '@/lib/demoMessages'

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

function modeToTag(mode: ModeId) {
  if (mode === 'academic') return 'Academic Planning Engine'
  if (mode === 'career') return 'Career Insights Engine'
  return 'Course Info Engine'
}

function modeAccent(mode: ModeId) {
  if (mode === 'academic') return 'bg-gradient-to-r from-[#ff4d4d] via-[#ff7a1a] to-[#ff9a33]'
  if (mode === 'career') return 'bg-gradient-to-r from-[#f97316] via-[#fb923c] to-[#f59e0b]'
  return 'bg-gradient-to-r from-[#ff7a1a] via-[#ff9a33] to-[#f97316]'
}

function threadTitleFrom(text: string) {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return 'New chat'
  return t.length > 34 ? t.slice(0, 34) + '…' : t
}

const SUGGESTED_MSBA: Record<ModeId, string[]> = {
  academic: [
    'What courses should I take next semester?',
    'What are the core courses for Business Analytics?',
    'What careers align with my degree?',
    'Show prerequisites for BUAN 6382',
  ],
  career: [
    'What does a Data Analyst do day-to-day?',
    'What skills do I need for Data Scientist roles?',
    'What roles fit someone who likes AI/ML?',
    'What certificates can help me build skills in Data Science?',
  ],
  course: [
    'Tell me about BUAN 6320',
    'What are the prerequisites for BUAN 6398?',
    'Which electives cover machine learning?',
    'What is the difference between core and electives?',
  ],
}

const SUGGESTED_MSITM: Record<ModeId, string[]> = {
  academic: [
    'What should I take next semester to finish both Part A and Part B core requirements?',
    'How many core track slots do I still need for MSITM?',
    'Which core track course should I take next from a different track?',
    'Show prerequisites for MIS 6380',
  ],
  career: [
    'What does an IT Product Manager do day-to-day?',
    'What skills do I need for Technology Consultant roles?',
    'What roles fit someone interested in enterprise systems and strategy?',
    'What certificates can help me build skills in Product Management?',
  ],
  course: [
    'Tell me about MIS 6378',
    'What are the prerequisites for MIS 6380?',
    'Which electives are best for product and innovation careers?',
    'What is the difference between required core and core track courses?',
  ],
}

function getSuggestedPrompts(mode: ModeId, programId: string): string[] {
  return (programId || '').trim().toLowerCase() === 'msitm'
    ? SUGGESTED_MSITM[mode]
    : SUGGESTED_MSBA[mode]
}

export function CometDashboard() {
  const { profile, saveProfile, resetProfile, completedCourses } = useProfile()
  const profileCourseHistory = useMemo(
    () =>
      (profile.semesters || []).flatMap((sem) =>
        (sem.courses || [])
          .map((course) => ({ course, semester: sem.label }))
          .filter((row) => row.course.trim()),
      ),
    [profile.semesters],
  )
  const [threads, setThreads] = useState<ChatThread[]>(() => {
    const now = Date.now()
    return [
      {
        id: uid(),
        title: 'New chat',
        createdAt: now,
        updatedAt: now,
        mode: 'academic',
        messages: [],
      },
    ]
  })
  const [activeId, setActiveId] = useState(threads[0].id)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const [mobileLeftOpen, setMobileLeftOpen] = useState(false)
  const [mobileRightOpen, setMobileRightOpen] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [logoOk, setLogoOk] = useState(true)
  const [leftWidth, setLeftWidth] = useState(300)
  const [rightWidth, setRightWidth] = useState(300)
  const [activeView, setActiveView] = useState<'chat' | 'profile'>('chat')
  const [profileOpen, setProfileOpen] = useState(false)
  const [userContext, setUserContext] = useState<'new' | 'current' | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const v = localStorage.getItem('cometbot_theme')
      return v === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })

  const activeThread = threads.find((t) => t.id === activeId) ?? threads[0]
  const mode = activeThread.mode
  const accentClass = modeAccent(mode)
  const suggestedPrompts = useMemo(
    () => getSuggestedPrompts(mode, profile.program_id || 'msba'),
    [mode, profile.program_id],
  )

  // Structured degree planner output — only populated when the user is in a
  // degree-planner-driven mode. Reset whenever we leave those modes, switch
  // threads, or open the profile view. The panel is not rendered inline;
  // instead the user opens it on demand via the input-bar button.
  const isDegreePlanner = mode === 'academic' || mode === 'course'
  const isSkillsGapMode = mode === 'course'
  const [degreeResponse, setDegreeResponse] = useState<DegreePlannerResponse | null>(null)
  const [progressOpen, setProgressOpen] = useState(false)
  const [showRemaining, setShowRemaining] = useState(false)
  const [courseIdsForHighlight, setCourseIdsForHighlight] = useState<string[]>([])
  const [courseTitlesForHighlight, setCourseTitlesForHighlight] = useState<string[]>([])
  const [certTitlesForHighlight, setCertTitlesForHighlight] = useState<string[]>([])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [courses, certs] = await Promise.all([
          getHighlightCourses(profile.program_id || 'msba'),
          getHighlightCertificates(profile.program_id || 'msba'),
        ])
        if (!active) return
        setCourseIdsForHighlight(
          courses
            .map((c) => (c.course_id || '').trim().toUpperCase())
            .filter((id) => id.length > 0),
        )
        setCourseTitlesForHighlight(
          courses
            .map((c) => (c.title || '').trim())
            .filter((t) => t.length > 0),
        )
        setCertTitlesForHighlight(
          certs
            .map((c) => (c.cert_title || '').trim())
            .filter((t) => t.length > 0),
        )
      } catch {
        if (!active) return
        setCourseIdsForHighlight([])
        setCourseTitlesForHighlight([])
        setCertTitlesForHighlight([])
      }
    })()
    return () => {
      active = false
    }
  }, [profile.program_id])

  useEffect(() => {
    if (!isDegreePlanner || activeView !== 'chat') {
      setDegreeResponse(null)
      setProgressOpen(false)
      setShowRemaining(false)
    }
  }, [isDegreePlanner, activeView, activeId])

  // The "Remaining Courses" section is opt-in — reset the toggle each time
  // the modal is re-opened so users don't see a stale open state.
  useEffect(() => {
    if (!progressOpen) setShowRemaining(false)
  }, [progressOpen])
  const profileBannerText = useMemo(() => {
    if (mode !== 'academic') return null
    if (completedCourses.length === 0) return 'No courses in profile · Treating you as a new student'
    return `Advising based on your profile · ${completedCourses.length} courses completed`
  }, [completedCourses.length, mode])
  const panelContentKey = `${mode}-${activeView}-${isSkillsGapMode ? 'skills-gap' : activeThread.messages.length === 0 ? 'landing' : 'chat'}`

  const applyTheme = (t: 'light' | 'dark') => {
    setTheme(t)
    try {
      localStorage.setItem('cometbot_theme', t)
    } catch {
      // ignore
    }
    document.documentElement.classList.toggle('dark', t === 'dark')
  }

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollToBottom = () =>
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 30)

  const setThread = (id: string, patch: (t: ChatThread) => ChatThread) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? patch(t) : t)))
  }

  // Clear every piece of per-chat UI state in one place so both the
  // "new chat / back to landing" action and any component/mode switch
  // produce a truly fresh slate with no leaked bubbles, no stale degree
  // response, and no lingering input text.
  const resetChatState = () => {
    setInput('')
    setDegreeResponse(null)
    setProgressOpen(false)
    setShowRemaining(false)
    setUserContext(null)
    setMobileLeftOpen(false)
    setActiveView('chat')
    setProfileOpen(false)
  }

  const newChat = () => {
    const now = Date.now()
    const t: ChatThread = {
      id: uid(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      mode,
      messages: [],
    }
    setThreads((p) => [t, ...p])
    setActiveId(t.id)
    resetChatState()
  }

  const setMode = (m: ModeId) => {
    // No-op if the user clicked the mode they're already in — avoids
    // wiping a conversation they did not intend to reset.
    if (m === mode) {
      setMobileLeftOpen(false)
      setActiveView('chat')
      setProfileOpen(false)
      return
    }

    // Switching to a different component: the new component should load
    // fresh, so wipe the current thread's messages + title and clear all
    // chat-level UI state.
    setThread(activeId, (t) => ({
      ...t,
      mode: m,
      title: 'New chat',
      messages: [],
      updatedAt: Date.now(),
    }))
    resetChatState()
  }

  const startContextIfMissing = () => {
    if (userContext) return userContext
    const ctx: 'new' | 'current' = completedCourses.length === 0 ? 'new' : 'current'
    setUserContext(ctx)
    return ctx
  }

  const handleFaqClick = (prompt: string) => {
    // User-driven only: set context and send once.
    startContextIfMissing()
    void send(prompt)
  }

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim()
    if (!text || loading) return

    setLoading(true)
    setInput('')

    const now = Date.now()
    const userMsg: ChatMessage = { role: 'user', content: text, ts: now }

    setThread(activeId, (t) => {
      const title = t.messages.length === 0 ? threadTitleFrom(text) : t.title
      return { ...t, title, updatedAt: now, messages: [...t.messages, userMsg] }
    })
    scrollToBottom()

    const historyForApi: ApiMessage[] = (activeThread.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }))

    try {
      let botText = ''
      if (mode === 'career') {
        const bg = (profile.background || '').trim()
        const ctx = startContextIfMissing()
        const res = await careerMentorChat({
          message: bg ? `Student background: ${bg}\n\n${text}` : text,
          conversation_history: historyForApi,
          completed_courses: completedCourses,
          student_type: ctx,
          course_history: profileCourseHistory,
          program_id: profile.program_id || 'msba',
        })
        botText = res.response
      } else {
        const ctx = startContextIfMissing()
        // academic + course info route through  -planner for catalog/prereq/eligibility logic
        const res = await degreePlannerChat({
          message: text,
          completed_courses: completedCourses,
          conversation_history: historyForApi,
          student_type: ctx,
          interests: undefined,
          course_history: profileCourseHistory,
          program_id: profile.program_id || 'msba',
        })
        setDegreeResponse(res)
        botText = res.narrative
      }

      const botMsg: ChatMessage = {
        role: 'assistant',
        content: botText,
        tag: modeToTag(mode),
        ts: Date.now(),
      }
      setThread(activeId, (t) => ({
        ...t,
        updatedAt: Date.now(),
        messages: [...t.messages, botMsg],
      }))
      scrollToBottom()
    } catch {
      const botMsg: ChatMessage = {
        role: 'assistant',
        content: mode === 'career' ? careerMentorNetworkFallback : degreePlannerNetworkFallback,
        tag: modeToTag(mode),
        ts: Date.now(),
      }
      setThread(activeId, (t) => ({ ...t, messages: [...t.messages, botMsg] }))
      scrollToBottom()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="h-screen w-full overflow-hidden text-[color:var(--text)]"
      style={{ backgroundColor: 'var(--bg)' }}
    >
      <DemoAcknowledgmentModal active />
      <DemoFloatingBadge />
      {/* Global header (matches reference) */}
      <header
        className="flex h-14 items-center justify-between px-4"
        style={{
          borderTop: '6px solid var(--accent)',
          borderBottom: '1px solid var(--comet-header-border)',
          background: 'var(--comet-header-bg)',
        }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl lg:hidden"
            style={{ color: 'var(--comet-header-fg)' }}
            onClick={() => setMobileLeftOpen(true)}
            title="Open navigation"
          >
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 overflow-hidden rounded-full ring-1 bg-white" style={{ borderColor: 'var(--border)' }}>
              {logoOk ? (
                <img
                  src="/jsom.jpeg"
                  alt="JSOM"
                  className="h-8 w-8 object-cover"
                  onError={() => setLogoOk(false)}
                />
              ) : (
                <div
                  className="h-8 w-8"
                  aria-hidden
                  style={{
                    background:
                      'linear-gradient(135deg, rgba(255,77,77,1) 0%, rgba(255,122,26,1) 55%, rgba(255,154,51,1) 100%)',
                  }}
                />
              )}
            </div>
            <div className="leading-tight">
              <div className="flex items-baseline gap-2">
                <button
                  type="button"
                  className="text-2xl font-extrabold tracking-tight"
                  style={{
                    animation: 'comet-shimmer 2s ease-in-out infinite alternate',
                    color: 'var(--comet-header-fg)',
                  }}
                  onClick={() => window.location.reload()}
                  title="Refresh"
                >
                  CometBot
                </button>
              </div>
              <div className="text-[11px] font-semibold" style={{ color: 'var(--comet-header-muted)' }}>
                Program: {profile.program_name || 'MS in Business Analytics and Artificial Intelligence'}
              </div>
            </div>
          </div>
        </div>

        <nav className="flex items-center gap-4 text-sm font-extrabold tracking-tight">
          <a
            className="hidden rounded-lg px-2 py-1 md:inline-flex"
            style={{ color: 'var(--comet-header-muted)' }}
            href="https://www.utdallas.edu/academics/calendar/"
            target="_blank"
            rel="noreferrer"
          >
            Academic Calendar
          </a>
          <a
            className="hidden rounded-lg px-2 py-1 md:inline-flex"
            style={{ color: 'var(--comet-header-muted)' }}
            href="https://map.utdallas.edu/"
            target="_blank"
            rel="noreferrer"
          >
            Campus Map
          </a>
          <button
            type="button"
            role="switch"
            aria-checked={theme === 'dark'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="relative inline-flex h-9 w-14 shrink-0 cursor-pointer rounded-full border p-[3px] transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--comet-header-fg)_70%,transparent_30%)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--comet-header-focus-ring-offset)]"
            style={{
              background: 'var(--comet-header-switch-track)',
              borderColor: 'var(--comet-header-border)',
              boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.14)',
            }}
            onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Sun
              size={13}
              strokeWidth={2}
              className="pointer-events-none absolute left-[7px] top-1/2 -translate-y-1/2"
              style={{
                color: 'var(--comet-header-muted)',
                opacity: theme === 'light' ? 0.35 : 0.55,
              }}
              aria-hidden
            />
            <Moon
              size={13}
              strokeWidth={2}
              className="pointer-events-none absolute right-[7px] top-1/2 -translate-y-1/2"
              style={{
                color: 'var(--comet-header-muted)',
                opacity: theme === 'dark' ? 0.35 : 0.55,
              }}
              aria-hidden
            />
            <span
              className="pointer-events-none absolute top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full shadow-md transition-[left] duration-200 ease-out"
              style={{
                left: theme === 'dark' ? 'calc(100% - 1.75rem - 3px)' : '3px',
                backgroundColor: 'var(--comet-header-fg)',
                color: '#114634',
                boxShadow:
                  '0 1px 3px rgba(0, 0, 0, 0.25), 0 0 0 1px color-mix(in oklab, #114634 18%, transparent)',
              }}
            >
              {theme === 'dark' ? (
                <Moon size={14} strokeWidth={2.25} aria-hidden />
              ) : (
                <Sun size={14} strokeWidth={2.25} aria-hidden />
              )}
            </span>
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-xl px-3 text-xs font-semibold xl:hidden"
            style={{
              color: 'var(--comet-header-fg)',
              border: '1px solid var(--comet-header-border)',
              backgroundColor: 'var(--comet-header-elevated)',
            }}
            onClick={() => setMobileRightOpen(true)}
          >
            Resources
          </button>
        </nav>
      </header>

      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        {/* Left sidebar (desktop) */}
        <div
          className="relative hidden h-full min-h-0 lg:block transition-[width] duration-200 ease-in-out"
          style={{
            width: leftCollapsed ? 72 : leftWidth,
            borderRight: '1px solid var(--border)',
            backgroundColor: 'var(--bg)',
          }}
        >
          <Sidebar
            threads={threads}
            activeThreadId={activeId}
            mode={mode}
            onNewChat={newChat}
            onSelectThread={(id) => setActiveId(id)}
            onSelectMode={setMode}
            activeView={activeView}
            onSelectProfile={() => {
              setActiveView('profile')
              setProfileOpen(true)
              setMobileLeftOpen(false)
            }}
            collapsed={leftCollapsed}
            onToggleCollapsed={() => setLeftCollapsed((v) => !v)}
          />
          {!leftCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent"
              onMouseDown={(e) => {
                e.preventDefault()
                const startX = e.clientX
                const startW = leftWidth
                const onMove = (ev: MouseEvent) => {
                  const next = Math.max(260, Math.min(420, startW + (ev.clientX - startX)))
                  setLeftWidth(next)
                }
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            />
          )}
        </div>

        {/* Center */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 py-4">
            <div
              className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl shadow-sm"
              style={{
                backgroundImage: "url('/bg.png')",
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                border: '1px solid var(--border)',
              }}
            >
              <div
                className="absolute inset-0"
                aria-hidden
                style={{
                  backgroundColor: 'var(--chat-bg-scrim)',
                }}
              />
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col px-4 overflow-hidden">
                <style>{`
                  @keyframes panelSwitchIn {
                    from { opacity: 0; transform: translateY(6px); }
                    to { opacity: 1; transform: translateY(0); }
                  }
                `}</style>
                <div
                  key={panelContentKey}
                  style={{
                    minHeight: 0,
                    minWidth: 0,
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    animation: 'panelSwitchIn 220ms ease',
                  }}
                >
                  {isSkillsGapMode ? (
                    <div className="min-h-0 min-w-0 flex-1 overflow-hidden py-4">
                      <div className="h-full overflow-hidden rounded-2xl">
                        <SkillsGapAnalyzer
                          profile={{
                            completedCourses: completedCourses || [],
                            courseHistory: profileCourseHistory || [],
                            programId: profile.program_id || 'msba',
                          }}
                        />
                      </div>
                    </div>
                  ) : activeThread.messages.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center py-10">
                      <div className="w-full max-w-3xl text-center">
                        <div className="mx-auto mb-2 max-w-2xl text-2xl tracking-tight" style={{ color: 'var(--text)' }}>
                          <span className="font-extrabold">Plan your degree. Shape your career.</span>

                        </div>
                        <div className="mx-auto mb-6 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                          CometBot is an AI-powered tool that helps you track requirements, explore courses, and align your skills with real career paths
                        </div>
                        <div className="mx-auto grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
                          {suggestedPrompts.map((p) => (
                            <PromptCard key={p} text={`“${p}”`} onClick={() => handleFaqClick(p)} />
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto py-6">
                      <div className="space-y-4 px-1">
                        {profileBannerText && (
                          <div
                            className="rounded-2xl px-3 py-2 text-xs font-semibold backdrop-blur"
                            style={{
                              backgroundColor: 'color-mix(in oklab, var(--surface) 70%, transparent 30%)',
                              border: '1px solid var(--border)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            {profileBannerText}
                          </div>
                        )}
                        {activeThread.messages.map((m, idx) => (
                          <ChatBubble
                            key={idx}
                            message={m}
                            accentClass={accentClass}
                            highlightCatalog={{
                              courseIds: courseIdsForHighlight,
                              courseTitles: courseTitlesForHighlight,
                              certTitles: certTitlesForHighlight,
                            }}
                          />
                        ))}
                        {loading && (
                          <div className="animate-chat-pop flex justify-start">
                            <div
                              className="rounded-2xl px-4 py-3 text-sm shadow-sm"
                              style={{ backgroundColor: 'var(--surface2)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                            >
                              Thinking…
                            </div>
                          </div>
                        )}

                        <div ref={messagesEndRef} />
                      </div>
                    </div>
                  )}
                </div>

                {activeView === 'chat' && !isSkillsGapMode && (
                  <InputBar
                    value={input}
                    onChange={setInput}
                    onSend={() => send()}
                    disabled={loading}
                    placeholder="Ask anything.."
                    leadingButton={
                      isDegreePlanner ? (
                        <button
                          type="button"
                          onClick={() => setProgressOpen(true)}
                          disabled={!degreeResponse}
                          title={
                            degreeResponse
                              ? 'Show degree progress'
                              : 'Ask a question first to load your degree progress'
                          }
                          className="hidden h-9 w-9 items-center justify-center rounded-xl transition-colors md:flex disabled:opacity-40"
                          style={{
                            color: degreeResponse ? '#c0392b' : 'var(--text-muted)',
                            border: '1px solid var(--border)',
                            background: degreeResponse
                              ? 'rgba(192,57,43,0.08)'
                              : 'transparent',
                          }}
                          aria-label="Show degree progress"
                        >
                          <GraduationCap size={18} />
                        </button>
                      ) : undefined
                    }
                  />
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Right sidebar (desktop) */}
        <div
          className="relative hidden h-full min-h-0 xl:block transition-[width] duration-200 ease-in-out"
          style={{
            width: rightCollapsed ? 72 : rightWidth,
            borderLeft: '1px solid var(--border)',
            backgroundColor: 'var(--bg)',
          }}
        >
          <ResourcesPanel
            collapsed={rightCollapsed}
            onToggleCollapsed={() => setRightCollapsed((v) => !v)}
          />
          {!rightCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
              className="absolute left-0 top-0 h-full w-1 cursor-col-resize bg-transparent"
              onMouseDown={(e) => {
                e.preventDefault()
                const startX = e.clientX
                const startW = rightWidth
                const onMove = (ev: MouseEvent) => {
                  const next = Math.max(280, Math.min(460, startW - (ev.clientX - startX)))
                  setRightWidth(next)
                }
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            />
          )}
        </div>
      </div>

      {/* Mobile left drawer */}
      {mobileLeftOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setMobileLeftOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-[320px] shadow-2xl">
            <div className="absolute right-2 top-2 z-10">
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white text-slate-700 ring-1 ring-slate-200"
                onClick={() => setMobileLeftOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <Sidebar
              threads={threads}
              activeThreadId={activeId}
              mode={mode}
              onNewChat={newChat}
              onSelectThread={(id) => {
                setActiveId(id)
                setMobileLeftOpen(false)
              }}
              onSelectMode={setMode}
              activeView={activeView}
              onSelectProfile={() => {
                setActiveView('profile')
                setProfileOpen(true)
                setMobileLeftOpen(false)
              }}
              collapsed={false}
              onToggleCollapsed={() => {}}
            />
          </div>
        </div>
      )}

      {/* Mobile right drawer */}
      {mobileRightOpen && (
        <div className="fixed inset-0 z-50 xl:hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setMobileRightOpen(false)}
          />
          <div className="absolute right-0 top-0 h-full w-[340px] shadow-2xl">
            <div className="absolute left-2 top-2 z-10">
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white text-slate-700 ring-1 ring-slate-200"
                onClick={() => setMobileRightOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <ResourcesPanel collapsed={false} onToggleCollapsed={() => {}} />
          </div>
        </div>
      )}

      {/* Profile modal (ChatGPT-style floating panel) */}
      {profileOpen && (
        <div className="fixed inset-0 z-[60]">
          <style>{`
            @keyframes profileFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes profilePopIn {
              from { opacity: 0; transform: translateY(8px) scale(0.985); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>
          <div
            className="absolute inset-0 bg-black/40"
            style={{ animation: 'profileFadeIn 180ms ease' }}
            onClick={() => {
              setProfileOpen(false)
              setActiveView('chat')
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div
              className="relative w-full max-w-4xl overflow-hidden rounded-3xl shadow-2xl"
              style={{
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)',
                animation: 'profilePopIn 220ms ease',
              }}
            >
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <div className="text-sm font-extrabold tracking-tight" style={{ color: 'var(--text)' }}>
                  Profile
                </div>
                <button
                  type="button"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                  onClick={() => {
                    setProfileOpen(false)
                    setActiveView('chat')
                  }}
                  title="Close"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="h-[min(72vh,720px)] min-h-0">
                <ProfilePage
                  profile={profile}
                  saveProfile={saveProfile}
                  resetProfile={resetProfile}
                  onProgramChanged={() => {
                    setThread(activeId, (t) => ({
                      ...t,
                      title: 'New chat',
                      messages: [],
                      updatedAt: Date.now(),
                    }))
                    resetChatState()
                    setProfileOpen(false)
                    setActiveView('chat')
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Degree progress modal — opened from the input-bar button.
          Shows pre-computed progress, the semester plan (when present),
          recommended courses, choice-group notes, and the full remaining
          course catalog split by Core / Elective. */}
      {progressOpen && degreeResponse && (
        <div className="fixed inset-0 z-[60]">
          <style>{`
            @keyframes progressFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes progressPopIn {
              from { opacity: 0; transform: translateY(10px) scale(0.985); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>
          <div
            className="absolute inset-0 bg-black/40"
            style={{ animation: 'progressFadeIn 160ms ease' }}
            onClick={() => setProgressOpen(false)}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div
              className="relative w-full max-w-3xl overflow-hidden rounded-3xl shadow-2xl flex flex-col"
              style={{
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)',
                animation: 'progressPopIn 220ms ease',
              }}
            >
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <div className="flex items-center gap-2">
                  <GraduationCap size={18} style={{ color: '#c0392b' }} />
                  <div
                    className="text-sm font-extrabold tracking-tight"
                    style={{ color: 'var(--text)' }}
                  >
                    Degree Progress
                  </div>
                </div>
                <button
                  type="button"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                  onClick={() => setProgressOpen(false)}
                  title="Close"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="h-[min(80vh,760px)] min-h-0 overflow-y-auto px-4 py-4">
                <div className="flex flex-col gap-4">
                  <ProgressBar progress={degreeResponse.progress} />

                  {degreeResponse.semester_plan.length > 0 && (
                    <SemesterTimeline semesters={degreeResponse.semester_plan} />
                  )}

                  {degreeResponse.recommended_courses.length > 0 && (() => {
                    const recCore = degreeResponse.recommended_courses.filter(
                      (c) => c.course_type === 'Core',
                    )
                    const recElec = degreeResponse.recommended_courses.filter(
                      (c) => c.course_type === 'Elective',
                    )
                    // Soft green hue on the column shell — subtle enough to keep
                    // the product's aesthetic but signals "active / actionable".
                    const columnStyle = {
                      background:
                        'color-mix(in oklab, #4caf82 7%, var(--surface) 93%)',
                      border:
                        '1px solid color-mix(in oklab, #4caf82 24%, var(--border) 76%)',
                    } as const
                    return (
                      <div>
                        <h3
                          className="text-sm font-semibold mb-2"
                          style={{ color: 'var(--text)' }}
                        >
                          Recommended This Semester
                        </h3>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="rounded-2xl p-4" style={columnStyle}>
                            <div
                              className="text-center text-base font-bold uppercase tracking-[0.14em] mb-3"
                              style={{ color: '#4f6ef7' }}
                            >
                              Core
                            </div>
                            {recCore.length === 0 ? (
                              <p
                                className="text-xs italic text-center py-6"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                No core recommendations in this response.
                              </p>
                            ) : (
                              <div className="flex flex-col gap-2">
                                {recCore.map((course, i) => (
                                  <CourseCardComponent
                                    key={`rec-core-${i}`}
                                    course={course}
                                    hideBadge
                                  />
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="rounded-2xl p-4" style={columnStyle}>
                            <div
                              className="text-center text-base font-bold uppercase tracking-[0.14em] mb-3"
                              style={{ color: '#4caf82' }}
                            >
                              Elective
                            </div>
                            {recElec.length === 0 ? (
                              <p
                                className="text-xs italic text-center py-6"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                No elective recommendations in this response.
                              </p>
                            ) : (
                              <div className="flex flex-col gap-2">
                                {recElec.map((course, i) => (
                                  <CourseCardComponent
                                    key={`rec-elec-${i}`}
                                    course={course}
                                    hideBadge
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })()}

                  {degreeResponse.choice_group_notes.length > 0 && (
                    <div
                      className="rounded-lg p-3"
                      style={{
                        border: '1px solid rgba(245, 158, 11, 0.35)',
                        background: 'rgba(245, 158, 11, 0.08)',
                      }}
                    >
                      {degreeResponse.choice_group_notes.map((note, i) => (
                        <p
                          key={i}
                          className="text-xs leading-relaxed whitespace-pre-wrap"
                          style={{ color: 'var(--warning)' }}
                        >
                          {note}
                        </p>
                      ))}
                    </div>
                  )}

                  {(degreeResponse.remaining_core.length > 0 ||
                    degreeResponse.remaining_elective.length > 0) && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowRemaining((v) => !v)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold transition-colors"
                        style={{
                          color: 'var(--text)',
                          border: '1px solid var(--border)',
                          background: 'var(--surface)',
                        }}
                        aria-expanded={showRemaining}
                      >
                        <span>
                          {showRemaining ? 'Hide' : 'Show'} all remaining courses
                          <span
                            className="ml-2 text-xs font-normal"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            ({degreeResponse.progress.core_remaining_count} core,{' '}
                            {degreeResponse.progress.elective_remaining_count} elective)
                          </span>
                        </span>
                        {showRemaining ? (
                          <ChevronUp size={16} style={{ color: 'var(--text-muted)' }} />
                        ) : (
                          <ChevronDown size={16} style={{ color: 'var(--text-muted)' }} />
                        )}
                      </button>

                      {showRemaining && (
                        <div className="mt-3 flex flex-col gap-2">
                          {degreeResponse.remaining_core.length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <p
                                className="text-[11px] font-semibold uppercase tracking-[0.12em] px-1"
                                style={{ color: '#4f6ef7' }}
                              >
                                Core
                                <span
                                  className="ml-2 font-normal normal-case tracking-normal"
                                  style={{ color: 'var(--text-muted)' }}
                                >
                                  {degreeResponse.progress.core_remaining_count} remaining
                                </span>
                              </p>
                              {degreeResponse.remaining_core.map((c, i) => (
                                <CourseCardComponent key={`core-${i}`} course={c} hideBadge />
                              ))}
                            </div>
                          )}
                          {degreeResponse.remaining_elective.length > 0 && (
                            <div className="flex flex-col gap-1.5 mt-2">
                              <p
                                className="text-[11px] font-semibold uppercase tracking-[0.12em] px-1"
                                style={{ color: '#4caf82' }}
                              >
                                Elective
                                <span
                                  className="ml-2 font-normal normal-case tracking-normal"
                                  style={{ color: 'var(--text-muted)' }}
                                >
                                  {degreeResponse.progress.elective_remaining_count} remaining
                                </span>
                              </p>
                              {degreeResponse.remaining_elective.map((c, i) => (
                                <CourseCardComponent key={`elec-${i}`} course={c} hideBadge />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <DemoDisclaimer variant="footer" />
    </div>
  )
}

