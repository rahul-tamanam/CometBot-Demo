import axios from 'axios'
import {
  careerMentorNetworkFallback,
  degreePlannerNetworkFallback,
  skillsGapNetworkFallback,
} from '@/lib/demoMessages'

export const API_BASE =
  (typeof import.meta.env.VITE_API_BASE === 'string' &&
    import.meta.env.VITE_API_BASE.replace(/\/$/, '')) ||
  'http://localhost:8000/api'

const BASE = API_BASE

export interface Message {
  role:    'user' | 'assistant'
  content: string
}

// ── Degree Planner ────────────────────────────────────────────────────────────

export interface DegreePlannerRequest {
  message:              string
  completed_courses:    string[]
  conversation_history: Message[]
  student_type?:        'new' | 'current'
  interests?:           string[]
  course_history?:      { course: string; semester: string }[]
  program_id?:          string
}

export interface CourseCard {
  course_id:         string
  title:             string
  course_type:       'Core' | 'Elective'
  credits:           number
  is_completed:      boolean
  prerequisites_met: boolean
}

export interface SemesterBlock {
  label:   string
  courses: CourseCard[]
}

export interface ProgressData {
  core_completed_credits:     number
  core_remaining_credits:     number
  core_completed_count:       number
  core_remaining_count:       number
  elective_completed_credits: number
  elective_remaining_credits: number
  elective_completed_count:   number
  elective_remaining_count:   number
  total_completed_credits:    number
  total_remaining_credits:    number
  total_completed_count:      number
  total_remaining_count:      number
  percent_complete:           number
}

export interface DegreePlannerResponse {
  narrative:           string
  progress:            ProgressData
  recommended_courses: CourseCard[]
  semester_plan:       SemesterBlock[]
  remaining_core:      CourseCard[]
  remaining_elective:  CourseCard[]
  choice_group_notes:  string[]
  invalid_courses:     string[]
  corrections:         any[]
}

const emptyProgress = (): ProgressData => ({
  core_completed_credits: 0,
  core_remaining_credits: 0,
  core_completed_count: 0,
  core_remaining_count: 0,
  elective_completed_credits: 0,
  elective_remaining_credits: 0,
  elective_completed_count: 0,
  elective_remaining_count: 0,
  total_completed_credits: 0,
  total_remaining_credits: 0,
  total_completed_count: 0,
  total_remaining_count: 0,
  percent_complete: 0,
})

export const degreePlannerChat = async (
  data: DegreePlannerRequest
): Promise<DegreePlannerResponse> => {
  try {
    const res = await axios.post(`${BASE}/degree-planner/chat`, data)
    return res.data
  } catch {
    return {
      narrative: degreePlannerNetworkFallback,
      progress: emptyProgress(),
      recommended_courses: [],
      semester_plan: [],
      remaining_core: [],
      remaining_elective: [],
      choice_group_notes: [],
      invalid_courses: [],
      corrections: [],
    }
  }
}

export interface DegreePlannerPlanRequest {
  completed_courses:    string[]
  courses_per_semester?: number
  max_semesters?:        number
  core_per_semester?:    number | null
  elective_per_semester?: number | null
  interests?:            string[]
  course_history?:       { course: string; semester: string }[]
  program_id?:           string
}

export interface DegreePlannerPlanResponse {
  plan: { semester: number; courses: { course_id: string; title: string; course_type: string }[] }[]
  warnings: string[]
  progress: {
    total_completed: number
    core_completed: number
    elective_completed: number
    total_remaining: number
    core_remaining: number
    elective_remaining: number
    percent_complete: number
  }
  invalid_courses: any[]
  next_semester_label?: string | null
  semester_headings?:   string[]
}

export const degreePlannerPlan = async (
  data: DegreePlannerPlanRequest
): Promise<DegreePlannerPlanResponse> => {
  const res = await axios.post(`${BASE}/degree-planner/plan`, data)
  return res.data
}

export interface HighlightCourse {
  course_id: string
  title: string
}

export interface HighlightCertificate {
  cert_title: string
}

export const getHighlightCourses = async (program_id = 'msba'): Promise<HighlightCourse[]> => {
  const res = await axios.get(`${BASE}/courses`, { params: { program_id } })
  return res.data
}

export const getHighlightCertificates = async (program_id = 'msba'): Promise<HighlightCertificate[]> => {
  const res = await axios.get(`${BASE}/certificates`, { params: { program_id } })
  return res.data
}

// ── Career Mentor ─────────────────────────────────────────────────────────────

export interface CareerMentorRequest {
  message:              string
  conversation_history: Message[]
  completed_courses?:   string[]
  student_type?:        'new' | 'current'
  course_history?:      { course: string; semester: string }[]
  program_id?:          string
}

export interface CareerMentorCertificate {
  cert_title: string
  total_credits: number
  overview: string
  course_id: string[][]
  skills_taught: string[]
  completed_courses_for_certificate: string[]
  remaining_course_groups: string[][]
  remaining_course_count: number
  is_eligible_now: boolean
}

export interface CareerMentorResponse {
  response:    string
  corrections: any[]
  removed:     any[]
  job_role:    {
    job_title:        string
    technical_skills: string[]
    soft_skills:      string[]
    score:            number
  } | null
  matched_certificates: CareerMentorCertificate[]
  valid_completed_courses?: string[]
  invalid_profile_courses?: any[]
}

export const careerMentorChat = async (
  data: CareerMentorRequest
): Promise<CareerMentorResponse> => {
  try {
    const res = await axios.post(`${BASE}/career-mentor/chat`, data)
    return res.data
  } catch {
    return {
      response: careerMentorNetworkFallback,
      corrections: [],
      removed: [],
      job_role: null,
      matched_certificates: [],
    }
  }
}

// ── Skills Gap ────────────────────────────────────────────────────────────────

export interface SkillsGapRequest {
  completed_courses:    string[]
  target_job:           string
  conversation_history: Message[]
  message:              string
  job_description?:     string
  program_id?:          string
}

export interface SkillsGapResponse {
  response:           string
  corrections:        any[]
  removed:            any[]
  job_role:           any
  confidence_warning: string | null
  gap: {
    matched:           { skill: string; type: string }[]
    missing_technical: string[]
    missing_soft:      string[]
  }
  recommendations:    Record<string, { course_id: string; title: string }[]>
  student_skills:     string[]
  invalid_courses:    any[]
  /** Present for resume upload when structured LLM parse failed but keyword fallback ran */
  resume_parse_note?: string | null
  resume_data?:      Record<string, unknown>
}

export const skillsGapAnalyze = async (
  data: SkillsGapRequest
): Promise<SkillsGapResponse> => {
  try {
    const res = await axios.post(`${BASE}/skills-gap/analyze`, data)
    return res.data
  } catch {
    return {
      response: skillsGapNetworkFallback,
      corrections: [],
      removed: [],
      job_role: null,
      confidence_warning: null,
      gap: { matched: [], missing_technical: [], missing_soft: [] },
      recommendations: {},
      student_skills: [],
      invalid_courses: [],
    }
  }
}
// ── Skills Gap — resume upload ────────────────────────────────────────────────

export const skillsGapAnalyzeResume = async (
  file:           File,
  targetJob:      string,
  jobDescription: string,
  programId:      string = 'msba'
): Promise<SkillsGapResponse> => {
  const form = new FormData()
  form.append('file',            file)
  form.append('target_job',      targetJob)
  form.append('job_description', jobDescription)
  form.append('program_id',      programId)

  // Let axios set multipart boundary automatically — a manual Content-Type breaks uploads.
  try {
    const res = await axios.post(`${BASE}/skills-gap/analyze-resume`, form)
    return res.data
  } catch {
    return {
      response: skillsGapNetworkFallback,
      corrections: [],
      removed: [],
      job_role: null,
      confidence_warning: null,
      gap: { matched: [], missing_technical: [], missing_soft: [] },
      recommendations: {},
      student_skills: [],
      invalid_courses: [],
    }
  }
}