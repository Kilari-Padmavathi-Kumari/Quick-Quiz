import { LoginCard } from "../components/login-card";

const welcomePoints = [
  "One secure sign-in for every role",
  "Organization-based access with guided onboarding",
  "Fast entry into contests and approvals"
];

const quickFacts = [
  { label: "Access", value: "Google Only" },
  { label: "Mode", value: "Multi-Org" },
  { label: "Experience", value: "Live Quiz" }
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
              <span className="chip chip--soft">Welcome To Quiz Master</span>
              <div className="saas-landing__eyebrow">Secure Quiz Workspace</div>
              <h1 className="saas-landing__title">Welcome back. Continue with Google to enter your workspace.</h1>
              <p className="saas-landing__copy">
                Sign in once and we will route you to the right workspace automatically.
              </p>

              <div className="saas-landing__quickfacts">
                {quickFacts.map((fact) => (
                  <div key={fact.label} className="saas-quickfact">
                    <span>{fact.label}</span>
                    <strong>{fact.value}</strong>
                  </div>
                ))}
              </div>

              <div className="saas-feature-list">
                {welcomePoints.map((item) => (
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
