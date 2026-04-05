"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { SiteShell } from "../../../components/site-shell";
import { lookupOrganization } from "../../../lib/api";
import { getTokenExpiry, setStoredSession } from "../../../lib/session";
import { API_URL } from "../../../lib/config";
import { isValidOrganizationId } from "../../../lib/tenant";

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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

    void (async () => {
      try {
        const refreshResponse = await fetch(`${API_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          cache: "no-store"
        });

        if (!refreshResponse.ok) {
          throw new Error("Failed to establish session after Google login.");
        }

        const refreshBody = (await refreshResponse.json()) as { access_token: string };
        const accessToken = refreshBody.access_token;
        const payload = accessToken.split(".")[1];
        if (!payload) {
          throw new Error("Access token is missing organization context.");
        }

        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
        const parsed = JSON.parse(decoded) as { organization_id?: string };

        if (!parsed.organization_id || !isValidOrganizationId(parsed.organization_id)) {
          throw new Error("Access token organization is missing.");
        }

        const organizationResult = await lookupOrganization({ id: parsed.organization_id });

        const response = await fetch(`${API_URL}/auth/me`, {
          headers: {
            authorization: `Bearer ${accessToken}`
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
          organizationId: parsed.organization_id,
          organizationSlug: organizationResult.organization.slug,
          organizationName: organizationResult.organization.name,
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
