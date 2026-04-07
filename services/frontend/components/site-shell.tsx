"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import clsx from "clsx";

import { Avatar } from "./avatar";
import { useFrontendSession } from "./session-panel";
import { lookupOrganization, logout } from "../lib/api";
import { clearStoredSession } from "../lib/session";
import {
  clearStoredOrganizationIdentity,
  getOrganizationIdFromSearchParams,
  getOrganizationSlugFromSearchParams,
  storeOrganizationId
} from "../lib/tenant";

function getRoleMeta(session: ReturnType<typeof useFrontendSession>["session"]) {
  if (!session) {
    return {
      label: "Guest Session",
      eyebrow: "Workspace Access",
      description: "Sign in with Google to continue into your organization workspace."
    };
  }

  if (session.role === "super_admin") {
    return {
      label: "Super Admin",
      eyebrow: "Global Control",
      description: "Manage organizations, user approvals, and platform-wide activity without entering tenant dashboards."
    };
  }

  if (session.isAdmin) {
    return {
      label: "Organization Admin",
      eyebrow: "Tenant Operations",
      description: "Oversee contests, approvals, and operational workflows inside your organization."
    };
  }

  return {
    label: "Player Workspace",
    eyebrow: "Member Access",
    description: "Join approved contests, manage wallet actions, and follow results from one place."
  };
}

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
  const roleMeta = getRoleMeta(session);
  const isSuperAdmin = session?.role === "super_admin";
  const isPendingUser = session?.role === "pending" || session?.userStatus === "pending";

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const organizationId = getOrganizationIdFromSearchParams(searchParams);
    if (organizationId) {
      storeOrganizationId(organizationId);
      return;
    }

    const organizationSlug = getOrganizationSlugFromSearchParams(searchParams);
    if (organizationSlug) {
      void lookupOrganization({ slug: organizationSlug }).catch(() => {
        // Ignore lookup failures here; page-level fetches surface user-facing errors.
      });
    }
  }, []);

  return (
    <div className="shell">
      <div className="shell-orb shell-orb--one" />
      <div className="shell-orb shell-orb--two" />
      <div className="shell-orb shell-orb--three" />
      <div className="app-layout">
        <aside className="side-nav">
          <div className="side-nav__top">
            <Link href="/" className="brand">
              <span className="brand-mark">QM</span>
              <span className="brand-text">Quiz Master</span>
            </Link>

            {isSuperAdmin ? null : (
              <div className="side-nav__intro">
                <div className="side-nav__eyebrow">{roleMeta.eyebrow}</div>
                <p>{roleMeta.description}</p>
              </div>
            )}

            {isSuperAdmin ? null : (
              <div className="workspace-badge">
                <span className="workspace-badge__label">Workspace</span>
                <strong>{session?.organizationName ?? session?.organizationSlug ?? "Quiz Master Cloud"}</strong>
                <span>{roleMeta.label}</span>
              </div>
            )}
          </div>

          <div className="nav-links">
            {isSuperAdmin ? null : <div className="nav-links__section">Navigation</div>}
            {session?.role === "super_admin" ? (
              <Link
                href="/super-admin"
                className={clsx("nav-item", pathname === "/super-admin" && "nav-item--active")}
              >
                Global Dashboard
              </Link>
            ) : null}
            {session?.isAdmin ? (
              <Link
                href="/admin"
                className={clsx("nav-item", pathname === "/admin" && "nav-item--active")}
              >
                Admin Console
              </Link>
            ) : null}
            {session && session.role !== "super_admin" && !isPendingUser ? (
              <Link
                href="/dashboard"
                className={clsx("nav-item", pathname === "/dashboard" && "nav-item--active")}
              >
                {session.isAdmin ? "Player View" : "Player Dashboard"}
              </Link>
            ) : null}
            {session && !session.organizationId ? null : session?.role !== "super_admin" && session?.userStatus === "pending" && !isPendingUser ? (
              <Link
                href="/waiting-approval"
                className={clsx("nav-item", pathname === "/waiting-approval" && "nav-item--active")}
              >
                Approval Status
              </Link>
            ) : null}
            {session && session.role !== "super_admin" && !session.organizationName && session.userStatus !== "active" ? (
              <Link
                href="/join-organization"
                className={clsx("nav-item", pathname === "/join-organization" && "nav-item--active")}
              >
                Join Organization
              </Link>
            ) : null}
            <div className="nav-links__section">Account</div>
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
                  <span>{session.organizationName ?? session.organizationSlug ?? "Organization"}</span>
                </span>
              </span>
            ) : (
              <span className="status-pill status-pill--ghost">Guest Mode</span>
            )}
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
                    clearStoredOrganizationIdentity();
                    router.push("/");
                    router.refresh();
                  }
                }}
              >
                Logout
              </button>
            ) : (
              <Link href="/" className="nav-item">
                Sign In
              </Link>
            )}
          </div>
        </aside>

        <main className={clsx("main", density === "compact" && "main--compact")}>
          <section className={clsx("hero-strip", density === "compact" && "hero-strip--compact")}>
            <div className="hero-badge">{roleMeta.label}</div>
            <h1 className="hero-title">{title}</h1>
            <p className="hero-subtitle">{subtitle}</p>
          </section>

          {children}
        </main>
      </div>
    </div>
  );
}
