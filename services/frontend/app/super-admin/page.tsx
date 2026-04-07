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
  getSystemActivity,
  getSystemUsers,
  toggleOrganizationForSuperAdmin,
  updateOrganizationForSuperAdmin
} from "../../lib/api";

function SuperAdminContent() {
  const { session, isReady } = useFrontendSession();
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
  const [activity, setActivity] = useState<Array<{
    id: string;
    action: string;
    target_type: string;
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
  const activeOrganizations = organizations.filter((organization) => organization.is_active).length;
  const inactiveOrganizations = organizations.length - activeOrganizations;
  const approvedUsers = users.filter((user) => user.status === "active").length;
  const selectedOrganization = organizations.find((organization) => organization.slug === orgSlug) ?? null;

  async function loadData(accessToken: string) {
    const [pendingResult, usersResult, activityResult, organizationsResult] = await Promise.all([
      getPendingUsers(accessToken),
      getSystemUsers(accessToken),
      getSystemActivity(accessToken),
      getOrganizationsForSuperAdmin(accessToken)
    ]);

    setPendingUsers(pendingResult.pending_users);
    setUsers(usersResult.users);
    setActivity(activityResult.activity);
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
          <span className="eyebrow">Organizations</span>
          <strong>{organizations.length}</strong>
          <p>{activeOrganizations} active and {inactiveOrganizations} inactive tenants.</p>
        </article>
        <article className="super-admin-stat">
          <span className="eyebrow">Pending approvals</span>
          <strong>{pendingUsers.length}</strong>
          <p>Users waiting for role assignment and tenant approval.</p>
        </article>
        <article className="super-admin-stat">
          <span className="eyebrow">Active users</span>
          <strong>{approvedUsers}</strong>
          <p>Approved users across all organizations in the platform.</p>
        </article>
        <article className="super-admin-stat">
          <span className="eyebrow">Audit activity</span>
          <strong>{activity.length}</strong>
          <p>Recent platform events captured for governance and monitoring.</p>
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
            <span>Name</span>
            <input value={orgName} onChange={(event) => setOrgName(event.target.value)} />
          </label>
          <label className="field">
            <span>Slug</span>
            <input value={orgSlug} onChange={(event) => setOrgSlug(event.target.value)} />
          </label>
          <label className="field">
            <span>Admin Email</span>
            <input value={orgAdminEmail} onChange={(event) => setOrgAdminEmail(event.target.value)} />
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
                      admin_email: orgAdminEmail
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
            <button
              type="button"
              className="ghost-button"
              disabled={!orgName || !orgSlug || !orgAdminEmail}
              onClick={() => {
                const target = organizations.find((organization) => organization.slug === orgSlug);
                if (!target) {
                  setError("Load an existing organization first.");
                  return;
                }

                startTransition(async () => {
                  try {
                    await updateOrganizationForSuperAdmin(session.accessToken, target.id, {
                      name: orgName,
                      slug: orgSlug,
                      admin_email: orgAdminEmail
                    });
                    setMessage("Organization updated.");
                    await loadData(session.accessToken);
                  } catch (updateError) {
                    setError(updateError instanceof Error ? updateError.message : "Update failed");
                  }
                });
              }}
            >
              Save Changes
            </button>
          </div>
        </div>

        <div className="card dashboard-card super-admin-panel">
          <div className="super-admin-panel__header">
            <div>
              <div className="eyebrow">Approval queue</div>
              <h2 className="super-admin-panel__title">Pending membership requests</h2>
            </div>
            <span className="chip chip--soft">{pendingUsers.length} waiting</span>
          </div>

          <div className="list">
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
        </div>
      </section>

      <section className="super-admin-bottom-grid">
        <div className="card dashboard-card super-admin-panel">
          <div className="super-admin-panel__header">
            <div>
              <div className="eyebrow">Tenant directory</div>
              <h2 className="super-admin-panel__title">Organizations</h2>
            </div>
            <span className="chip chip--soft">{organizations.length} total</span>
          </div>

          <div className="list">
            {organizations.map((organization) => (
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
          </div>
        </div>

        <div className="super-admin-side-stack">
          <div className="card dashboard-card super-admin-panel">
            <div className="super-admin-panel__header">
              <div>
                <div className="eyebrow">Platform users</div>
                <h2 className="super-admin-panel__title">All users</h2>
              </div>
              <span className="chip chip--soft">{users.length} total</span>
            </div>

            <div className="list">
              {users.slice(0, 12).map((user) => (
                <div key={user.id} className="notice super-admin-list-card">
                  <strong>{user.name}</strong>
                  <div className="muted">{user.email}</div>
                  <div className="muted">{user.status} | {new Date(user.created_at).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card dashboard-card super-admin-panel">
            <div className="super-admin-panel__header">
              <div>
                <div className="eyebrow">Audit stream</div>
                <h2 className="super-admin-panel__title">System activity</h2>
              </div>
              <span className="chip chip--soft">Recent events</span>
            </div>

            <div className="list">
              {activity.slice(0, 12).map((item) => (
                <div key={item.id} className="notice super-admin-list-card">
                  <strong>{item.action}</strong>
                  <div className="muted">{item.target_type}</div>
                  <div className="muted">{new Date(item.created_at).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
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
