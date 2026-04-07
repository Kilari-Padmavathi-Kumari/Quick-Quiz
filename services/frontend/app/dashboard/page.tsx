"use client";

import Link from "next/link";
import { startTransition, useEffect, useState } from "react";

import { Avatar } from "../../components/avatar";
import { LoginCard } from "../../components/login-card";
import { SiteShell } from "../../components/site-shell";
import { useFrontendSession } from "../../components/session-panel";
import {
  type PrizeRule,
  getAllContests,
  getContestHistory,
  getWalletBalance,
  getWalletRequests,
  getWalletTransactions,
  joinContest,
  requestMoney
} from "../../lib/api";
import { appendOrganizationSlugToPath } from "../../lib/tenant";

interface ContestItem {
  id: string;
  title: string;
  status: string;
  entry_fee: string;
  max_members: number;
  member_count: number;
  starts_at: string;
  prize_pool: string;
  prize_rule: PrizeRule;
}

interface WalletTransactionItem {
  id: string;
  type: "credit" | "debit";
  reason: "entry_fee" | "prize" | "refund" | "topup" | "manual_topup";
  amount: string;
  balance_before: string;
  balance_after: string;
  reference_id: string | null;
  metadata?: {
    contestId?: string;
    contestTitle?: string;
    source?: string;
  };
  created_at: string;
}

interface ContestHistoryItem {
  contest_id: string;
  title: string;
  status: string;
  entry_fee: string;
  member_count: number;
  max_members: number;
  starts_at: string;
  joined_at: string;
  is_winner: boolean;
  prize_amount: string;
  correct_count: string;
  prize_pool: string;
  prize_rule: PrizeRule;
}

interface WalletRequestItem {
  id: string;
  amount: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  reviewed_at: string | null;
}

type ContestTab = "all" | "current" | "future" | "past";
const CONTEST_TAB_STORAGE_KEY = "quiz-app-dashboard-contest-tab";

function DashboardStatCard({
  eyebrow,
  value,
  description,
  tone
}: {
  eyebrow: string;
  value: string;
  description: string;
  tone: string;
}) {
  const [showInfo, setShowInfo] = useState(false);

  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-card__top">
        <div className="eyebrow">{eyebrow}</div>
        <button
          type="button"
          className="stat-card__info-button"
          aria-expanded={showInfo}
          aria-label={`Show info for ${eyebrow}`}
          onClick={() => setShowInfo((current) => !current)}
        >
          i
        </button>
      </div>
      {showInfo ? (
        <div className="stat-card__info-panel">
          <div className="stat-value">{value}</div>
          <p className="muted stat-card__info-copy">{description}</p>
        </div>
      ) : null}
    </div>
  );
}

function getPrizeRuleLabel(prizeRule: PrizeRule) {
  return prizeRule === "all_correct" ? "All Correct" : "Top Scorer";
}

function getPrizeRuleDescription(prizeRule: PrizeRule) {
  return prizeRule === "all_correct"
    ? "Full marks win the contest. If nobody is perfect, the top scorer wins."
    : "The highest correct score wins; ties split the prize.";
}

function getStatusPillClass(status: string) {
  if (status === "live") {
    return "pill pill--live";
  }

  if (status === "open") {
    return "pill pill--open";
  }

  if (status === "draft") {
    return "pill pill--draft";
  }

  if (status === "ended") {
    return "pill pill--ended";
  }

  if (status === "cancelled") {
    return "pill pill--cancelled";
  }

  return "pill";
}

function formatContestTiming(contest: ContestItem | ContestHistoryItem) {
  const startsAt = new Date(contest.starts_at);
  const diffMinutes = Math.round((startsAt.getTime() - Date.now()) / 60000);

  if (contest.status === "live") {
    return "Live right now";
  }

  if (contest.status !== "ended" && contest.status !== "cancelled" && diffMinutes > 0 && diffMinutes < 60) {
    return `Starts in ${diffMinutes} min`;
  }

  if (contest.status !== "ended" && contest.status !== "cancelled" && diffMinutes >= 60 && diffMinutes < 1440) {
    return `Starts in ${Math.round(diffMinutes / 60)} hr`;
  }

  return `${contest.status === "ended" || contest.status === "cancelled" ? "Started" : "Starts"} ${startsAt.toLocaleString()}`;
}

function formatTransactionReason(transaction: WalletTransactionItem) {
  if (transaction.reason === "entry_fee") {
    return transaction.metadata?.contestTitle
      ? `Contest joined: ${transaction.metadata.contestTitle}`
      : "Contest entry fee";
  }

  if (transaction.reason === "manual_topup") {
    return "Wallet top-up";
  }

  if (transaction.reason === "prize") {
    return transaction.metadata?.contestTitle
      ? `Prize won: ${transaction.metadata.contestTitle}`
      : transaction.reference_id
        ? `Prize won: Contest ${transaction.reference_id}`
        : "Contest prize";
  }

  if (transaction.reason === "refund") {
    return transaction.metadata?.contestTitle
      ? `Refund received: ${transaction.metadata.contestTitle}`
      : transaction.reference_id
        ? `Refund received: Contest ${transaction.reference_id}`
        : "Contest refund";
  }

  return "Wallet update";
}

function getContestBucket(contest: ContestItem) {
  const startsAtMs = new Date(contest.starts_at).getTime();
  const now = Date.now();

  if (contest.status === "ended" || contest.status === "cancelled") {
    return "past";
  }

  if (contest.status === "live" || contest.status === "open") {
    return "current";
  }

  if (contest.status === "draft" && startsAtMs > now) {
    return "future";
  }

  return "past";
}

export default function DashboardPage() {
  const { session, isReady } = useFrontendSession();
  const [walletBalance, setWalletBalance] = useState<string>("0.00");
  const [contests, setContests] = useState<ContestItem[]>([]);
  const [contestHistory, setContestHistory] = useState<ContestHistoryItem[]>([]);
  const [transactions, setTransactions] = useState<WalletTransactionItem[]>([]);
  const [walletRequests, setWalletRequests] = useState<WalletRequestItem[]>([]);
  const [amount, setAmount] = useState("50");
  const [contestLookupId, setContestLookupId] = useState("");
  const [contestTab, setContestTab] = useState<ContestTab>("all");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const totalContestAttempts = contestHistory.length;
  const totalWins = contestHistory.filter((contest) => contest.is_winner).length;
  const totalPrizeWon = contestHistory
    .reduce((total, contest) => total + Number(contest.prize_amount), 0)
    .toFixed(2);
  const pendingWalletRequest = walletRequests.find((request) => request.status === "pending") ?? null;
  const currentContests = contests.filter((contest) => getContestBucket(contest) === "current");
  const futureContests = contests.filter((contest) => getContestBucket(contest) === "future");
  const pastContests = contests.filter((contest) => getContestBucket(contest) === "past");
  const visibleContests =
    contestTab === "all"
      ? contests
      : contestTab === "current"
        ? currentContests
        : contestTab === "future"
          ? futureContests
          : pastContests;

  const tabMeta: Record<
    ContestTab,
    { eyebrow: string; title: string; empty: string; label: string; icon: string }
  > = {
    all: {
      eyebrow: "All Contests",
      title: "Every contest in one place",
      empty: "No contests available right now.",
      label: "All",
      icon: "Grid"
    },
    current: {
      eyebrow: "Current Contests",
      title: "Join what is active now",
      empty: "No current contests right now. Create or publish one from the admin console.",
      label: "Current",
      icon: "Live"
    },
    future: {
      eyebrow: "Upcoming Contests",
      title: "Future contests to watch",
      empty: "No future contests scheduled right now.",
      label: "Upcoming",
      icon: "Soon"
    },
    past: {
      eyebrow: "Past Contests",
      title: "Previous rounds and results",
      empty: "No past contests yet.",
      label: "Past",
      icon: "Done"
    }
  };

  async function loadData(accessToken: string) {
    setError(null);
    setIsLoadingData(true);

    try {
      const [walletResult, contestResult, transactionsResult, contestHistoryResult, walletRequestsResult] = await Promise.all([
        getWalletBalance(accessToken),
        getAllContests(),
        getWalletTransactions(accessToken),
        getContestHistory(accessToken),
        getWalletRequests(accessToken)
      ]);

      setWalletBalance(walletResult.wallet_balance);
      setContests(contestResult.contests);
      setTransactions(transactionsResult.transactions);
      setContestHistory(contestHistoryResult.contests);
      setWalletRequests(walletRequestsResult.requests);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard");
    } finally {
      setIsLoadingData(false);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedTab = window.localStorage.getItem(CONTEST_TAB_STORAGE_KEY) as ContestTab | null;
    if (storedTab && ["all", "current", "future", "past"].includes(storedTab)) {
      setContestTab(storedTab);
    }
  }, []);

  useEffect(() => {
    if (!session?.accessToken) {
      return;
    }

    startTransition(() => {
      void loadData(session.accessToken);
    });
  }, [session]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(CONTEST_TAB_STORAGE_KEY, contestTab);
  }, [contestTab]);

  if (!isReady) {
    return (
      <SiteShell title="Player Dashboard" subtitle="Loading local session..." density="compact">
        <div className="notice">Checking saved session...</div>
      </SiteShell>
    );
  }

  if (!session) {
    return (
      <SiteShell
        title="Player Dashboard"
        subtitle="Request a one-time code to access wallet, contests, and live gameplay."
        density="compact"
      >
        <LoginCard targetHref="/dashboard" />
      </SiteShell>
    );
  }

  if (session.role === "super_admin") {
    return (
      <SiteShell title="Player Dashboard" subtitle="Super admins use the global control panel only." density="compact">
        <div className="notice">Open the Super Admin dashboard for global controls.</div>
      </SiteShell>
    );
  }

  if (session.role === "pending" || session.userStatus === "pending") {
    return (
      <SiteShell title="" subtitle="" density="compact">
        <section />
      </SiteShell>
    );
  }

  return (
    <SiteShell
      title={session.isAdmin ? "Admin Dashboard" : "Player Dashboard"}
      subtitle={
        session.isAdmin
          ? ""
          : "Track your wallet, join live rounds, and follow results from one clean player view."
      }
      density="compact"
    >
      <div className="dashboard-layout">
        <div className="dashboard-section-stack">
        <div className="dashboard-stats-grid">
          <DashboardStatCard
            eyebrow="Wallet"
            value={`Rs ${walletBalance}`}
            description="Balance updates after approved requests and contest activity."
            tone="stat-card--wallet"
          />

          <DashboardStatCard
            eyebrow="Performance"
            value={`${totalWins}/${totalContestAttempts}`}
            description="Wins versus total completed contest attempts."
            tone="stat-card--performance"
          />

          <DashboardStatCard
            eyebrow="Prize Credits"
            value={`Rs ${totalPrizeWon}`}
            description="Total prize money credited back to this wallet."
            tone="stat-card--prize"
          />
        </div>

        <div className="dashboard-actions-grid">
          <div className="card dashboard-card">
            <div className="eyebrow">Request Money</div>
            <label className="field" style={{ marginTop: 12 }}>
              <span>Amount</span>
              <input value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
            <p className="muted" style={{ marginTop: 12 }}>
              Admin gets this in Wallet Requests.
            </p>
            {pendingWalletRequest ? (
              <div className="notice warn" style={{ marginTop: 12 }}>
                You already have a pending request for Rs {pendingWalletRequest.amount}. Wait for admin approval first.
              </div>
            ) : null}
            <button
              type="button"
              className="solid-button"
              disabled={busyAction === "request-money" || Boolean(pendingWalletRequest)}
              onClick={() => {
                setMessage(null);
                setError(null);
                setBusyAction("request-money");

                startTransition(async () => {
                  try {
                    await requestMoney(session.accessToken, Number(amount));
                    setMessage("Success: wallet credit request sent to admin.");
                    await loadData(session.accessToken);
                  } catch (topupError) {
                    setError(topupError instanceof Error ? topupError.message : "Wallet request failed");
                  } finally {
                    setBusyAction(null);
                  }
                });
              }}
            >
              {pendingWalletRequest
                ? "Request Pending"
                : busyAction === "request-money"
                  ? "Sending request..."
                  : "Send Wallet Request"}
            </button>
          </div>

          <div className="card dashboard-card">
            <div className="eyebrow">Quick Open</div>
            <label className="field" style={{ marginTop: 12 }}>
              <span>Contest ID</span>
              <input
                value={contestLookupId}
                onChange={(event) => setContestLookupId(event.target.value)}
                placeholder="Paste a contest UUID"
              />
            </label>
            <div className="stack-row">
              <Link
                href={contestLookupId ? appendOrganizationSlugToPath(`/contests/${contestLookupId}/live`, session?.organizationSlug) : "/dashboard"}
                className="ghost-button"
              >
                Open Live Room
              </Link>
              <Link
                href={contestLookupId ? appendOrganizationSlugToPath(`/contests/${contestLookupId}/leaderboard`, session?.organizationSlug) : "/dashboard"}
                className="solid-button"
              >
                Open Leaderboard
              </Link>
            </div>
          </div>
        </div>

        <div className="dashboard-followup-stack">
        {message ? <div className="notice success">{message}</div> : null}
        {error ? <div className="notice error">{error}</div> : null}

        {isLoadingData ? (
          <div className="loading-grid dashboard-loading-grid">
            <div className="loading-card loading-card--panel" />
            <div className="loading-card loading-card--panel" />
            <div className="loading-card loading-card--panel" />
          </div>
        ) : null}

      <details className="dashboard-dropdown dashboard-panel dashboard-panel--requests">
        <summary className="dashboard-dropdown__summary">
          <div className="section-heading">
            <div className="eyebrow">Request Status</div>
            <h2 className="section-title">Wallet requests</h2>
          </div>
          <span className="dashboard-dropdown__icon" aria-hidden="true">v</span>
        </summary>

        <div className="list dashboard-dropdown__content">
          {walletRequests.length === 0 ? (
            <div className="empty-state empty-state--wallet">
              <div className="empty-state__eyebrow">Request Queue</div>
              <strong>No wallet requests yet</strong>
              <p>Send a request above and admin approval updates will appear here.</p>
            </div>
          ) : null}

          {walletRequests.map((request) => (
            <article key={request.id} className="notice notice-luxe">
              <div className="stack-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>Requested Rs {request.amount}</strong>
                  <div className="muted">Requested {new Date(request.requested_at).toLocaleString()}</div>
                  {request.reviewed_at ? (
                    <div className="muted">Reviewed {new Date(request.reviewed_at).toLocaleString()}</div>
                  ) : (
                    <div className="muted">Waiting for admin approval</div>
                  )}
                </div>

                <div className="pill-row">
                  <span
                    className={
                      request.status === "approved"
                        ? "pill pill--ended"
                        : request.status === "rejected"
                          ? "pill pill--cancelled"
                          : "pill pill--open"
                    }
                  >
                    {request.status}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </details>

      <details className="dashboard-dropdown dashboard-panel dashboard-panel--payments">
        <summary className="dashboard-dropdown__summary">
          <div className="section-heading">
            <div className="eyebrow">Payment History</div>
            <h2 className="section-title">Wallet ledger</h2>
          </div>
          <span className="dashboard-dropdown__icon" aria-hidden="true">v</span>
        </summary>

        <div className="list dashboard-dropdown__content">
          {transactions.length === 0 ? (
            <div className="empty-state empty-state--wallet">
              <div className="empty-state__eyebrow">Wallet Story</div>
              <strong>No wallet activity yet</strong>
              <p>
                After this user adds money, joins a contest, gets a refund, or wins a prize, the ledger will show the
                full money trail here.
              </p>
            </div>
          ) : null}

          {transactions.map((transaction) => (
            <article key={transaction.id} className="notice notice-luxe">
              <div className="stack-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>{formatTransactionReason(transaction)}</strong>
                  <div className="muted">{new Date(transaction.created_at).toLocaleString()}</div>
                  <div className="muted">
                    {transaction.type === "credit" ? "Credit" : "Debit"} | Before Rs {transaction.balance_before}
                  </div>
                </div>

                <div className="pill-row">
                  <span className={`pill ${transaction.type === "credit" ? "gold" : "rose"}`}>
                    {transaction.type === "credit" ? "+" : "-"}Rs {transaction.amount}
                  </span>
                  <span className="pill">Balance Rs {transaction.balance_after}</span>
                </div>
              </div>

              {transaction.reference_id ? (
                <div className="mono" style={{ marginTop: 10, fontSize: "0.84rem" }}>
                  Ref: {transaction.reference_id}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </details>

      <details className="dashboard-dropdown dashboard-panel dashboard-panel--history">
        <summary className="dashboard-dropdown__summary">
          <div className="section-heading">
            <div className="eyebrow">Contest History</div>
            <h2 className="section-title">Attempts, results, and winners</h2>
          </div>
          <span className="dashboard-dropdown__icon" aria-hidden="true">v</span>
        </summary>

        <div className="list dashboard-dropdown__content">
          {contestHistory.length === 0 ? (
            <div className="empty-state empty-state--history">
              <div className="empty-state__eyebrow">Contest Journey</div>
              <strong>No contest history yet</strong>
              <p>This section fills in after the current user joins and completes at least one contest.</p>
            </div>
          ) : null}

          {contestHistory.map((contest) => (
            <article key={contest.contest_id} className="contest-card contest-card--luxe">
              <div className="stack-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: "0 0 8px" }}>{contest.title}</h3>
                  <div className="contest-meta">
                    <span className={getStatusPillClass(contest.status)}>{contest.status}</span>
                    <span className="pill">{getPrizeRuleLabel(contest.prize_rule)}</span>
                    <span className="pill gold">Entry Rs {contest.entry_fee}</span>
                    <span className="pill">{contest.correct_count} correct</span>
                    <span className={contest.is_winner ? "pill gold" : "pill rose"}>
                      {contest.is_winner ? `Won Rs ${contest.prize_amount}` : "No prize"}
                    </span>
                  </div>
                </div>

                <div className="stack-row">
                  <Link href={appendOrganizationSlugToPath(`/contests/${contest.contest_id}/live`, session.organizationSlug)} className="ghost-button">
                    Open Contest
                  </Link>
                  {contest.status === "ended" ? (
                    <Link href={appendOrganizationSlugToPath(`/contests/${contest.contest_id}/leaderboard`, session.organizationSlug)} className="solid-button">
                      Leaderboard
                    </Link>
                  ) : null}
                </div>
              </div>

              <p className="muted" style={{ marginBottom: 0 }}>
                {getPrizeRuleDescription(contest.prize_rule)}
              </p>
              <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
                Joined {new Date(contest.joined_at).toLocaleString()} | {formatContestTiming(contest)}
              </p>
              <div className="mono" style={{ marginTop: 10, fontSize: "0.84rem" }}>
                {contest.contest_id} | {contest.member_count}/{contest.max_members} players | Prize pool Rs {contest.prize_pool}
              </div>
            </article>
          ))}
        </div>
      </details>

      <details className="dashboard-dropdown dashboard-panel dashboard-panel--contests" open>
        <summary className="dashboard-dropdown__summary">
          <div className="section-heading">
            <div className="eyebrow">{tabMeta[contestTab].eyebrow}</div>
            <h2 className="section-title">{tabMeta[contestTab].title}</h2>
          </div>
          <span className="dashboard-dropdown__icon" aria-hidden="true">v</span>
        </summary>

        <div className="dashboard-dropdown__content">
        <div className="tab-row" style={{ marginTop: 14, marginBottom: 18 }}>
          {(["all", "current", "future", "past"] as ContestTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={contestTab === tab ? "tab-button tab-button--active" : "tab-button"}
              onClick={() => setContestTab(tab)}
            >
              <span className="tab-button__icon">{tabMeta[tab].icon}</span>
              <span className="tab-button__label">
                {tabMeta[tab].label}
                {tab === "all" ? ` (${contests.length})` : null}
                {tab === "current" ? ` (${currentContests.length})` : null}
                {tab === "future" ? ` (${futureContests.length})` : null}
                {tab === "past" ? ` (${pastContests.length})` : null}
              </span>
            </button>
          ))}
        </div>

        <div className="list">
          {visibleContests.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state__eyebrow">Contest View</div>
              <strong>{tabMeta[contestTab].title}</strong>
              <p>{tabMeta[contestTab].empty}</p>
            </div>
          ) : null}

          {visibleContests.map((contest) => (
            <article key={contest.id} className="contest-card contest-card--luxe">
              <div className="stack-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: "0 0 8px" }}>{contest.title}</h3>
                  <div className="contest-meta">
                    <span className={getStatusPillClass(contest.status)}>{contest.status}</span>
                    <span className="pill">{getPrizeRuleLabel(contest.prize_rule)}</span>
                    <span className="pill gold">Entry Rs {contest.entry_fee}</span>
                    <span className="pill">{contest.member_count}/{contest.max_members} joined</span>
                    <span className="pill rose">Prize Rs {contest.prize_pool}</span>
                  </div>
                </div>

                <div className="stack-row">
                  {contest.status === "open" || contest.status === "live" ? (
                    <>
                      <button
                        type="button"
                        className="solid-button"
                        disabled={
                          busyAction === `join:${contest.id}` ||
                          contest.status !== "open" ||
                          contest.member_count >= contest.max_members
                        }
                        onClick={() => {
                          setMessage(null);
                          setError(null);
                          setBusyAction(`join:${contest.id}`);

                          startTransition(async () => {
                            try {
                              const result = await joinContest(session.accessToken, contest.id);
                              setWalletBalance(result.wallet_balance);
                              setMessage(`Success: joined ${contest.title}. Prize pool is now Rs ${result.prize_pool}.`);
                              await loadData(session.accessToken);
                            } catch (joinError) {
                              setError(joinError instanceof Error ? joinError.message : "Join failed");
                            } finally {
                              setBusyAction(null);
                            }
                          });
                        }}
                      >
                        {busyAction === `join:${contest.id}`
                          ? "Joining..."
                          : contest.status === "open"
                            ? "Join Contest"
                            : "Live Now"}
                      </button>

                      <Link href={appendOrganizationSlugToPath(`/contests/${contest.id}/live`, session.organizationSlug)} className="ghost-button">
                        Open Live View
                      </Link>
                    </>
                  ) : null}

                  {contest.status === "draft" ? (
                    <Link href={appendOrganizationSlugToPath(`/contests/${contest.id}/live`, session.organizationSlug)} className="ghost-button">
                      Preview Contest
                    </Link>
                  ) : null}

                  {contest.status === "ended" || contest.status === "cancelled" ? (
                    <>
                      <Link href={appendOrganizationSlugToPath(`/contests/${contest.id}/live`, session.organizationSlug)} className="ghost-button">
                        Open Contest
                      </Link>
                      {contest.status === "ended" ? (
                        <Link href={appendOrganizationSlugToPath(`/contests/${contest.id}/leaderboard`, session.organizationSlug)} className="solid-button">
                          View Leaderboard
                        </Link>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>

              <p className="muted" style={{ marginBottom: 0 }}>
                {getPrizeRuleDescription(contest.prize_rule)}
              </p>
              <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
                {formatContestTiming(contest)}
              </p>
              <div className="mono" style={{ marginTop: 10, fontSize: "0.84rem" }}>
                {contest.id}
              </div>
            </article>
          ))}
        </div>
        </div>
      </details>
      </div>
      </div>
      </div>
    </SiteShell>
  );
}
