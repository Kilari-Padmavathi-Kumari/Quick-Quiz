"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";

import { Avatar } from "./avatar";
import { useFrontendSession } from "./session-panel";
import { logout } from "../lib/api";
import { clearStoredSession } from "../lib/session";

export function SiteShell({
  children,
  title,
  subtitle,
  density = "default"
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  density?: "default" | "compact";
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { session } = useFrontendSession();

  return (
    <div className="shell">
      <div className="shell-orb shell-orb--one" />
      <div className="shell-orb shell-orb--two" />
      <div className="shell-orb shell-orb--three" />
      <div className="app-layout">
        <aside className="side-nav">
          <div className="side-nav__top">
            <Link href="/" className="brand">
              <span className="brand-mark">QZ</span>
              <span className="brand-text">Quick Quiz Arena</span>
            </Link>

            <div className="side-nav__intro">
              <div className="side-nav__eyebrow">Competitive Quiz Stack</div>
              <p>
                Premium contest flow, player wallet visibility, and live operations in one control
                surface.
              </p>
            </div>
          </div>

          <div className="nav-links">
            {session?.isAdmin ? (
              <Link
                href="/admin"
                className={clsx("nav-item", pathname === "/admin" && "nav-item--active")}
              >
                Admin
              </Link>
            ) : null}
            {session ? (
              <button
                type="button"
                className="nav-item"
                onClick={async () => {
                  try {
                    await logout();
                  } catch {
                    // Keep local logout resilient even if the API call fails.
                  } finally {
                    clearStoredSession();
                    router.push("/");
                    router.refresh();
                  }
                }}
              >
                Logout
              </button>
            ) : (
              <Link href="/" className="nav-item">
                Login
              </Link>
            )}
            <Link
              href="/dashboard"
              className={clsx("nav-item", pathname === "/dashboard" && "nav-item--active")}
            >
              Dashboard
            </Link>
            {session ? (
              <span className="status-pill status-pill--profile">
                <Avatar
                  name={session.name}
                  src={session.avatarUrl}
                  className="status-pill__avatar"
                  imageClassName="status-pill__avatar status-pill__avatar--image"
                />
                <span className="status-pill__copy">
                  <strong>{session.name}</strong>
                  <span>{session.email}</span>
                </span>
              </span>
            ) : (
              <span className="status-pill status-pill--ghost">Guest Mode</span>
            )}
          </div>
        </aside>

        <main className={clsx("main", density === "compact" && "main--compact")}>
          <section className={clsx("hero-strip", density === "compact" && "hero-strip--compact")}>
            <div className="hero-badge">Live Ops Ready</div>
            <h1 className="hero-title">{title}</h1>
            <p className="hero-subtitle">{subtitle}</p>
          </section>

          {children}
        </main>
      </div>
    </div>
  );
}
