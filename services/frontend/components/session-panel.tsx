"use client";

import { useEffect, useState } from "react";

import {
  clearStoredSession,
  getSessionEventName,
  getStoredSession,
  type FrontendSession
} from "../lib/session";

export function useFrontendSession() {
  const [session, setSession] = useState<FrontendSession | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const syncSession = () => {
      setSession(getStoredSession());
      setIsReady(true);
    };

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === "quiz-app-frontend-session") {
        syncSession();
      }
    };

    const handleSessionExpired = () => {
      clearStoredSession();
      syncSession();
    };

    syncSession();
    window.addEventListener("storage", handleStorage);
    window.addEventListener(getSessionEventName(), syncSession);
    window.addEventListener("quiz-app-session-expired", handleSessionExpired);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(getSessionEventName(), syncSession);
      window.removeEventListener("quiz-app-session-expired", handleSessionExpired);
    };
  }, []);

  return { session, setSession, isReady };
}
