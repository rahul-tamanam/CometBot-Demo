/** Demo build: no institutional login; session flag kept for optional future use. */
const AUTH_STORAGE_KEY = 'cometbot_auth'

export function isAuthenticated() {
  return true
}

export function useAuth() {
  return { isAuthenticated: true }
}

export function signIn(_userId: string, _password: string) {
  try {
    sessionStorage.setItem(AUTH_STORAGE_KEY, 'true')
  } catch {
    // ignore
  }
  return true
}

export function signOut() {
  try {
    sessionStorage.removeItem(AUTH_STORAGE_KEY)
  } catch {
    // ignore
  }
}
