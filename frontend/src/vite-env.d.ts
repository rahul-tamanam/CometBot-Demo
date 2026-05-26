/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL (e.g. http://localhost:8000/api). */
  readonly VITE_API_BASE?: string
  /**
   * Optional FastAPI transcript URL. Onboarding uses client-side pdf.js by default
   * (same as local dev without this set). Set VITE_TRANSCRIPTPARSER_PREFER_SERVER=true
   * to try this endpoint first on upload.
   */
  readonly VITE_TRANSCRIPTPARSER_API?: string
  readonly VITE_TRANSCRIPTPARSER_PREFER_SERVER?: string
}

declare module '*?url' {
  const src: string
  export default src
}
