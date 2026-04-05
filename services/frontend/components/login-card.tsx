"use client";

import { startTransition, useState } from "react";

import { API_URL } from "../lib/config";
import { lookupOrganization, OrganizationLookupError } from "../lib/api";
import {
  normalizeOrganizationSlugInput,
  storeOrganizationIdentity,
  storeOrganizationSlug
} from "../lib/tenant";

type LoginCardProps = {
  targetHref?: string;
  adminShortcut?: boolean;
};

export function LoginCard({ targetHref = "/dashboard" }: LoginCardProps) {
  const [isPending, setIsPending] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string; slug: string }>>([]);

  function continueWithGoogle() {
    const normalizedSlug = normalizeOrganizationSlugInput(organizationName);

    if (!normalizedSlug) {
      setTenantError("Enter your organization name first.");
      return;
    }

    setTenantError(null);
    setSuggestions([]);
    setIsPending(true);

    startTransition(async () => {
      try {
        const organizationLookup = await lookupOrganization({ name: organizationName });
        storeOrganizationIdentity({
          id: organizationLookup.organization.id,
          slug: organizationLookup.organization.slug,
          name: organizationLookup.organization.name
        });

        const googleUrl = new URL(`${API_URL}/auth/google`);
        const nextPath = new URL(targetHref, window.location.origin);
        nextPath.searchParams.set("organization", organizationLookup.organization.slug);
        googleUrl.searchParams.set("redirect_to", `${nextPath.pathname}${nextPath.search}${nextPath.hash}`);
        googleUrl.searchParams.set("organization", organizationLookup.organization.slug);
        window.location.assign(googleUrl.toString());
      } catch (error) {
        if (error instanceof OrganizationLookupError) {
          setTenantError(
            error.suggestions.length > 0
              ? `Organization not found. Did you mean one of these?`
              : `Organization not found for "${organizationName}".`
          );
          setSuggestions(error.suggestions);
        } else {
          setTenantError(error instanceof Error ? error.message : "Organization lookup failed.");
        }
        setIsPending(false);
      }
    });
  }

  return (
    <div className="auth-card auth-card--premium">
      <div className="auth-card__top">
        <span className="chip">Login</span>
        <span className="auth-card__spark">Continue with Google</span>
      </div>

      <h2 className="card-title">Sign in to your organization</h2>
      <p className="auth-card__copy">
        Enter your organization in any format and continue with Google.
      </p>
      <label className="field" style={{ marginTop: 18 }}>
        <span>Organization Name</span>
        <input
          value={organizationName}
          name="quiz-organization-name"
          onChange={(event) => {
            setOrganizationName(event.target.value);
            if (tenantError) {
              setTenantError(null);
            }
            if (suggestions.length > 0) {
              setSuggestions([]);
            }
          }}
          placeholder="Fission Labs / fission-labs / fissionlabs"
          autoComplete="new-password"
          data-lpignore="true"
          data-form-type="other"
          spellCheck={false}
        />
      </label>
      {tenantError ? <div className="notice error" style={{ marginTop: 12 }}>{tenantError}</div> : null}
      {suggestions.length > 0 ? (
        <div className="notice" style={{ marginTop: 12 }}>
          {suggestions.map((organization) => (
            <button
              key={organization.id}
              type="button"
              className="ghost-button"
              style={{ marginTop: 8, width: "100%" }}
              onClick={() => {
                setOrganizationName(organization.name);
                storeOrganizationSlug(organization.slug);
                setSuggestions([]);
                setTenantError(null);
              }}
            >
              {organization.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="auth-google-block">
        <div className="auth-google-block__label">Sign in</div>
        <button
          className="ghost-button auth-card__ghost auth-card__google-cta"
          type="button"
          disabled={isPending || !normalizeOrganizationSlugInput(organizationName)}
          onClick={continueWithGoogle}
          style={{ width: "100%" }}
        >
          {isPending ? (
            "Redirecting to Google..."
          ) : (
            <>
              <span className="auth-card__google-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" className="auth-card__google-svg" focusable="false" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M12.24 10.285v3.821h5.445c-.24 1.285-.96 2.373-2.045 3.101l3.307 2.565c1.928-1.777 3.043-4.395 3.043-7.487 0-.728-.066-1.429-.188-2.108H12.24z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 22c2.76 0 5.077-.913 6.769-2.47l-3.307-2.565c-.913.613-2.08.975-3.462.975-2.661 0-4.917-1.797-5.723-4.215H2.86v2.644A9.997 9.997 0 0 0 12 22z"
                  />
                  <path
                    fill="#4A90E2"
                    d="M6.277 13.725A5.997 5.997 0 0 1 5.957 12c0-.6.108-1.183.32-1.725V7.631H2.86A9.997 9.997 0 0 0 2 12c0 1.61.385 3.135 1.06 4.369l3.217-2.644z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M12 6.06c1.5 0 2.847.517 3.909 1.533l2.933-2.933C17.072 3.01 14.755 2 12 2A9.997 9.997 0 0 0 2.86 7.631l3.417 2.644C7.083 7.857 9.339 6.06 12 6.06z"
                  />
                </svg>
              </span>
              <span>Continue with Google</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
