/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL (e.g. http://localhost:8000/api). */
  readonly VITE_API_BASE?: string
  /** FastAPI transcript parser (base64 PDF). When unset, onboarding uses client-side pdf.js parsing. */
  readonly VITE_TRANSCRIPTPARSER_API?: string
}

declare module '*?url' {
  const src: string
  export default src
}
