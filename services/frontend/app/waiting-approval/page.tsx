"use client";

import { Suspense } from "react";

import { SiteShell } from "../../components/site-shell";
import { useFrontendSession } from "../../components/session-panel";

function WaitingApprovalContent() {
  const { session, isReady } = useFrontendSession();

  return (
    <SiteShell title="" subtitle="">
      {!isReady ? <div className="notice">Loading approval state...</div> : null}
      {session ? (
        <section />
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
        <SiteShell title="" subtitle="">
          <div className="notice">Loading...</div>
        </SiteShell>
      }
    >
      <WaitingApprovalContent />
    </Suspense>
  );
}
