"use client";

import { Suspense } from "react";

import { SiteShell } from "../../components/site-shell";
import { useFrontendSession } from "../../components/session-panel";

function WaitingApprovalContent() {
  const { session, isReady } = useFrontendSession();

  return (
    <SiteShell
      title="Waiting For Approval"
      subtitle="Your Google account is verified. An administrator must approve your organization access before quiz features unlock."
    >
      {!isReady ? <div className="notice">Loading approval state...</div> : null}
      {session ? (
        <section className="approval-layout">
          <div className="card dashboard-card approval-status-card">
            <span className="chip chip--soft">Approval queue</span>
            <h2 className="approval-status-card__title">Your access request is being reviewed.</h2>
            <p className="approval-status-card__copy">
              Signed in as <span className="mono">{session.email}</span>. Current status:
              <span className="mono"> {session.userStatus ?? "pending"}</span>.
            </p>

            <div className="approval-status-card__timeline">
              <article className="approval-step approval-step--done">
                <span>1</span>
                <div>
                  <strong>Google account verified</strong>
                  <p>Your identity was confirmed successfully.</p>
                </div>
              </article>
              <article className="approval-step approval-step--done">
                <span>2</span>
                <div>
                  <strong>Organization request submitted</strong>
                  <p>Your membership request is in the tenant approval queue.</p>
                </div>
              </article>
              <article className="approval-step approval-step--active">
                <span>3</span>
                <div>
                  <strong>Awaiting admin approval</strong>
                  <p>An organization admin or super admin needs to assign your role.</p>
                </div>
              </article>
            </div>
          </div>

          <div className="card dashboard-card approval-help-card">
            <div className="eyebrow">What happens next</div>
            <div className="approval-help-card__list">
              <div>
                <strong>Admins review your employee ID</strong>
                <p>Approvers verify your organization and assign either player or admin access.</p>
              </div>
              <div>
                <strong>Access stays tenant-scoped</strong>
                <p>You only see the data and contests for the organization you requested.</p>
              </div>
              <div>
                <strong>Return after approval</strong>
                <p>Once approved, refresh your session to enter the correct workspace automatically.</p>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <div className="notice error">No session found. Sign in again.</div>
      )}
    </SiteShell>
  );
}

export default function WaitingApprovalPage() {
  return (
    <Suspense
      fallback={
        <SiteShell title="Waiting For Approval" subtitle="Loading approval status...">
          <div className="notice">Loading...</div>
        </SiteShell>
      }
    >
      <WaitingApprovalContent />
    </Suspense>
  );
}
