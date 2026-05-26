import { CometDashboard } from '@/components/dashboard/CometDashboard'
import OnboardingPage from '@/pages/OnboardingPage'
import { useProfile } from '@/hooks/useProfile'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'

const ONBOARDING_COMPLETE_KEY = 'cometbot_onboarding_complete'

export function isOnboardingComplete() {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Step 1–N: current/prospective landing → program → transcript → confirm courses */
function OnboardingRoute() {
  if (isOnboardingComplete()) {
    return <Navigate to="/chat" replace />
  }
  return <OnboardingPage />
}

/** Step final: CometBot dashboard (degree / career / skills gap) */
function ChatRoute() {
  const { profile, completedCourses } = useProfile()
  const [visible, setVisible] = useState(false)

  const mustFinishOnboarding = useMemo(() => {
    if (isOnboardingComplete()) return false
    return completedCourses.length === 0 && profile.semesters.length === 0
  }, [completedCourses.length, profile.semesters.length])

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setVisible(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  if (mustFinishOnboarding) {
    return <Navigate to="/" replace />
  }

  return (
    <div
      className="transition-all duration-500 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
      }}
    >
      <CometDashboard />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      {/* Landing: Meet CometBot + current / prospective */}
      <Route path="/" element={<OnboardingRoute />} />
      <Route path="/onboarding" element={<OnboardingRoute />} />
      {/* Chatbot after onboarding */}
      <Route path="/chat" element={<ChatRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
