"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { LoginCard } from "../../../../components/login-card";
import { SiteShell } from "../../../../components/site-shell";
import { useFrontendSession } from "../../../../components/session-panel";
import { GAME_URL } from "../../../../lib/config";
import { appendOrganizationSlugToPath } from "../../../../lib/tenant";

type Option = "a" | "b" | "c" | "d";

interface QuestionPayload {
  seq: number;
  body: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  time_limit_sec: number;
  server_time: number;
}

interface LeaderboardEntry {
  user_id: string;
  name: string;
  correct_count: number;
  is_winner: boolean;
  prize_amount: string;
}

export default function LiveContestPage() {
  const params = useParams<{ id: string }>();
  const contestId = params.id;
  const { session, isReady } = useFrontendSession();

  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState("Waiting for socket connection...");
  const [question, setQuestion] = useState<QuestionPayload | null>(null);
  const [selectedOption, setSelectedOption] = useState<Option | null>(null);
  const [answerResult, setAnswerResult] = useState<{ is_correct: boolean; your_score: number } | null>(null);
  const [reveal, setReveal] = useState<Option | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [revealCountdown, setRevealCountdown] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [prizeAmount, setPrizeAmount] = useState("0.00");
  const [youWon, setYouWon] = useState(false);
  const [socketError, setSocketError] = useState<string | null>(null);
  const leaderboardHref = session
    ? appendOrganizationSlugToPath(`/contests/${contestId}/leaderboard`, session.organizationSlug)
    : `/contests/${contestId}/leaderboard`;

  useEffect(() => {
    if (!session?.accessToken) {
      return;
    }

    const socket = io(GAME_URL, {
      transports: ["websocket"],
      auth: {
        token: session.accessToken,
        contest_id: contestId
      }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus(`Connected to contest ${contestId}`);
      setSocketError(null);
    });

    socket.on("connect_error", (error) => {
      setSocketError(error.message);
      setStatus("Socket connection failed");
    });

    socket.on("reconnected", (payload) => {
      setStatus(`Reconnected to live state on question ${payload.current_q}`);
      setTimeRemaining(payload.time_remaining ?? 0);
    });

    socket.on("lobby_update", (payload) => {
      setStatus(`Lobby update: ${payload.member_count} players, prize Rs ${payload.prize_pool}`);
    });

    socket.on("question", (payload: QuestionPayload) => {
      setQuestion(payload);
      setSelectedOption(null);
      setAnswerResult(null);
      setReveal(null);
      setRevealCountdown(0);
      setStatus(`Question ${payload.seq} is live`);
    });

    socket.on("answer_result", (payload) => {
      setAnswerResult(payload);
      setStatus(payload.is_correct ? "Answer recorded as correct" : "Answer recorded as wrong");
    });

    socket.on("reveal", (payload: { correct_option: Option }) => {
      setReveal(payload.correct_option);
      setRevealCountdown(3);
      setStatus(`Answer revealed for question ${question?.seq ?? payload.correct_option}`);
    });

    socket.on("contest_ended", (payload) => {
      setLeaderboard(payload.leaderboard ?? []);
      setYouWon(Boolean(payload.you_won));
      setPrizeAmount(String(payload.prize_amount ?? "0.00"));
      setStatus("Contest ended");
    });

    socket.on("error", (payload: { code?: string }) => {
      setSocketError(payload.code ?? "SERVER_ERROR");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [contestId, session?.accessToken]);

  useEffect(() => {
    if (!question) {
      setTimeRemaining(0);
      return;
    }

    const interval = window.setInterval(() => {
      const deadline = question.server_time + question.time_limit_sec * 1000;
      const nextValue = Math.max(0, deadline - Date.now());
      setTimeRemaining(nextValue);
    }, 200);

    return () => window.clearInterval(interval);
  }, [question]);

  useEffect(() => {
    if (revealCountdown <= 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setRevealCountdown((current) => Math.max(0, current - 1));
    }, 1000);

    return () => window.clearTimeout(timeout);
  }, [revealCountdown]);

  const options = useMemo(
    () =>
      question
        ? ([
            ["a", question.option_a],
            ["b", question.option_b],
            ["c", question.option_c],
            ["d", question.option_d]
          ] as const)
        : [],
    [question]
  );
  const totalQuestionMs = question ? question.time_limit_sec * 1000 : 0;
  const timePercent = totalQuestionMs > 0 ? Math.max(0, Math.min(100, (timeRemaining / totalQuestionMs) * 100)) : 0;

  if (!isReady) {
    return (
      <SiteShell title="Live Contest" subtitle="Preparing local session...">
        <div className="notice">Loading session...</div>
      </SiteShell>
    );
  }

  if (!session) {
    return (
      <SiteShell
        title="Live Contest"
        subtitle="Sign in before joining a live contest room."
      >
        <LoginCard targetHref={`/contests/${contestId}/live`} />
      </SiteShell>
    );
  }

  return (
    <SiteShell
      title="Live Contest Room"
      subtitle="This page is connected to the actual Socket.io game server and follows worker-driven contest events."
    >
      <div className="grid two">
        <div className="card card-luxe live-shell-card">
          <div className="eyebrow">Contest</div>
          <div className="mono" style={{ marginTop: 14 }}>
            {contestId}
          </div>
          <p className="muted">{status}</p>
          {socketError ? <div className="notice error">{socketError}</div> : null}
          <div className="live-timer">
            <div className="live-timer__meta">
              <span className="pill gold">Time {Math.ceil(timeRemaining / 1000)}s</span>
              {question ? <span className="pill">Q{question.seq}</span> : null}
            </div>
            <div className="live-timer__track">
              <div className="live-timer__fill" style={{ width: `${timePercent}%` }} />
            </div>
          </div>
          <div className="pill-row" style={{ marginTop: 12 }}>
            {answerResult ? (
              <span className={`pill ${answerResult.is_correct ? "pill--live" : "pill--cancelled"}`}>
                Score {answerResult.your_score}
              </span>
            ) : null}
            {revealCountdown > 0 ? <span className="pill">Next question in {revealCountdown}s</span> : null}
          </div>
        </div>

        <div className="card card-luxe live-shell-card">
          <div className="eyebrow">Result State</div>
          <div className="list" style={{ marginTop: 14 }}>
            <div className="notice notice-luxe">
              Selected option: <span className="mono">{selectedOption ?? "-"}</span>
            </div>
            <div className="notice notice-luxe">
              Revealed option: <span className="mono">{reveal ?? "-"}</span>
            </div>
            <div className="notice notice-luxe">
              Post-reveal countdown: <span className="mono">{revealCountdown}s</span>
            </div>
            <div className="notice notice-luxe">
              Prize if won: <span className="mono">Rs {prizeAmount}</span>
            </div>
          </div>
        </div>
      </div>

      {question ? (
        <div className="live-board" style={{ marginTop: 24 }}>
          <div className="card card-luxe live-question-card">
            <div className="live-question-card__top">
              <div className="eyebrow">Question {question.seq}</div>
              <span className="pill">{question.time_limit_sec}s window</span>
            </div>
            <h2 className="section-title live-question-card__title" style={{ marginTop: 14 }}>
              {question.body}
            </h2>

            <div className="answer-grid" style={{ marginTop: 18 }}>
              {options.map(([key, value]) => {
                const isSelected = selectedOption === key;
                const isCorrect = reveal === key;
                const isWrongSelected = reveal !== null && isSelected && reveal !== key;
                const optionState = isCorrect ? "Correct answer" : isWrongSelected ? "Your choice" : "Option";

                return (
                  <button
                    key={key}
                    type="button"
                    className={[
                      "answer-button",
                      isSelected ? "selected" : "",
                      isCorrect ? "correct" : "",
                      isWrongSelected ? "wrong" : ""
                    ].join(" ").trim()}
                    onClick={() => {
                      setSelectedOption(key);
                      setSocketError(null);
                      socketRef.current?.emit("submit_answer", {
                        contest_id: contestId,
                        question_seq: question.seq,
                        chosen_option: key
                      });
                    }}
                    disabled={timeRemaining <= 0 || reveal !== null}
                  >
                    <span className="answer-button__key">{key.toUpperCase()}</span>
                    <div className="answer-button__body">{value}</div>
                    <span className="answer-button__state">{optionState}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="notice warn" style={{ marginTop: 24 }}>
          Waiting for the worker to broadcast the next live question. Open this page a little before
          contest start time.
        </div>
      )}

      {leaderboard.length > 0 ? (
        <div className="card card-luxe live-finished-card" style={{ marginTop: 24 }}>
          <div className="eyebrow">Contest Finished</div>
          <h2 className="section-title" style={{ marginTop: 14 }}>
            {youWon ? "You won this round." : "Round complete."}
          </h2>
          <p className="muted">Prize credited: Rs {prizeAmount}</p>
          <div className="list">
            {leaderboard.map((entry, index) => (
              <div key={entry.user_id} className="notice notice-luxe live-finished-card__row">
                <strong>#{index + 1} {entry.name}</strong>
                <span>Correct {entry.correct_count}</span>
                <span>Prize Rs {entry.prize_amount}</span>
              </div>
            ))}
          </div>
          <div className="stack-row" style={{ marginTop: 16 }}>
            <Link href={leaderboardHref} className="solid-button">
              Open Leaderboard Page
            </Link>
            <Link href="/dashboard" className="ghost-button">
              Back to Dashboard
            </Link>
          </div>
        </div>
      ) : null}
    </SiteShell>
  );
}
