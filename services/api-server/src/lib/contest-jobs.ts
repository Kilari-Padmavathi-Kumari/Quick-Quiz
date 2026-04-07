import { pool } from "@quiz-app/db";
import {
  contestLifecycleJobNames,
  contestLifecycleQueue
} from "@quiz-app/queues";

const makeJobId = (...parts: Array<string | number>) => parts.join("__");

export async function ensureContestJobs(contestId: string, organizationId: string) {
  const contestResult = await pool.query<{
    id: string;
    status: string;
    starts_at: string;
    current_q: number;
    q_started_at: string | null;
  }>(
    `
      SELECT id, status, starts_at, current_q, q_started_at
      FROM contests
      WHERE id = $1
        AND organization_id = $2
      LIMIT 1
    `,
    [contestId, organizationId]
  );

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found while recovering jobs");
  }

  const contest = contestResult.rows[0];
  const questionsResult = await pool.query<{
    seq: number;
    time_limit_sec: number;
    revealed_at: string | null;
  }>(
    `
      SELECT q.seq, q.time_limit_sec, q.revealed_at
      FROM questions q
      JOIN contests c ON c.id = q.contest_id
      WHERE q.contest_id = $1
        AND q.organization_id = $2
        AND c.organization_id = $2
      ORDER BY seq ASC
    `,
    [contestId, organizationId]
  );

  if (contest.status === "open") {
    const delay = Math.max(0, new Date(contest.starts_at).getTime() - Date.now());
    await contestLifecycleQueue.add(
      contestLifecycleJobNames.startContest,
      { organizationId, contestId },
      {
        jobId: makeJobId(organizationId, contestLifecycleJobNames.startContest, contestId),
        delay,
        attempts: 3
      }
    );
    return { contestId, action: "scheduled-start" };
  }

  if (contest.status !== "live") {
    return { contestId, action: "no-op", status: contest.status };
  }

  if (contest.current_q <= 0 || !contest.q_started_at) {
    return { contestId, action: "live-missing-state" };
  }

  const currentQuestion = questionsResult.rows.find((question) => question.seq === contest.current_q);

  if (!currentQuestion) {
    return { contestId, action: "live-missing-question" };
  }

  const elapsedMs = Date.now() - new Date(contest.q_started_at).getTime();
  const revealDelay = Math.max(0, currentQuestion.time_limit_sec * 1000 - elapsedMs);

  if (!currentQuestion.revealed_at) {
    await contestLifecycleQueue.add(
      contestLifecycleJobNames.revealQuestion,
      { organizationId, contestId, seq: contest.current_q },
      {
        jobId: makeJobId(organizationId, contestLifecycleJobNames.revealQuestion, contestId, contest.current_q),
        delay: revealDelay
      }
    );
  }

  const nextQuestion = questionsResult.rows.find((question) => question.seq === contest.current_q + 1);

  if (nextQuestion) {
    await contestLifecycleQueue.add(
      contestLifecycleJobNames.broadcastQuestion,
      { organizationId, contestId, seq: nextQuestion.seq },
      {
        jobId: makeJobId(organizationId, contestLifecycleJobNames.broadcastQuestion, contestId, nextQuestion.seq),
        delay: revealDelay + 3000
      }
    );
    return { contestId, action: "scheduled-next-question", seq: nextQuestion.seq };
  }

  await contestLifecycleQueue.add(
    contestLifecycleJobNames.endContest,
    { organizationId, contestId },
    {
      jobId: makeJobId(organizationId, contestLifecycleJobNames.endContest, contestId),
      delay: revealDelay + 3000
    }
  );

  return { contestId, action: "scheduled-end-contest" };
}
