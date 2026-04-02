import { LoginCard } from "../components/login-card";

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

          <section className="landing-hero landing-hero--glass landing-hero--centered">
            <div className="landing-fade-up landing-delay-1">
              <LoginCard />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
