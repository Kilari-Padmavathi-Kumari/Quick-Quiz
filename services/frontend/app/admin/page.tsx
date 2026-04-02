"use client";

import Link from "next/link";
import { startTransition, useEffect, useMemo, useState } from "react";

import { Avatar } from "../../components/avatar";
import { LoginCard } from "../../components/login-card";
import { SiteShell } from "../../components/site-shell";
import { useFrontendSession } from "../../components/session-panel";
import {
  addQuestion,
  approveWalletTopupRequest,
  createContest,
  getAdminContests,
  getAdminWalletRequestsStreamUrl,
  getAdminUsers,
  getJobs,
  getWalletTopupRequests,
  publishContest,
  recoverContest,
  rejectWalletTopupRequest,
  retryJob
} from "../../lib/api";

interface AdminContest {
  id: string;
  title: string;
  status: string;
  member_count: number;
  starts_at: string;
  prize_pool: string;
}

interface JobItem {
  job_id: string;
  queue: string;
  job_name: string;
  data?: Record<string, unknown>;
  status: string;
  attempts?: number;
  scheduled_for: string;
  failed_reason: string | null;
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  wallet_balance: string;
  is_admin: boolean;
  is_banned: boolean;
  created_at: string;
}

interface WalletTopupRequestItem {
  id: string;
  user_id: string;
  amount: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  reviewed_at: string | null;
  user_name: string;
  user_email: string;
}

function getStatusPillClass(status: string) {
  if (status === "live") {
    return "pill pill--live";
  }

  if (status === "open" || status === "pending") {
    return "pill pill--open";
  }

  if (status === "draft") {
    return "pill pill--draft";
  }

  if (status === "ended" || status === "approved" || status === "completed") {
    return "pill pill--ended";
  }

  if (status === "cancelled" || status === "rejected" || status === "failed") {
    return "pill pill--cancelled";
  }

  return "pill";
}

export default function AdminPage() {
  const { session, isReady } = useFrontendSession();
  const [contests, setContests] = useState<AdminContest[]>([]);
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [walletRequests, setWalletRequests] = useState<WalletTopupRequestItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [contestForm, setContestForm] = useState({
    title: "Friday Flash Championship",
    starts_at: new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 16),
    entry_fee: "10",
    max_members: "100",
    prize_rule: "top_scorer" as "all_correct" | "top_scorer"
  });

  const [selectedContestId, setSelectedContestId] = useState("");
  const [questionForm, setQuestionForm] = useState({
    seq: "1",
    body: "Which planet is known as the Red Planet?",
    option_a: "Venus",
    option_b: "Mars",
    option_c: "Jupiter",
    option_d: "Mercury",
    correct_option: "b" as "a" | "b" | "c" | "d",
    time_limit_sec: "20"
  });
  const activeContests = contests.filter((contest) => contest.status === "open" || contest.status === "live").length;
  const endedContests = contests.filter((contest) => contest.status === "ended").length;
  const pendingWalletRequestCount = walletRequests.filter((request) => request.status === "pending").length;

  async function refreshWalletRequests(accessToken: string, options?: { notifyNewRequest?: boolean }) {
    try {
      const walletRequestsResult = await getWalletTopupRequests(accessToken);
      setWalletRequests(walletRequestsResult.requests);

      if (options?.notifyNewRequest) {
        setMessage("New wallet request received in Approval queue.");
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh wallet requests");
    }
  }

  async function loadAdminData(accessToken: string) {
    setError(null);
    setIsLoadingData(true);

    try {
      const [contestResult, jobsResult, usersResult, walletRequestsResult] = await Promise.all([
        getAdminContests(accessToken),
        getJobs(accessToken),
        getAdminUsers(accessToken),
        getWalletTopupRequests(accessToken)
      ]);

      setContests(contestResult.contests);
      setJobs(jobsResult.jobs);
      setUsers(usersResult.users);
      setWalletRequests(walletRequestsResult.requests);

      if (!selectedContestId && contestResult.contests.length > 0) {
        setSelectedContestId(contestResult.contests[0].id);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load admin data");
    } finally {
      setIsLoadingData(false);
    }
  }

  useEffect(() => {
    if (!session?.accessToken || !session.isAdmin) {
      return;
    }

    startTransition(() => {
      void loadAdminData(session.accessToken);
    });
  }, [session]);

  useEffect(() => {
    if (!session?.accessToken || !session.isAdmin) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshWalletRequests(session.accessToken);
    }, 15000);

    return () => window.clearInterval(interval);
  }, [session]);

  useEffect(() => {
    if (!session?.accessToken || !session.isAdmin) {
      return;
    }

    const stream = new EventSource(getAdminWalletRequestsStreamUrl(session.accessToken));

    const handleWalletRequestCreated = () => {
      void refreshWalletRequests(session.accessToken, { notifyNewRequest: true });
    };

    stream.addEventListener("wallet_request_created", handleWalletRequestCreated);
    stream.onerror = () => {
      stream.close();
    };

    return () => {
      stream.removeEventListener("wallet_request_created", handleWalletRequestCreated);
      stream.close();
    };
  }, [session]);

  const selectedContest = useMemo(
    () => contests.find((contest) => contest.id === selectedContestId) ?? null,
    [contests, selectedContestId]
  );

  if (!isReady) {
    return (
      <SiteShell title="Admin Console" subtitle="Loading admin session...">
        <div className="notice">Checking saved session...</div>
      </SiteShell>
    );
  }

  if (!session) {
    return (
      <SiteShell
        title="Admin Console"
        subtitle="Request a one-time code for the admin account to create contests, publish jobs, and inspect queue state."
      >
        <LoginCard targetHref="/admin" adminShortcut />
      </SiteShell>
    );
  }

  if (!session.isAdmin) {
    return (
      <SiteShell title="Admin Console" subtitle="This route is reserved for admin users.">
        <div className="notice error">
          The current session does not have admin access. Sign in using
          <span className="mono"> padmavathi.kilari@fissionlabs.com</span>.
        </div>
      </SiteShell>
    );
  }

  return (
    <SiteShell
      title="Admin Console"
      subtitle=""
      density="compact"
    >
      <section className="admin-hero">
        <div className="admin-hero__stats">
          <div className="admin-stat-card admin-stat-card--contest">
            <span className="eyebrow">Contests</span>
            <div className="stat-value">{contests.length}</div>
            <div className="muted">Total tracked contests</div>
          </div>
          <div className="admin-stat-card admin-stat-card--live">
            <span className="eyebrow">Active</span>
            <div className="stat-value">{activeContests}</div>
            <div className="muted">Open or live right now</div>
          </div>
          <div className="admin-stat-card admin-stat-card--results">
            <span className="eyebrow">Results</span>
            <div className="stat-value">{endedContests}</div>
            <div className="muted">Completed contests</div>
          </div>
        </div>
      </section>

      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="notice error" style={{ marginTop: 14 }}>{error}</div> : null}
      {isLoadingData ? (
        <div className="loading-grid" style={{ marginTop: 20 }}>
          <div className="loading-card loading-card--panel" />
          <div className="loading-card loading-card--panel" />
        </div>
      ) : null}

      <div className="grid two admin-workspace-grid" style={{ marginTop: 20 }}>
        <div className="admin-column-stack">
        <div className="card card-luxe admin-panel">
          <div className="admin-panel__header">
            <div>
              <div className="eyebrow">Create Contest</div>
              <h3 className="admin-panel__title">Launch setup</h3>
            </div>
          </div>
          <label className="field">
            <span>Contest Title</span>
            <input
              placeholder="Friday Flash Championship"
              value={contestForm.title}
              onChange={(event) => setContestForm((current) => ({ ...current, title: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Start Time</span>
            <input
              type="datetime-local"
              value={contestForm.starts_at}
              onChange={(event) => setContestForm((current) => ({ ...current, starts_at: event.target.value }))}
            />
          </label>
          <div className="grid two">
            <label className="field">
              <span>Entry Fee</span>
              <input
                placeholder="10"
                value={contestForm.entry_fee}
                onChange={(event) => setContestForm((current) => ({ ...current, entry_fee: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Player Capacity</span>
              <input
                placeholder="100"
                value={contestForm.max_members}
                onChange={(event) => setContestForm((current) => ({ ...current, max_members: event.target.value }))}
              />
            </label>
          </div>
          <label className="field">
            <span>Winner Logic</span>
            <input value="Top Scorer" disabled />
          </label>
          <button
            type="button"
            className="solid-button"
            disabled={busyAction === "create-contest"}
            onClick={() => {
              setMessage(null);
              setError(null);
              setBusyAction("create-contest");

              startTransition(async () => {
                try {
                  const result = await createContest(session.accessToken, {
                    title: contestForm.title,
                    starts_at: new Date(contestForm.starts_at).toISOString(),
                    entry_fee: Number(contestForm.entry_fee),
                    max_members: Number(contestForm.max_members),
                    prize_rule: contestForm.prize_rule
                  });

                  setSelectedContestId(result.contest.id);
                  setMessage(`Success: created contest ${result.contest.id}.`);
                  await loadAdminData(session.accessToken);
                } catch (createError) {
                  setError(createError instanceof Error ? createError.message : "Contest creation failed");
                } finally {
                  setBusyAction(null);
                }
              });
            }}
          >
            {busyAction === "create-contest" ? "Creating..." : "Create Contest Draft"}
          </button>
        </div>

      <details className="dashboard-dropdown" open>
        <summary className="dashboard-dropdown__summary">
          <div className="section-heading">
            <div className="eyebrow">Contest Monitor</div>
            <h2 className="section-title">Live contest control</h2>
          </div>
          <span className="dashboard-dropdown__icon" aria-hidden="true">v</span>
        </summary>
        <div className="list dashboard-dropdown__content">
            {contests.length === 0 ? (
              <div className="empty-state empty-state--history">
                <div className="empty-state__eyebrow">Contest Control</div>
                <strong>No contests yet</strong>
                <p>Create a contest above and it will appear here for recovery, publishing, and result tracking.</p>
              </div>
            ) : null}
            {contests.map((contest) => (
              <div key={contest.id} className={`contest-card contest-card--luxe admin-monitor-card admin-monitor-card--${contest.status}`}>
                <div className="contest-card__header">
                  <div className="contest-card__titleblock">
                    <div className="contest-card__timing">
                      {contest.status === "live" ? "Live now" : new Date(contest.starts_at).toLocaleDateString()}
                    </div>
                    <h3 className="contest-card__title">{contest.title}</h3>
                    <div className="pill-row">
                      <span className={getStatusPillClass(contest.status)}>{contest.status}</span>
                      <span className="pill gold">Prize Rs {contest.prize_pool}</span>
                      <span className="pill rose">{contest.member_count} joined</span>
                    </div>
                  </div>

                  <div className="contest-card__actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setMessage(null);
                        setError(null);

                        startTransition(async () => {
                          try {
                            await recoverContest(session.accessToken, contest.id);
                            setMessage(`Recovery triggered for ${contest.id}`);
                            await loadAdminData(session.accessToken);
                          } catch (recoverError) {
                            setError(recoverError instanceof Error ? recoverError.message : "Recover failed");
                          }
                        });
                      }}
                    >
                      Recover
                    </button>

                    {contest.status === "ended" ? (
                      <Link href={`/contests/${contest.id}/leaderboard`} className="solid-button">
                        View Result
                      </Link>
                    ) : null}
                  </div>
                </div>

                <p className="muted contest-card__subcopy">
                  Starts at {new Date(contest.starts_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
      </details>

      <details className="dashboard-dropdown">
        <summary className="dashboard-dropdown__summary">
          <div className="section-heading">
            <div className="eyebrow">Wallet Requests</div>
            <h2 className="section-title">Approval queue</h2>
          </div>
          <div className="dashboard-dropdown__summary-right">
            {pendingWalletRequestCount > 0 ? (
              <span className="admin-notification-badge">{pendingWalletRequestCount}</span>
            ) : null}
            <span className="dashboard-dropdown__icon" aria-hidden="true">v</span>
          </div>
        </summary>
        <div className="list dashboard-dropdown__content">
            {walletRequests.length === 0 ? (
              <div className="empty-state empty-state--wallet">
                <div className="empty-state__eyebrow">Wallet Ops</div>
                <strong>No wallet requests</strong>
                <p>User payment requests will appear here and can be approved from this panel.</p>
              </div>
            ) : null}
            {walletRequests.map((walletRequest) => (
              <div key={walletRequest.id} className="notice notice-luxe wallet-request-card">
                <div className="stack-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div className="wallet-request-card__main">
                    <strong>{walletRequest.user_name}</strong>
                    <div className="muted">{walletRequest.user_email}</div>
                    <div className="muted">Requested Rs {walletRequest.amount}</div>
                    <div className="muted">
                      Requested {new Date(walletRequest.requested_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="pill-row">
                    <span className={getStatusPillClass(walletRequest.status)}>
                      {walletRequest.status}
                    </span>
                    {walletRequest.status === "pending" ? (
                      <>
                        <button
                          type="button"
                          className="solid-button"
                          disabled={
                            busyAction === `approve-wallet-request:${walletRequest.id}` ||
                            busyAction === `reject-wallet-request:${walletRequest.id}`
                          }
                          onClick={() => {
                            setMessage(null);
                            setError(null);
                            setBusyAction(`approve-wallet-request:${walletRequest.id}`);

                            startTransition(async () => {
                              try {
                                await approveWalletTopupRequest(session.accessToken, walletRequest.id);
                                setMessage(
                                  `Success: approved Rs ${walletRequest.amount} for ${walletRequest.user_name}.`
                                );
                                await loadAdminData(session.accessToken);
                              } catch (approveError) {
                                setError(
                                  approveError instanceof Error ? approveError.message : "Wallet request approval failed"
                                );
                              } finally {
                                setBusyAction(null);
                              }
                            });
                          }}
                        >
                          {busyAction === `approve-wallet-request:${walletRequest.id}` ? "Approving..." : "Approve"}
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          disabled={
                            busyAction === `approve-wallet-request:${walletRequest.id}` ||
                            busyAction === `reject-wallet-request:${walletRequest.id}`
                          }
                          onClick={() => {
                            setMessage(null);
                            setError(null);
                            setBusyAction(`reject-wallet-request:${walletRequest.id}`);

                            startTransition(async () => {
                              try {
                                await rejectWalletTopupRequest(session.accessToken, walletRequest.id);
                                setMessage(
                                  `Success: rejected Rs ${walletRequest.amount} request from ${walletRequest.user_name}.`
                                );
                                await loadAdminData(session.accessToken);
                              } catch (rejectError) {
                                setError(
                                  rejectError instanceof Error ? rejectError.message : "Wallet request rejection failed"
                                );
                              } finally {
                                setBusyAction(null);
                              }
                            });
                          }}
                        >
                          {busyAction === `reject-wallet-request:${walletRequest.id}` ? "Rejecting..." : "Reject"}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
      </details>
      </div>

        <div className="card card-luxe admin-panel">
          <div className="admin-panel__header">
            <div>
              <div className="eyebrow">Add Question</div>
              <h3 className="admin-panel__title">Round composer</h3>
            </div>
            {selectedContest ? (
              <div className="admin-selected-contest">
                <span className={getStatusPillClass(selectedContest.status)}>{selectedContest.status}</span>
                <strong>{selectedContest.title}</strong>
                <span className="mono">{selectedContest.id}</span>
              </div>
            ) : null}
          </div>
          <label className="field">
            <span>Target Contest</span>
            <select
              value={selectedContestId}
              onChange={(event) => setSelectedContestId(event.target.value)}
            >
              <option value="">Choose a contest</option>
              {contests.map((contest) => (
                <option key={contest.id} value={contest.id}>
                  {contest.title} ({contest.status})
                </option>
              ))}
            </select>
          </label>
          <div className="grid two">
            <label className="field">
              <span>Question Order</span>
              <input
                placeholder="1"
                value={questionForm.seq}
                onChange={(event) => setQuestionForm((current) => ({ ...current, seq: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Answer Timer</span>
              <input
                placeholder="20"
                value={questionForm.time_limit_sec}
                onChange={(event) =>
                  setQuestionForm((current) => ({ ...current, time_limit_sec: event.target.value }))
                }
              />
            </label>
          </div>
          <label className="field">
            <span>Question Prompt</span>
            <textarea
              placeholder="Which planet is known as the Red Planet?"
              value={questionForm.body}
              onChange={(event) => setQuestionForm((current) => ({ ...current, body: event.target.value }))}
            />
          </label>
          <div className="grid two">
            <label className="field">
              <span>Option A</span>
              <input
                placeholder="Venus"
                value={questionForm.option_a}
                onChange={(event) => setQuestionForm((current) => ({ ...current, option_a: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Option B</span>
              <input
                placeholder="Mars"
                value={questionForm.option_b}
                onChange={(event) => setQuestionForm((current) => ({ ...current, option_b: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Option C</span>
              <input
                placeholder="Jupiter"
                value={questionForm.option_c}
                onChange={(event) => setQuestionForm((current) => ({ ...current, option_c: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Option D</span>
              <input
                placeholder="Mercury"
                value={questionForm.option_d}
                onChange={(event) => setQuestionForm((current) => ({ ...current, option_d: event.target.value }))}
              />
            </label>
          </div>
          <label className="field">
            <span>Correct Answer</span>
            <select
              value={questionForm.correct_option}
              onChange={(event) =>
                setQuestionForm((current) => ({
                  ...current,
                  correct_option: event.target.value as "a" | "b" | "c" | "d"
                }))
              }
            >
              <option value="a">Option A</option>
              <option value="b">Option B</option>
              <option value="c">Option C</option>
              <option value="d">Option D</option>
            </select>
          </label>
          <div className="stack-row">
            <button
              type="button"
              className="solid-button"
              disabled={!selectedContestId}
              onClick={() => {
                if (!selectedContestId) {
                  setError("Select a contest first.");
                  return;
                }

                setMessage(null);
                setError(null);
                setBusyAction("add-question");

                startTransition(async () => {
                  try {
                    const result = await addQuestion(session.accessToken, selectedContestId, {
                      seq: Number(questionForm.seq),
                      body: questionForm.body,
                      option_a: questionForm.option_a,
                      option_b: questionForm.option_b,
                      option_c: questionForm.option_c,
                      option_d: questionForm.option_d,
                      correct_option: questionForm.correct_option,
                      time_limit_sec: Number(questionForm.time_limit_sec)
                    });

                    setMessage(`Success: added question ${result.question.seq} to ${selectedContestId}.`);
                    setQuestionForm((current) => ({
                      ...current,
                      seq: String(Number(current.seq) + 1)
                    }));
                    await loadAdminData(session.accessToken);
                  } catch (questionError) {
                    setError(questionError instanceof Error ? questionError.message : "Question add failed");
                  } finally {
                    setBusyAction(null);
                  }
                });
              }}
            >
              {busyAction === "add-question" ? "Adding..." : "Save Question"}
            </button>

            <button
              type="button"
              className="ghost-button"
              disabled={!selectedContestId}
              onClick={() => {
                if (!selectedContestId) {
                  return;
                }

                setMessage(null);
                setError(null);
                setBusyAction("publish-contest");

                startTransition(async () => {
                  try {
                    await publishContest(session.accessToken, selectedContestId);
                    setMessage(`Success: published contest ${selectedContestId}.`);
                    await loadAdminData(session.accessToken);
                  } catch (publishError) {
                    setError(publishError instanceof Error ? publishError.message : "Publish failed");
                  } finally {
                    setBusyAction(null);
                  }
                });
              }}
            >
              {busyAction === "publish-contest" ? "Publishing..." : "Publish Contest"}
            </button>
          </div>
        </div>
      </div>

    </SiteShell>
  );
}
