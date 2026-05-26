/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL (e.g. http://localhost:8000/api). */
  readonly VITE_API_BASE?: string
  /** Optional FastAPI transcript POST URL (e.g. http://127.0.0.1:8000/api/parse-transcript). */
  readonly VITE_TRANSCRIPTPARSER_API?: string
}

declare module '*?url' {
  const src: string
  export default src
}
