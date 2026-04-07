"use client";

import { Suspense } from "react";
import { startTransition, useEffect, useState } from "react";

import { SiteShell } from "../../components/site-shell";
import { useFrontendSession } from "../../components/session-panel";
import {
  approveUser,
  createSaaSOrganization,
  deleteOrganizationForSuperAdmin,
  getOrganizationsForSuperAdmin,
  getPendingUsers,
  getSystemUsers,
  toggleOrganizationForSuperAdmin,
} from "../../lib/api";

const HIDDEN_ORGANIZATION_SLUGS = new Set([
  "tenant-b-arena",
  "fission-labs",
  "quick-quiz-arena"
]);

const HIDDEN_USER_EMAILS = new Set([
  "tenant-wallet-b-mnoiwa3v@example.com",
  "tenant-wallet-a-mnoiwa3v@example.com",
  "tenant-wallet-a-mnmzmq96@example.com",
  "player.two@gmail.com",
  "player.one@gmail.com"
]);

function SuperAdminContent() {
  const { session, isReady } = useFrontendSession();
  const [expandedStats, setExpandedStats] = useState<Record<string, boolean>>({});
  const [pendingUsers, setPendingUsers] = useState<Array<{
    membership_id: string;
    user_id: string;
    email: string;
    name: string;
    organization_name: string;
    employee_id: string;
    created_at: string;
  }>>([]);
  const [users, setUsers] = useState<Array<{
    id: string;
    email: string;
    name: string;
    status: string;
    organization_id: string;
    created_at: string;
  }>>([]);
  const [organizations, setOrganizations] = useState<Array<{
    id: string;
    name: string;
    slug: string;
    admin_email: string;
    is_active: boolean;
    created_at: string;
  }>>([]);
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [orgAdminEmail, setOrgAdminEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleOrganizations = organizations.filter(
    (organization) => !HIDDEN_ORGANIZATION_SLUGS.has(organization.slug)
  );
  const visibleUsers = users.filter((user) => !HIDDEN_USER_EMAILS.has(user.email.toLowerCase()));
  const activeOrganizations = visibleOrganizations.filter((organization) => organization.is_active).length;
  const inactiveOrganizations = visibleOrganizations.length - activeOrganizations;
  const approvedUsers = visibleUsers.filter((user) => user.status === "active").length;
  const selectedOrganization = visibleOrganizations.find((organization) => organization.slug === orgSlug) ?? null;
  const effectiveAdminEmail = orgAdminEmail || session?.email || "";

  async function loadData(accessToken: string) {
    const [pendingResult, usersResult, organizationsResult] = await Promise.all([
      getPendingUsers(accessToken),
      getSystemUsers(accessToken),
      getOrganizationsForSuperAdmin(accessToken)
    ]);

    setPendingUsers(pendingResult.pending_users);
    setUsers(usersResult.users);
    setOrganizations(organizationsResult.organizations);
  }

  useEffect(() => {
    if (!session?.accessToken || session.role !== "super_admin") {
      return;
    }

    void loadData(session.accessToken).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Failed to load super admin data");
    });
  }, [session]);

  if (!isReady) {
    return (
      <SiteShell title="Super Admin" subtitle="Loading global control panel...">
        <div className="notice">Loading...</div>
      </SiteShell>
    );
  }

  if (!session || session.role !== "super_admin") {
    return (
      <SiteShell title="Super Admin" subtitle="This view is restricted to global platform administrators.">
        <div className="notice error">Super admin access required.</div>
      </SiteShell>
    );
  }

  return (
    <SiteShell
      title="Super Admin Dashboard"
      subtitle="Global organization lifecycle, pending approvals, and system-wide user visibility."
    >
      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="notice error">{error}</div> : null}

      <section className="super-admin-overview">
        <article className="super-admin-stat">
          <div className="stat-card__top">
            <span className="eyebrow">Organizations</span>
            <button
              type="button"
              className="stat-card__info-button"
              aria-expanded={expandedStats.organizations === true}
              aria-label="Show organization summary"
              onClick={() =>
                setExpandedStats((current) => ({
                  ...current,
                  organizations: !current.organizations
                }))
              }
            >
              i
            </button>
          </div>
          {expandedStats.organizations ? (
            <>
              <strong>{visibleOrganizations.length}</strong>
              <p>{activeOrganizations} active and {inactiveOrganizations} inactive tenants.</p>
            </>
          ) : null}
        </article>
        <article className="super-admin-stat">
          <div className="stat-card__top">
            <span className="eyebrow">Pending approvals</span>
            <button
              type="button"
              className="stat-card__info-button"
              aria-expanded={expandedStats.pending === true}
              aria-label="Show pending approval summary"
              onClick={() =>
                setExpandedStats((current) => ({
                  ...current,
                  pending: !current.pending
                }))
              }
            >
              i
            </button>
          </div>
          {expandedStats.pending ? (
            <>
              <strong>{pendingUsers.length}</strong>
              <p>Users waiting for role assignment and tenant approval.</p>
            </>
          ) : null}
        </article>
        <article className="super-admin-stat">
          <div className="stat-card__top">
            <span className="eyebrow">Active users</span>
            <button
              type="button"
              className="stat-card__info-button"
              aria-expanded={expandedStats.users === true}
              aria-label="Show active user summary"
              onClick={() =>
                setExpandedStats((current) => ({
                  ...current,
                  users: !current.users
                }))
              }
            >
              i
            </button>
          </div>
          {expandedStats.users ? (
            <>
              <strong>{approvedUsers}</strong>
              <p>Approved users across all organizations in the platform.</p>
            </>
          ) : null}
        </article>
      </section>

      <section className="super-admin-grid">
        <div className="card dashboard-card super-admin-panel">
          <div className="super-admin-panel__header">
            <div>
              <div className="eyebrow">Tenant lifecycle</div>
              <h2 className="super-admin-panel__title">
                {selectedOrganization ? `Update ${selectedOrganization.name}` : "Create organization"}
              </h2>
            </div>
            <span className="chip chip--soft">{selectedOrganization ? "Edit mode" : "New tenant"}</span>
          </div>

          <label className="field">
            <span>Organization Name</span>
            <input value={orgName} onChange={(event) => setOrgName(event.target.value)} />
          </label>
          <label className="field">
            <span>Organization Slug</span>
            <input value={orgSlug} onChange={(event) => setOrgSlug(event.target.value)} />
          </label>

          <div className="stack-row">
            <button
              type="button"
              className="solid-button"
              onClick={() => {
                setMessage(null);
                setError(null);

                startTransition(async () => {
                  try {
                    await createSaaSOrganization(session.accessToken, {
                      name: orgName,
                      slug: orgSlug,
                      admin_email: effectiveAdminEmail
                    });
                    setMessage("Organization created.");
                    await loadData(session.accessToken);
                  } catch (createError) {
                    setError(createError instanceof Error ? createError.message : "Failed to create organization");
                  }
                });
              }}
            >
              Create Organization
            </button>
          </div>
        </div>
      </section>

      <section className="super-admin-bottom-grid">
        <div className="super-admin-side-stack">
          <details className="card dashboard-card super-admin-panel dashboard-dropdown">
            <summary className="dashboard-dropdown__summary">
              <div className="super-admin-panel__header" style={{ marginBottom: 0, width: "100%" }}>
                <div>
                  <div className="eyebrow">Tenant directory</div>
                  <h2 className="super-admin-panel__title">Organizations</h2>
                </div>
                <div className="stack-row" style={{ alignItems: "center" }}>
                  <span className="chip chip--soft">{visibleOrganizations.length} total</span>
                  <span className="dashboard-dropdown__icon" aria-hidden="true">^</span>
                </div>
              </div>
            </summary>

            <div className="list dashboard-dropdown__content">
              {visibleOrganizations.map((organization) => (
                <div key={organization.id} className="notice super-admin-list-card">
                  <strong>{organization.name}</strong>
                  <div className="muted">{organization.slug}</div>
                  <div className="muted">{organization.admin_email}</div>
                  <div className="muted">{organization.is_active ? "active" : "inactive"}</div>
                  <div className="stack-row" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setOrgName(organization.name);
                        setOrgSlug(organization.slug);
                        setOrgAdminEmail(organization.admin_email);
                      }}
                    >
                      Load Into Form
                    </button>
                    <button
                      type="button"
                      className="solid-button"
                      onClick={() => {
                        startTransition(async () => {
                          try {
                            await toggleOrganizationForSuperAdmin(
                              session.accessToken,
                              organization.id,
                              !organization.is_active
                            );
                            setMessage(`${organization.name} updated.`);
                            await loadData(session.accessToken);
                          } catch (toggleError) {
                            setError(toggleError instanceof Error ? toggleError.message : "Toggle failed");
                          }
                        });
                      }}
                    >
                      {organization.is_active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => {
                        startTransition(async () => {
                          try {
                            await deleteOrganizationForSuperAdmin(session.accessToken, organization.id);
                            setMessage(`${organization.name} deleted.`);
                            await loadData(session.accessToken);
                          } catch (deleteError) {
                            setError(deleteError instanceof Error ? deleteError.message : "Delete failed");
                          }
                        });
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {visibleOrganizations.length === 0 ? <div className="notice">No organizations to display.</div> : null}
            </div>
          </details>

          <details className="card dashboard-card super-admin-panel dashboard-dropdown">
            <summary className="dashboard-dropdown__summary">
              <div className="super-admin-panel__header" style={{ marginBottom: 0, width: "100%" }}>
                <div>
                  <div className="eyebrow">Approval queue</div>
                  <h2 className="super-admin-panel__title">Pending membership requests</h2>
                </div>
                <div className="stack-row" style={{ alignItems: "center" }}>
                  <span className="chip chip--soft">{pendingUsers.length} waiting</span>
                  <span className="dashboard-dropdown__icon" aria-hidden="true">^</span>
                </div>
              </div>
            </summary>

            <div className="list dashboard-dropdown__content">
              {pendingUsers.map((pending) => (
                <div key={pending.membership_id} className="notice super-admin-list-card">
                  <strong>{pending.name}</strong>
                  <div className="muted">{pending.email}</div>
                  <div className="muted">{pending.organization_name} | {pending.employee_id}</div>
                  <div className="stack-row" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="solid-button"
                      onClick={() => {
                        startTransition(async () => {
                          try {
                            await approveUser(session.accessToken, {
                              membership_id: pending.membership_id,
                              role: "player",
                              action: "approve"
                            });
                            setMessage(`Approved ${pending.email}`);
                            await loadData(session.accessToken);
                          } catch (approveError) {
                            setError(approveError instanceof Error ? approveError.message : "Approval failed");
                          }
                        });
                      }}
                    >
                      Approve Player
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        startTransition(async () => {
                          try {
                            await approveUser(session.accessToken, {
                              membership_id: pending.membership_id,
                              role: "organization_admin",
                              action: "approve"
                            });
                            setMessage(`Approved ${pending.email} as admin`);
                            await loadData(session.accessToken);
                          } catch (approveError) {
                            setError(approveError instanceof Error ? approveError.message : "Approval failed");
                          }
                        });
                      }}
                    >
                      Approve Admin
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => {
                        startTransition(async () => {
                          try {
                            await approveUser(session.accessToken, {
                              membership_id: pending.membership_id,
                              role: "player",
                              action: "reject"
                            });
                            setMessage(`Rejected ${pending.email}`);
                            await loadData(session.accessToken);
                          } catch (approveError) {
                            setError(approveError instanceof Error ? approveError.message : "Rejection failed");
                          }
                        });
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
              {pendingUsers.length === 0 ? <div className="notice">No pending users.</div> : null}
            </div>
          </details>

          <details className="card dashboard-card super-admin-panel dashboard-dropdown">
            <summary className="dashboard-dropdown__summary">
              <div className="super-admin-panel__header" style={{ marginBottom: 0, width: "100%" }}>
                <div>
                  <div className="eyebrow">Platform users</div>
                  <h2 className="super-admin-panel__title">All users</h2>
                </div>
                <div className="stack-row" style={{ alignItems: "center" }}>
                  <span className="chip chip--soft">{visibleUsers.length} total</span>
                  <span className="dashboard-dropdown__icon" aria-hidden="true">^</span>
                </div>
              </div>
            </summary>

            <div className="list dashboard-dropdown__content">
              {visibleUsers.slice(0, 12).map((user) => (
                <div key={user.id} className="notice super-admin-list-card">
                  <strong>{user.name}</strong>
                  <div className="muted">{user.email}</div>
                  <div className="muted">{user.status} | {new Date(user.created_at).toLocaleString()}</div>
                </div>
              ))}
              {visibleUsers.length === 0 ? <div className="notice">No users to display.</div> : null}
            </div>
          </details>
        </div>
      </section>
    </SiteShell>
  );
}

export default function SuperAdminPage() {
  return (
    <Suspense
      fallback={
        <SiteShell title="Super Admin Dashboard" subtitle="Loading global control panel...">
          <div className="notice">Loading...</div>
        </SiteShell>
      }
    >
      <SuperAdminContent />
    </Suspense>
  );
}
