"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { SiteShell } from "../../../components/site-shell";
import { getAuthMe, lookupOrganization } from "../../../lib/api";
import { getTokenExpiry, setStoredSession } from "../../../lib/session";
import { API_URL } from "../../../lib/config";
import {
  clearStoredOrganizationIdentity,
  isValidOrganizationId,
  storeOrganizationIdentity
} from "../../../lib/tenant";

function AuthCallbackContent() {
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
        clearStoredOrganizationIdentity();

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
        const body = await getAuthMe(accessToken);
        const role = body.access.role;
        const onboardingStatus = body.access.onboarding_status;
        const organizationId = body.user.organization_id;

        let organizationSlug: string | null = null;
        let organizationName: string | null = null;

        if (isValidOrganizationId(organizationId) && organizationId !== "00000000-0000-0000-0000-000000000000") {
          const organizationResult = await lookupOrganization({ id: organizationId });
          organizationSlug = organizationResult.organization.slug;
          organizationName = organizationResult.organization.name;
          storeOrganizationIdentity({
            id: organizationId,
            slug: organizationSlug,
            name: organizationName
          });
        }

        setStoredSession({
          accessToken,
          organizationId,
          organizationSlug,
          organizationName,
          email: body.user.email,
          name: body.user.name,
          avatarUrl: body.user.avatar_url,
          userId: body.user.id,
          isAdmin: body.user.is_admin,
          role,
          userStatus: body.user.user_status,
          expiresAt: getTokenExpiry(accessToken)
        });

        const target =
          role === "super_admin"
            ? "/super-admin"
            : onboardingStatus === "pending"
              ? "/join-organization"
              : onboardingStatus === "rejected"
                ? "/waiting-approval"
                : role === "organization_admin"
                  ? "/admin"
                  : nextPath;

        router.replace(target);
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

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <SiteShell title="Signing you in" subtitle="Completing Google OAuth login and preparing your session.">
          <div className="notice">Completing Google login...</div>
        </SiteShell>
      }
    >
      <AuthCallbackContent />
    </Suspense>
  );
}
