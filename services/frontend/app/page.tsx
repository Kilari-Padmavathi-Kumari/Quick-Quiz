import { LoginCard } from "../components/login-card";

const platformSignals = [
  { label: "Tenants", value: "Multi-org", detail: "Strict organization isolation with role-aware access." },
  { label: "Access", value: "Google SSO", detail: "Single entry point for admins, players, and super admins." },
  { label: "Operations", value: "Real-time", detail: "Contest workflows, approvals, and activity in one SaaS surface." }
];

const platformHighlights = [
  "Global super-admin governance without tenant dashboard crossover",
  "Organization onboarding with approval-driven membership activation",
  "Clean workspaces for admins, players, and operations teams"
];

export default async function HomePage({
  searchParams
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const resolvedSearchParams = await searchParams;

  return (
    <div className="shell">
      <div className="shell-orb shell-orb--one" />
      <div className="shell-orb shell-orb--two" />
      <div className="shell-orb shell-orb--three" />

      <main className="main">
        <div className="container">
          {resolvedSearchParams?.error ? (
            <div className="notice error" style={{ marginBottom: 18 }}>{resolvedSearchParams.error}</div>
          ) : null}

          <section className="saas-landing">
            <div className="saas-landing__content landing-fade-up landing-delay-1">
              <span className="chip chip--soft">Quiz Master Cloud</span>
              <div className="saas-landing__eyebrow">Enterprise quiz operations platform</div>
              <h1 className="saas-landing__title">Run every organization from one polished multi-tenant control plane.</h1>
              <p className="saas-landing__copy">
                Quiz Master gives global administrators, organization admins, and players a secure workspace that
                feels familiar, clean, and ready for production.
              </p>

              <div className="saas-landing__signals">
                {platformSignals.map((signal) => (
                  <article key={signal.label} className="saas-signal-card">
                    <span className="saas-signal-card__label">{signal.label}</span>
                    <strong>{signal.value}</strong>
                    <p>{signal.detail}</p>
                  </article>
                ))}
              </div>

              <div className="saas-feature-list">
                {platformHighlights.map((item) => (
                  <div key={item} className="saas-feature-list__item">
                    <span className="saas-feature-list__dot" aria-hidden="true" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="saas-landing__panel landing-fade-up landing-delay-2">
              <LoginCard />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
