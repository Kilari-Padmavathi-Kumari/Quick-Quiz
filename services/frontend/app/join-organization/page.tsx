"use client";

import { Suspense } from "react";
import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";

import { SiteShell } from "../../components/site-shell";
import { useFrontendSession } from "../../components/session-panel";
import { joinOrganization } from "../../lib/api";
import { clearStoredOrganizationIdentity, storeOrganizationIdentity } from "../../lib/tenant";

function JoinOrganizationContent() {
  const router = useRouter();
  const { session, isReady } = useFrontendSession();
  const [organization, setOrganization] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isReady) {
    return (
      <SiteShell title="Join Organization" subtitle="Loading session...">
        <div className="notice">Preparing onboarding...</div>
      </SiteShell>
    );
  }

  if (!session) {
    return (
      <SiteShell title="Join Organization" subtitle="Sign in with Google first.">
        <div className="notice error">No active session found.</div>
      </SiteShell>
    );
  }

  if (session.role === "super_admin") {
    return (
      <SiteShell title="Join Organization" subtitle="Super admins use the global control panel only.">
        <div className="notice">This account is routed through the super-admin workspace.</div>
      </SiteShell>
    );
  }

  return (
    <SiteShell
      title="Join Organization"
      subtitle="Search your organization, add your employee ID, and submit the approval request."
    >
      <section className="onboarding-grid">
        <div className="onboarding-intro card dashboard-card">
          <span className="chip chip--soft">Organization access</span>
          <h2 className="onboarding-intro__title">Tell us which workspace you belong to.</h2>
          <p className="onboarding-intro__copy">
            Enter your organization slug and employee ID so the right admin team can review your request.
          </p>

          <div className="onboarding-steps">
            <article className="onboarding-step">
              <span>1</span>
              <div>
                <strong>Find your organization</strong>
                <p>Use the organization slug your company shares internally.</p>
              </div>
            </article>
            <article className="onboarding-step">
              <span>2</span>
              <div>
                <strong>Add employee identity</strong>
                <p>Submit the employee ID used by your organization for approvals.</p>
              </div>
            </article>
            <article className="onboarding-step">
              <span>3</span>
              <div>
                <strong>Wait for access</strong>
                <p>Once approved, your dashboard unlocks automatically with the correct role.</p>
              </div>
            </article>
          </div>
        </div>

        <div className="card dashboard-card onboarding-form-card">
          <div className="eyebrow">Access request</div>
          <h3 className="onboarding-form-card__title">Request tenant membership</h3>
          <p className="muted onboarding-form-card__copy">
            Signed in as <span className="mono">{session.email}</span>
          </p>

          <label className="field">
            <span>Organization Slug</span>
            <input value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="fission-labs" />
          </label>
          <label className="field">
            <span>Employee ID</span>
            <input value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} placeholder="EMP-1024" />
          </label>
          {message ? <div className="notice success">{message}</div> : null}
          {error ? <div className="notice error">{error}</div> : null}
          <button
            type="button"
            className="solid-button"
            disabled={isSubmitting || !organization.trim() || !employeeId.trim()}
            onClick={() => {
              setMessage(null);
              setError(null);
              setIsSubmitting(true);

            startTransition(async () => {
              try {
                clearStoredOrganizationIdentity();

                const result = await joinOrganization(session.accessToken, {
                  organization,
                  employee_id: employeeId
                });

                  storeOrganizationIdentity({
                    id: result.membership.organization.id,
                    slug: result.membership.organization.slug,
                    name: result.membership.organization.name
                  });
                  setMessage("Request submitted. Waiting for approval.");
                  router.push("/waiting-approval");
                  router.refresh();
                } catch (joinError) {
                  setError(joinError instanceof Error ? joinError.message : "Failed to join organization");
                } finally {
                  setIsSubmitting(false);
                }
              });
            }}
          >
            {isSubmitting ? "Submitting..." : "Request Access"}
          </button>
        </div>
      </section>
    </SiteShell>
  );
}

export default function JoinOrganizationPage() {
  return (
    <Suspense
      fallback={
        <SiteShell title="Join Organization" subtitle="Loading organization onboarding...">
          <div className="notice">Loading...</div>
        </SiteShell>
      }
    >
      <JoinOrganizationContent />
    </Suspense>
  );
}
