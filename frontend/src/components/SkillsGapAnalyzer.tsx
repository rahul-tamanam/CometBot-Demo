import React, { useState, useRef, useCallback, useEffect } from 'react';
import { LayoutDashboard, Paperclip, PlusCircle } from 'lucide-react';
import { ChatBubble } from '@/components/dashboard/ChatBubble';
import { InputBar } from '@/components/dashboard/InputBar';
import type { ChatMessage as DashboardChatMessage } from '@/components/dashboard/types';
import Loader from '@/components/ui/loader-5';
import { API_BASE } from '@/api';
import { skillsGapNetworkFallback } from '@/lib/demoMessages';

/** Same accent as Degree Planner user bubbles (red→orange gradient) */
const ACCENT_SKILLS_GAP =
  'bg-gradient-to-r from-[#ff4d4d] via-[#ff7a1a] to-[#ff9a33]'

const EMPTY_HIGHLIGHT = {
  courseIds: [] as string[],
  courseTitles: [] as string[],
  certTitles: [] as string[],
}

type Phase = 'idle' | 'resume_uploaded' | 'jd_input' | 'analyzing' | 'chat';
type JdMode = 'paste' | 'select';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  isAnalysis?: boolean;
}

interface StructuredAnalysis {
  job_title: string;
  match_score: number;
  match_percent: number;
  total_required: number;
  total_matched: number;
  matched_skills: Array<{ skill: string; type: string }>;
  partial_skills?: Array<{ name: string; category: string; evidence?: string }>;
  missing_technical: string[];
  missing_soft: string[];
  recommended_courses: Array<{
    course_id: string;
    title: string;
    skill_addressed: string;
    course_type?: string;
  }>;
  student_skills_count: number;
  soft_skills_scored?: boolean;
  resume_name?: string;
}

interface Props {
  profile: {
    completedCourses: string[];
    courseHistory: Array<{ course: string; semester: string }>;
    programId: string;
  };
}

const JOB_ROLES = [
  'Business Analyst',
  'Business Development Manager',
  'Data Analyst',
  'Data Engineer',
  'Data Scientist',
  'ML Engineer',
  'Software Engineer',
  'Database Administrator',
  'Database Developer',
  'Financial Analyst',
  'Inventory Analyst',
  'Investment Analyst',
  'Market Analyst',
  'Market Research Analyst',
  'Marketing Analyst',
  'Network Analyst',
  'Product Manager',
  'Project Manager',
  'Research Analyst',
  'Supply Chain Analyst',
  'Supply Chain Manager',
  'Systems Analyst',
];

function MatchGauge({ percent }: { percent: number }) {
  const [animatedPercent, setAnimatedPercent] = useState(0);
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (animatedPercent / 100) * circumference;
  const score = Math.round(percent);

  const matchTier =
    score <= 60
      ? 'Fair Match'
      : score <= 70
        ? 'Good Match'
        : score <= 80
          ? 'Very Good Match'
          : 'Strong Match';

  useEffect(() => {
    setAnimatedPercent(0);
    const frame = requestAnimationFrame(() => {
      setAnimatedPercent(percent);
    });
    return () => cancelAnimationFrame(frame);
  }, [percent]);

  const percentText = Number.isInteger(animatedPercent)
    ? `${animatedPercent}%`
    : `${animatedPercent.toFixed(1)}%`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <div
        style={{
          position: 'relative',
          width: 228,
          height: 228,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
      <svg width={228} height={228} viewBox="0 0 228 228" style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <linearGradient id="skillsGapScoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ff4d4d" />
            <stop offset="55%" stopColor="#ff7a1a" />
            <stop offset="100%" stopColor="#ff9a33" />
          </linearGradient>
        </defs>
        <circle cx={114} cy={114} r={radius} fill="none" stroke="var(--border)" strokeOpacity={0.65} strokeWidth={14} />
        <circle
          cx={114}
          cy={114}
          r={radius}
          fill="none"
          stroke="url(#skillsGapScoreGradient)"
          strokeWidth={14}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1s ease, filter 0.25s ease', filter: 'drop-shadow(0px 0px 5px rgba(255,122,26,0.45))' }}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <span style={{ color: 'var(--text)', fontSize: 40, fontWeight: 800, lineHeight: 1 }}>
          {percentText}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
          
        </span>
      </div>
      </div>
      <span style={{ color: 'var(--text-muted)',textTransform: 'uppercase',fontWeight: 700, fontSize: 20, marginTop: -2 }}>
        {matchTier}
      </span>
    </div>
  );
}

function SkillPill({
  label,
  type,
}: {
  label: string;
  type: 'matched' | 'missing' | 'partial';
}) {
  const isDarkMode =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 500,
        background:
          type === 'matched'
            ? 'rgba(76,175,130,0.15)'
            : type === 'partial'
              ? 'rgba(245,158,11,0.15)'
              : 'rgba(232, 25, 10, 0.15)',
        color: isDarkMode ? '#E5E7EB' : '#0F172A',
        border: `1px solid ${
          type === 'matched'
            ? 'rgba(76,175,130,0.3)'
            : type === 'partial'
              ? 'rgba(245,158,11,0.35)'
              : 'rgba(232, 28, 10, 0.3)'
        }`,
        margin: '3px 3px 3px 0',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function DashboardPanel({
  analysis,
  onClose,
}: {
  analysis: StructuredAnalysis;
  onClose: () => void;
}) {
  const matchedTech = analysis.matched_skills.filter((s) => s.type === 'technical');
  const matchedSoft = analysis.matched_skills.filter((s) => s.type === 'soft');
  const partialTech =
    (analysis.partial_skills || []).filter((s) => s.category === 'technical') || [];
  const partialSoft =
    (analysis.partial_skills || []).filter((s) => s.category === 'soft') || [];
  const [openSections, setOpenSections] = useState({
    matchedTech: false,
    matchedSoft: false,
    partialTech: true,
    partialSoft: false,
    missingTech: true,
    missingSoft: true,
  });

  const toggleSection = (
    key: 'matchedTech' | 'matchedSoft' | 'partialTech' | 'partialSoft' | 'missingTech' | 'missingSoft',
  ) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const rowStyle: React.CSSProperties = {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    overflow: 'hidden',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
      }}
      onClick={onClose}
    >
      <style>{`
        @keyframes dashboardPop {
          from { transform: translateY(8px) scale(0.985); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
      `}</style>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.42)',
          backdropFilter: 'blur(2px)',
        }}
      />

      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 980,
          maxHeight: '80vh',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 20,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'dashboardPop 0.2s ease',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ color: 'var(--text)', fontWeight: 700, fontSize: 15 }}>Analysis Dashboard</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, width: 34, height: 34, borderRadius: 10 }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            padding: '20px',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '260px minmax(0, 1fr)',
                gap: 18,
                alignItems: 'start',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Target Role
                </span>
                <span style={{ color: 'var(--text)', fontWeight: 800, fontSize: 20, textAlign: 'center' }}>
                  {analysis.job_title}
                </span>
                <MatchGauge percent={analysis.match_percent} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {matchedTech.length > 0 && (
                  <div style={rowStyle}>
                    <button
                      type="button"
                      onClick={() => toggleSection('matchedTech')}
                      style={{
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        color: '#068644',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 1,
                        textTransform: 'uppercase',
                        padding: '11px 14px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        textAlign: 'left',
                      }}
                    >
                      <span>✓ Matched Technical Skills</span>
                      <span style={{ color: 'var(--text-muted)' }}>{openSections.matchedTech ? '▾' : '▸'}</span>
                    </button>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: openSections.matchedTech ? '1fr' : '0fr',
                        transition: 'grid-template-rows 220ms ease',
                      }}
                    >
                      <div
                        style={{
                          overflow: 'hidden',
                          opacity: openSections.matchedTech ? 1 : 0,
                          transition: 'opacity 180ms ease',
                        }}
                      >
                        <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap' }}>
                          {matchedTech.map((s) => (
                            <SkillPill key={s.skill} label={s.skill} type="matched" />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {matchedSoft.length > 0 && (
                  <div style={rowStyle}>
                    <button
                      type="button"
                      onClick={() => toggleSection('matchedSoft')}
                      style={{
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        color: '#068644',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 1,
                        textTransform: 'uppercase',
                        padding: '11px 14px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        textAlign: 'left',
                      }}
                    >
                      <span>✓ Matched Soft Skills</span>
                      <span style={{ color: 'var(--text-muted)' }}>{openSections.matchedSoft ? '▾' : '▸'}</span>
                    </button>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: openSections.matchedSoft ? '1fr' : '0fr',
                        transition: 'grid-template-rows 220ms ease',
                      }}
                    >
                      <div
                        style={{
                          overflow: 'hidden',
                          opacity: openSections.matchedSoft ? 1 : 0,
                          transition: 'opacity 180ms ease',
                        }}
                      >
                        <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap' }}>
                          {matchedSoft.map((s) => (
                            <SkillPill key={s.skill} label={s.skill} type="matched" />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {partialTech.length > 0 && (
                  <div style={rowStyle}>
                    <button
                      type="button"
                      onClick={() => toggleSection('partialTech')}
                      style={{
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        color: '#d97706',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 1,
                        textTransform: 'uppercase',
                        padding: '11px 14px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        textAlign: 'left',
                      }}
                    >
                      <span>≈ Partial Technical Skills</span>
                      <span style={{ color: 'var(--text-muted)' }}>{openSections.partialTech ? '▾' : '▸'}</span>
                    </button>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: openSections.partialTech ? '1fr' : '0fr',
                        transition: 'grid-template-rows 220ms ease',
                      }}
                    >
                      <div
                        style={{
                          overflow: 'hidden',
                          opacity: openSections.partialTech ? 1 : 0,
                          transition: 'opacity 180ms ease',
                        }}
                      >
                        <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap' }}>
                          {partialTech.map((s) => (
                            <SkillPill key={s.name} label={s.name} type="partial" />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {partialSoft.length > 0 && (
                  <div style={rowStyle}>
                    <button
                      type="button"
                      onClick={() => toggleSection('partialSoft')}
                      style={{
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        color: '#d97706',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 1,
                        textTransform: 'uppercase',
                        padding: '11px 14px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        textAlign: 'left',
                      }}
                    >
                      <span>≈ Partial Soft Skills</span>
                      <span style={{ color: 'var(--text-muted)' }}>{openSections.partialSoft ? '▾' : '▸'}</span>
                    </button>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: openSections.partialSoft ? '1fr' : '0fr',
                        transition: 'grid-template-rows 220ms ease',
                      }}
                    >
                      <div
                        style={{
                          overflow: 'hidden',
                          opacity: openSections.partialSoft ? 1 : 0,
                          transition: 'opacity 180ms ease',
                        }}
                      >
                        <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap' }}>
                          {partialSoft.map((s) => (
                            <SkillPill key={s.name} label={s.name} type="partial" />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {analysis.missing_technical.length > 0 && (
                  <div style={rowStyle}>
                    <button
                      type="button"
                      onClick={() => toggleSection('missingTech')}
                      style={{
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        color: '#D40920',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 1,
                        textTransform: 'uppercase',
                        padding: '11px 14px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        textAlign: 'left',
                      }}
                    >
                      <span>✗ Missing Technical Skills</span>
                      <span style={{ color: 'var(--text-muted)' }}>{openSections.missingTech ? '▾' : '▸'}</span>
                    </button>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: openSections.missingTech ? '1fr' : '0fr',
                        transition: 'grid-template-rows 220ms ease',
                      }}
                    >
                      <div
                        style={{
                          overflow: 'hidden',
                          opacity: openSections.missingTech ? 1 : 0,
                          transition: 'opacity 180ms ease',
                        }}
                      >
                        <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap' }}>
                          {analysis.missing_technical.map((s) => (
                            <SkillPill key={s} label={s} type="missing" />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {analysis.missing_soft.length > 0 && (
                  <div style={rowStyle}>
                    <button
                      type="button"
                      onClick={() => toggleSection('missingSoft')}
                      style={{
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        color: '#D40920',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 1,
                        textTransform: 'uppercase',
                        padding: '11px 14px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>

                      <span>✶ Nice to have — not included in match score</span>
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>{openSections.missingSoft ? '▾' : '▸'}</span>
                    </button>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: openSections.missingSoft ? '1fr' : '0fr',
                        transition: 'grid-template-rows 220ms ease',
                      }}
                    >
                      <div
                        style={{
                          overflow: 'hidden',
                          opacity: openSections.missingSoft ? 1 : 0,
                          transition: 'opacity 180ms ease',
                        }}
                      >
                        <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap' }}>
                          {analysis.missing_soft.map((s) => (
                            <SkillPill key={s} label={s} type="missing" />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

        {analysis.recommended_courses.length > 0 && (
          <div
            style={{
              marginTop: 16,
              background: 'color-mix(in oklab,rgb(243, 107, 11) 7%, var(--surface2) 93%)',
              border: '1px solid color-mix(in oklab, #ff7a1a 24%, var(--border) 76%)',
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ color: '#068644', fontSize: 14, fontWeight: 700, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Recommended Courses
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {analysis.recommended_courses.map((c) => (
                <div
                  key={c.course_id}
                  style={{
                    background: 'color-mix(in oklab, #ff7a1a 30%, var(--surface2) 84%)',
                    border: '1px solid color-mix(in oklab, #ff7a1a 50%, var(--border) 66%)',
                    borderRadius: 8,
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ color: '#e8650a', fontSize: 12.5, fontWeight: 700, marginBottom: 2 }}>
                    {c.course_id}
                  </div>
                  <div style={{ color: 'var(--text)', fontSize: 12, marginBottom: 4 }}>{c.title}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Builds: {c.skill_addressed}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

export default function SkillsGapAnalyzer({ profile }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [jdMode, setJdMode] = useState<JdMode>('paste');
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeName, setResumeName] = useState('');
  const [jdText, setJdText] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [analysis, setAnalysis] = useState<StructuredAnalysis | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showJdModal, setShowJdModal] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadHover, setUploadHover] = useState(false);
  const [noResumeHover, setNoResumeHover] = useState(false);
  const [confidenceWarning, setConfidenceWarning] = useState('');
  const [conversationHistory, setConversationHistory] = useState<Array<{ role: string; content: string }>>([]);
  const isDarkMode =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');
  const uploadHoverBg = isDarkMode
    ? 'color-mix(in oklab, var(--accent) 22%, var(--surface2) 78%)'
    : '#FFBF77';

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleFileSelect = useCallback((file: File) => {
    if (!file || file.type !== 'application/pdf') {
      alert('Please upload a PDF resume.');
      return;
    }
    setResumeFile(file);
    setResumeName(file.name);
    setPhase('resume_uploaded');
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const openAnotherJdModal = useCallback(() => {
    if (!resumeFile) return;
    setJdText('');
    setSelectedRole('');
    setShowMenu(false);
    setShowJdModal(true);
  }, [resumeFile]);

  const runAnalysis = useCallback(async () => {
    if (jdMode === 'paste' && !jdText.trim()) return;
    if (jdMode === 'select' && !selectedRole) return;

    setPhase('analyzing');
    setIsLoading(true);

    try {
      const formData = new FormData();
      if (resumeFile) {
        formData.append('file', resumeFile);
      }
      formData.append('completed_courses', JSON.stringify(profile.completedCourses || []));
      formData.append('program_id', profile.programId || 'msba');

      if (jdMode === 'paste') {
        formData.append('job_description', jdText.trim());
      } else {
        formData.append('target_job', selectedRole);
      }

      const res = await fetch(`${API_BASE}/skills-gap/analyze-resume`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setMessages([{ role: 'assistant', content: skillsGapNetworkFallback }]);
        setPhase('chat');
        return;
      }

      const analysisData: StructuredAnalysis = data.structured_analysis;
      setAnalysis(analysisData);

      if (data.confidence_warning) {
        setConfidenceWarning(data.confidence_warning);
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content: data.response,
        isAnalysis: true,
      };

      const firstHistory = [{ role: 'assistant', content: data.response }];
      setConversationHistory(firstHistory);
      setMessages([assistantMessage]);
      setPhase('chat');
    } catch {
      setMessages([
        {
          role: 'assistant',
          content: skillsGapNetworkFallback,
        },
      ]);
      setPhase('chat');
    } finally {
      setIsLoading(false);
    }
  }, [resumeFile, jdMode, jdText, selectedRole, profile]);

  const sendFollowUp = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isLoading) return;

    const userMsg: Message = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);

    const newHistory = [...conversationHistory, { role: 'user', content: text }];

    try {
      const payload = {
        message: text,
        conversation_history: conversationHistory,
        structured_analysis: analysis,
        completed_courses: profile.completedCourses || [],
        course_history: profile.courseHistory || [],
        target_job: jdMode === 'select' ? selectedRole : '',
        job_description: jdMode === 'paste' ? jdText : '',
        program_id: profile.programId || 'msba',
      };

      const res = await fetch(`${API_BASE}/skills-gap/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: skillsGapNetworkFallback },
        ]);
        return;
      }

      const reply = data.response || skillsGapNetworkFallback;
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      setConversationHistory([...newHistory, { role: 'assistant', content: reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: skillsGapNetworkFallback },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [inputText, isLoading, conversationHistory, analysis, profile, jdMode, selectedRole, jdText]);

  if (phase === 'idle') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px', gap: 15 }}>
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <div style={{ color: '#e8650a', fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 12 }}>
            
          </div>
          <h2
            style={{
              color: 'var(--text)',
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: '-0.025em',
              margin: '0 0 0px',
            }}
          >
            Close the gap. Reach your goal.
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.7, margin: 0 }}>
            
          </p>
        </div>

        <p
          className="text-sm leading-relaxed"
          style={{
            maxWidth: 700,
            textAlign: 'center',
            color: 'var(--text-muted)',
            margin: 0,
          }}
        >
          Upload a resume to begin. Skills will be analyzed against a target role, and gaps with recommended courses will be identified.
        </p>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onMouseEnter={() => setUploadHover(true)}
          onMouseLeave={() => setUploadHover(false)}
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: '100%',
            maxWidth: 480,
            border: `2px dashed ${
              dragOver || uploadHover
                ? 'color-mix(in oklab, var(--accent) 35%, var(--border) 65%)'
                : 'var(--border)'
            }`,
            borderRadius: 14,
            padding: '36px 24px',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragOver || uploadHover ? uploadHoverBg : 'var(--surface2)',
            transform: uploadHover ? 'translateY(-1px)' : 'translateY(0)',
            boxShadow: uploadHover ? '0 4px 10px rgba(0,0,0,0.12)' : '0 1px 2px rgba(0,0,0,0.06)',
            transition: 'all 0.2s ease',
          }}
        >
          <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center' }}>
            <PlusCircle size={42} strokeWidth={1.8} color="var(--text-muted)" />
          </div>
          <div style={{ color: 'var(--text)', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            Drop your resume here
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>or click to browse - PDF only</div>
        </div>

        <button
          type="button"
          onMouseEnter={() => setNoResumeHover(true)}
          onMouseLeave={() => setNoResumeHover(false)}
          onClick={() => {
            setPhase('jd_input');
            setJdText('');
            setSelectedRole('');
            setMessages([]);
            setAnalysis(null);
            setConversationHistory([]);
            setConfidenceWarning('');
            setDragOver(false);
            setUploadHover(false);
          }}
          style={{
            width: '100%',
            maxWidth: 320,
            borderRadius: 10,
            border: `1px solid ${
              noResumeHover
                ? 'color-mix(in oklab, var(--accent) 35%, var(--border) 65%)'
                : 'var(--border)'
            }`,
            padding: '10px 0',
            cursor: 'pointer',
            background: noResumeHover ? uploadHoverBg : 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 13,
            fontWeight: 600,
            transition: 'all 0.2s ease',
          }}
        >
          I don&apos;t have a resume
        </button>

        <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />

        <p style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', maxWidth: 420, lineHeight: 1.6, margin: 0 }}>
         
        </p>
      </div>
    );
  }

  if (phase === 'resume_uploaded' || phase === 'jd_input') {
    const canProceed = (jdMode === 'paste' && jdText.trim().length > 30) || (jdMode === 'select' && !!selectedRole);

    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px', gap: 24 }}>
        <div style={{ background: 'rgba(76,175,130,0.1)', border: '1px solid rgba(76,175,130,0.25)', borderRadius: 12, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10, maxWidth: 480, width: '100%' }}>
          <span style={{ fontSize: 20 }}>✓</span>
          <div>
            <div style={{ color: '#4caf82', fontSize: 13, fontWeight: 600 }}>
              {resumeFile ? 'Resume uploaded' : 'No resume provided'}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {resumeFile ? resumeName : 'Using your completed courses instead'}
            </div>
          </div>
          <button
            onClick={() => { setResumeFile(null); setResumeName(''); setPhase('idle'); }}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}
          >
            ✕
          </button>
        </div>

        <div style={{ maxWidth: 480, width: '100%' }}>
          <div style={{ color: 'var(--text)', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
            Now, what role are you targeting?
          </div>

          <div style={{ display: 'flex', gap: 0, marginBottom: 16, background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 3 }}>
            {(['paste', 'select'] as JdMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => { setJdMode(mode); setPhase('jd_input'); }}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  background: jdMode === mode ? '#e8650a' : 'transparent',
                  color: jdMode === mode ? '#fff' : '#9999bb',
                  transition: 'all 0.2s',
                }}
              >
                {mode === 'paste' ? 'Paste a Job Description' : 'Select a Role'}
              </button>
            ))}
          </div>

          {jdMode === 'paste' ? (
            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              placeholder="Paste the full job description here..."
              style={{
                width: '100%',
                minHeight: 200,
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text)',
                fontSize: 13,
                padding: '12px 14px',
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
                lineHeight: 1.6,
              }}
            />
          ) : (
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
              style={{
                width: '100%',
                padding: '12px 14px',
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: selectedRole ? 'var(--text)' : 'var(--text-muted)',
                fontSize: 13,
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="" disabled style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}>Choose a role...</option>
              {JOB_ROLES.map((r) => (
                <option key={r} value={r} style={{ background: 'var(--surface)', color: 'var(--text)' }}>{r}</option>
              ))}
            </select>
          )}

          <button
            onClick={runAnalysis}
            disabled={!canProceed}
            style={{
              marginTop: 16,
              width: '100%',
              padding: '12px 0',
              borderRadius: 8,
              border: 'none',
              cursor: canProceed ? 'pointer' : 'not-allowed',
              background: canProceed ? 'linear-gradient(90deg, #ff4d4d 0%, #ff7a1a 55%, #ff9a33 100%)' : 'var(--surface2)',
              color: canProceed ? '#fff' : 'var(--text-muted)',
              fontSize: 14,
              fontWeight: 700,
              transition: 'background 0.2s',
            }}
          >
            Run Analysis →
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'analyzing') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
        <Loader />
        <div style={{ color: 'var(--text)', fontSize: 15, fontWeight: 600 }}>Running analysis...</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Parsing resume · Comparing skills · Finding courses</div>
      </div>
    );
  }

  const contextBannerMain =
    analysis != null
      ? `Target role · ${analysis.job_title} · ${Math.round(analysis.match_percent)}% match`
      : null
  const matchScoreHighlightPhrases =
    analysis != null
      ? [
          `Match Score: ${analysis.match_percent}%`,
          `Match score: ${analysis.match_percent}%`,
          `match score: ${analysis.match_percent}%`,
        ]
      : []
  const responseHighlightCatalog =
    analysis != null
      ? {
          courseIds: analysis.recommended_courses.map((c) => c.course_id).filter(Boolean),
          courseTitles: [
            ...analysis.recommended_courses.map((c) => c.title).filter(Boolean),
            ...matchScoreHighlightPhrases,
          ],
          certTitles: [],
        }
      : EMPTY_HIGHLIGHT

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {/* Same pill banner style as Degree/Career "Advising based on your profile" */}
      {(contextBannerMain || confidenceWarning) ? (
        <div className="flex-shrink-0 space-y-2 px-1 pb-3 pt-1">
          {contextBannerMain ? (
            <div
              className="rounded-2xl px-3 py-2 text-xs font-semibold backdrop-blur"
              style={{
                backgroundColor: 'color-mix(in oklab, var(--surface) 70%, transparent 30%)',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
              }}
            >
              {contextBannerMain}
            </div>
          ) : null}
          {confidenceWarning ? (
            <div className="rounded-xl px-3 py-2 text-[11px] font-medium backdrop-blur" style={{ border: '1px solid color-mix(in oklab, #f59e0b 40%, var(--border) 60%)', background: 'color-mix(in oklab, #f59e0b 08%, var(--surface) 92%)', color: 'var(--text-muted)' }}>
              ⚠ {confidenceWarning}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto py-2">
        <div className="space-y-4 px-1">
          {messages.map((msg, i) => {
            const dashMsg: DashboardChatMessage = {
              role: msg.role,
              content: msg.content,
              ts: i,
            }
            return (
              <div key={i}>
                <ChatBubble
                  message={dashMsg}
                  accentClass={ACCENT_SKILLS_GAP}
                  highlightCatalog={responseHighlightCatalog}
                />
                {msg.role === 'assistant' && msg.isAnalysis && analysis != null ? (
                  <div className="mt-3 flex justify-start pl-1">
                    <button
                      type="button"
                      onClick={() => setShowDashboard(true)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 14px',
                        background: 'color-mix(in oklab, var(--accent) 12%, var(--surface) 88%)',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        color: 'var(--text)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      <LayoutDashboard size={16} aria-hidden />
                      View visual dashboard
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}

          {isLoading ? (
            <ChatBubble
              message={{ role: 'assistant', content: 'Thinking…', ts: messages.length }}
              accentClass={ACCENT_SKILLS_GAP}
              highlightCatalog={responseHighlightCatalog}
            />
          ) : null}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* InputBar: `footerVariant="flush"` drops the tinted footer strip so only one pill shows inside the panel */}
      <InputBar
        value={inputText}
        onChange={setInputText}
        onSend={() => void sendFollowUp()}
        disabled={isLoading}
        placeholder="Ask anything.."
        footerVariant="flush"
        leadingButton={
          <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setShowMenu(!showMenu)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl transition-colors"
              style={{
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}
              title="More actions"
            >
              <span aria-hidden style={{ fontSize: 17, letterSpacing: 0 }}>
                ⋯
              </span>
            </button>
            {showMenu ? (
              <div
                className="flex flex-col gap-2"
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: 0,
                  marginBottom: 8,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: 8,
                  zIndex: 100,
                  minWidth: 208,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setShowDashboard(true);
                    setShowMenu(false);
                  }}
                  disabled={!analysis}
                  className={[
                    'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[13px] font-medium transition-colors',
                    analysis
                      ? 'cursor-pointer border-[var(--border)] bg-[var(--surface2)] text-[var(--text)] hover:bg-[color-mix(in_oklab,var(--text-muted)_14%,var(--surface2)_86%)] active:bg-[color-mix(in_oklab,var(--text-muted)_22%,var(--surface2)_78%)]'
                      : 'cursor-not-allowed border-[var(--border)] bg-[var(--surface2)] text-[var(--text-muted)] opacity-60',
                  ].join(' ')}
                >
                  <LayoutDashboard size={18} aria-hidden className="shrink-0" />
                  View Analysis
                </button>
                <button
                  type="button"
                  onClick={openAnotherJdModal}
                  disabled={!resumeFile}
                  className={[
                    'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[13px] font-medium transition-colors',
                    resumeFile
                      ? 'cursor-pointer border-[var(--border)] bg-[var(--surface2)] text-[var(--text)] hover:bg-[color-mix(in_oklab,var(--text-muted)_14%,var(--surface2)_86%)] active:bg-[color-mix(in_oklab,var(--text-muted)_22%,var(--surface2)_78%)]'
                      : 'cursor-not-allowed border-[var(--border)] bg-[var(--surface2)] text-[var(--text-muted)] opacity-60',
                  ].join(' ')}
                >
                  <PlusCircle size={18} aria-hidden className="shrink-0" />
                  Upload another JD
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    setMessages([]);
                    setAnalysis(null);
                    setConversationHistory([]);
                    setJdText('');
                    setSelectedRole('');
                    setConfidenceWarning('');
                    fileInputRef.current?.click();
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-left text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[color-mix(in_oklab,var(--text-muted)_14%,var(--surface2)_86%)] active:bg-[color-mix(in_oklab,var(--text-muted)_22%,var(--surface2)_78%)]"
                >
                  <Paperclip size={18} aria-hidden className="shrink-0" />
                  Upload new resume
                </button>
              </div>
            ) : null}
          </div>
        }
      />

      {showDashboard && analysis && (
        <DashboardPanel analysis={analysis} onClose={() => setShowDashboard(false)} />
      )}

      {showJdModal ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 75,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setShowJdModal(false)}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.4)',
              backdropFilter: 'blur(2px)',
              animation: 'fadeJdBackdrop 180ms ease',
            }}
          />
          <style>{`
            @keyframes fadeJdBackdrop { from { opacity: 0; } to { opacity: 1; } }
            @keyframes popJdModal { from { transform: translateY(8px) scale(0.985); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
          `}</style>
          <div
            style={{
              position: 'relative',
              width: '100%',
              maxWidth: 560,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 16,
              boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
              overflow: 'hidden',
              animation: 'popJdModal 200ms ease',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: '14px 16px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ color: 'var(--text)', fontSize: 14, fontWeight: 700 }}>Upload another JD</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                  Reusing resume: {resumeName || 'Current resume'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowJdModal(false)}
                style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: 10, width: 32, height: 32, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: 16 }}>
              <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 3 }}>
                {(['paste', 'select'] as JdMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setJdMode(mode)}
                    style={{
                      flex: 1,
                      padding: '8px 0',
                      borderRadius: 6,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 600,
                      background: jdMode === mode ? '#e8650a' : 'transparent',
                      color: jdMode === mode ? '#fff' : '#9999bb',
                      transition: 'all 0.2s',
                    }}
                  >
                    {mode === 'paste' ? 'Paste a Job Description' : 'Select a Role'}
                  </button>
                ))}
              </div>

              {jdMode === 'paste' ? (
                <textarea
                  value={jdText}
                  onChange={(e) => setJdText(e.target.value)}
                  placeholder="Paste the full job description here..."
                  style={{
                    width: '100%',
                    minHeight: 180,
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    color: 'var(--text)',
                    fontSize: 13,
                    padding: '12px 14px',
                    resize: 'vertical',
                    outline: 'none',
                    boxSizing: 'border-box',
                    lineHeight: 1.6,
                  }}
                />
              ) : (
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    color: selectedRole ? 'var(--text)' : 'var(--text-muted)',
                    fontSize: 13,
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <option value="" disabled style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}>Choose a role...</option>
                  {JOB_ROLES.map((r) => (
                    <option key={r} value={r} style={{ background: 'var(--surface)', color: 'var(--text)' }}>{r}</option>
                  ))}
                </select>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => setShowJdModal(false)}
                  style={{
                    flex: 1,
                    padding: '10px 0',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--surface2)',
                    color: 'var(--text)',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setShowJdModal(false);
                    await runAnalysis();
                  }}
                  disabled={!((jdMode === 'paste' && jdText.trim().length > 30) || (jdMode === 'select' && !!selectedRole))}
                  style={{
                    flex: 1,
                    padding: '10px 0',
                    borderRadius: 8,
                    border: 'none',
                    background: 'linear-gradient(90deg, #ff4d4d 0%, #ff7a1a 55%, #ff9a33 100%)',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    opacity: ((jdMode === 'paste' && jdText.trim().length > 30) || (jdMode === 'select' && !!selectedRole)) ? 1 : 0.5,
                  }}
                >
                  Analyze with this JD
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            handleFileSelect(f);
            setPhase('resume_uploaded');
            setMessages([]);
            setAnalysis(null);
            setConversationHistory([]);
          }
        }}
      />
    </div>
  );
}
