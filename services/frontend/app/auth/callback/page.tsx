"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { SiteShell } from "../../../components/site-shell";
import { getTokenExpiry, setStoredSession } from "../../../lib/session";
import { API_URL, DEFAULT_ORGANIZATION_ID } from "../../../lib/config";

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const accessToken = searchParams.get("access_token");
    const rawNext = searchParams.get("next") || "/dashboard";
    let nextPath = "/dashboard";

    try {
      nextPath = rawNext.startsWith("http")
        ? (() => {
            const parsed = new URL(rawNext);
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
          })()
        : rawNext;
    } catch {
      nextPath = "/dashboard";
    }

    if (!accessToken) {
      setError("Missing access token after Google login.");
      return;
    }

    void (async () => {
      try {
        const resolveOrganizationId = (token: string) => {
          try {
            const payload = token.split(".")[1];
            if (!payload) {
              return DEFAULT_ORGANIZATION_ID;
            }

            const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
            const decoded = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
            const parsed = JSON.parse(decoded) as { organization_id?: string };
            return parsed.organization_id ?? DEFAULT_ORGANIZATION_ID;
          } catch {
            return DEFAULT_ORGANIZATION_ID;
          }
        };

        const response = await fetch(`${API_URL}/auth/me`, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "x-organization-id": resolveOrganizationId(accessToken)
          },
          credentials: "include",
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error("Failed to load signed-in user from API.");
        }

        const body = (await response.json()) as {
          user: {
            id: string;
            email: string;
            name: string;
            avatar_url: string | null;
            is_admin: boolean;
          };
        };

        setStoredSession({
          accessToken,
          email: body.user.email,
          name: body.user.name,
          avatarUrl: body.user.avatar_url,
          userId: body.user.id,
          isAdmin: body.user.is_admin,
          expiresAt: getTokenExpiry(accessToken)
        });

        router.replace(nextPath);
        router.refresh();
      } catch (callbackError) {
        setError(callbackError instanceof Error ? callbackError.message : "Google login failed.");
      }
    })();
  }, [router, searchParams]);

  return (
    <SiteShell title="Signing you in" subtitle="Completing Google OAuth login and preparing your session.">
      {error ? <div className="notice error">{error}</div> : <div className="notice">Completing Google login...</div>}
    </SiteShell>
  );
}
