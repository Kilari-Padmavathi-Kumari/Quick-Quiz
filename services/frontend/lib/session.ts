export interface FrontendSession {
  accessToken: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  userId: string;
  isAdmin: boolean;
  expiresAt: number | null;
}

const SESSION_KEY = "quiz-app-frontend-session";
const SESSION_EVENT = "quiz-app-session-change";

function decodeJwtPayload(token: string) {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return null;
    }

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return JSON.parse(decoded) as { exp?: number };
  } catch {
    return null;
  }
}

function emitSessionChange() {
  window.dispatchEvent(new Event(SESSION_EVENT));
}

export function getStoredSession(): FrontendSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as FrontendSession;

    if (parsed.expiresAt && parsed.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(SESSION_KEY);
      return null;
    }

    return parsed;
  } catch {
    window.sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function setStoredSession(session: FrontendSession) {
  const nextSession = {
    ...session,
    expiresAt: session.expiresAt ?? getTokenExpiry(session.accessToken)
  };

  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
  emitSessionChange();
}

export function clearStoredSession() {
  window.sessionStorage.removeItem(SESSION_KEY);
  emitSessionChange();
}

export function getTokenExpiry(accessToken: string) {
  const payload = decodeJwtPayload(accessToken);
  return payload?.exp ? payload.exp * 1000 : null;
}

export function updateStoredAccessToken(accessToken: string) {
  const session = getStoredSession();
  if (!session) {
    return null;
  }

  const nextSession = {
    ...session,
    accessToken,
    expiresAt: getTokenExpiry(accessToken)
  };

  setStoredSession(nextSession);
  return nextSession;
}

export function getSessionEventName() {
  return SESSION_EVENT;
}
