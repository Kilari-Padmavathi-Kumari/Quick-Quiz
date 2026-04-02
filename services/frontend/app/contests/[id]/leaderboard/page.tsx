"use client";

import { useParams } from "next/navigation";
import { startTransition, useEffect, useState } from "react";

import { Avatar } from "../../../../components/avatar";
import { useFrontendSession } from "../../../../components/session-panel";
import { SiteShell } from "../../../../components/site-shell";
import { getLeaderboard, type PrizeRule } from "../../../../lib/api";

interface LeaderboardRow {
  user_id: string;
  name: string;
  avatar_url: string | null;
  correct_count: string;
  is_winner: boolean;
  prize_amount: string;
}

function getPrizeRuleLabel(prizeRule: PrizeRule) {
  return prizeRule === "all_correct" ? "All Correct" : "Top Scorer";
}

function getPrizeRuleDescription(prizeRule: PrizeRule) {
  return prizeRule === "all_correct"
    ? "Perfect scores win first. If nobody is perfect, the top scorer becomes the winner."
    : "The player with the highest correct score wins, and ties split the prize.";
}

function getRankDisplay(rank: number) {
  if (rank === 1) {
    return "\uD83C\uDFC6";
  }

  if (rank === 2) {
    return "\uD83E\uDD48";
  }

  if (rank === 3) {
    return "\uD83E\uDD49";
  }

  return `#${rank}`;
}

export default function LeaderboardPage() {
  const params = useParams<{ id: string }>();
  const { session } = useFrontendSession();
  const contestId = params.id;
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [contestTitle, setContestTitle] = useState("");
  const [prizeRule, setPrizeRule] = useState<PrizeRule | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    startTransition(async () => {
      try {
        const result = await getLeaderboard(contestId);
        setContestTitle(result.contest.title);
        setPrizeRule(result.contest.prize_rule);
        setRows(result.leaderboard);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load leaderboard");
      }
    });
  }, [contestId]);

  return (
    <SiteShell
      title="Contest Leaderboard"
      subtitle="Final ranking, winners, and prize amounts for the selected contest."
    >
      <div className="card card-luxe">
        <div className="eyebrow">Contest</div>
        <h2 style={{ margin: "12px 0 0" }}>{contestTitle || "Contest Result"}</h2>
        {prizeRule ? (
          <>
            <div className="pill-row" style={{ marginTop: 12 }}>
              <span className="pill gold">{getPrizeRuleLabel(prizeRule)}</span>
            </div>
            <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
              {getPrizeRuleDescription(prizeRule)}
            </p>
          </>
        ) : null}
        <div className="mono" style={{ marginTop: 12 }}>
          {contestId}
        </div>
      </div>

      {error ? <div className="notice error" style={{ marginTop: 18 }}>{error}</div> : null}

      <div className="leaderboard-legend" style={{ marginTop: 18 }}>
        <span className="leaderboard-legend__item">
          <span className="leaderboard-legend__icon">{getRankDisplay(1)}</span>
          Champion
        </span>
        <span className="leaderboard-legend__item">
          <span className="leaderboard-legend__icon">{getRankDisplay(2)}</span>
          Runner-up
        </span>
        <span className="leaderboard-legend__item">
          <span className="leaderboard-legend__icon">{getRankDisplay(3)}</span>
          Third place
        </span>
      </div>

      <div className="leaderboard-board" style={{ marginTop: 18 }}>
        {rows.length === 0 ? (
          <div className="empty-state empty-state--leaderboard">
            <div className="empty-state__eyebrow">Leaderboard</div>
            <strong>No leaderboard entries yet</strong>
            <p>Once the contest finishes, rankings, winners, and prize amounts will appear here.</p>
          </div>
        ) : null}

        {rows.map((row, index) => {
          return (
            <div
              key={row.user_id}
              className={[
                "leaderboard-row",
                row.is_winner ? "leaderboard-row--winner" : "",
                session?.userId === row.user_id ? "leaderboard-row--you" : "",
                index === 0 ? "leaderboard-row--first" : "",
                index === 1 ? "leaderboard-row--second" : "",
                index === 2 ? "leaderboard-row--third" : ""
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="leaderboard-row__shell">
                <div className="leaderboard-row__main">
                  <div className="leaderboard-rankline">
                  <span className="leaderboard-rank" title={`Rank #${index + 1}`}>
                    {getRankDisplay(index + 1)}
                  </span>
                    <Avatar
                      name={row.name}
                      src={row.avatar_url}
                      className="leaderboard-avatar"
                      imageClassName="leaderboard-avatar leaderboard-avatar--image"
                    />
                    <div className="leaderboard-player">
                      <div className="leaderboard-player__heading">
                        <h3 className="leaderboard-player__name">{row.name}</h3>
                        {session?.userId === row.user_id ? <span className="leaderboard-chip leaderboard-chip--you">You</span> : null}
                      </div>
                      <div className="leaderboard-player__meta">
                        <span className="leaderboard-chip">Correct {row.correct_count}</span>
                        {row.is_winner ? <span className="leaderboard-chip leaderboard-chip--winner">Winner</span> : null}
                        <span className="leaderboard-chip leaderboard-chip--prize">Prize Rs {row.prize_amount}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="leaderboard-score">
                  <div className="leaderboard-score__value">{row.correct_count}</div>
                  <div className="leaderboard-score__label">correct</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </SiteShell>
  );
}
