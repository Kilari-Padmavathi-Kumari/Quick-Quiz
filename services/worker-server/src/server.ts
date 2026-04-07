import { createServer } from "node:http";

import {
  moneyToPaise,
  mutateWalletBalance,
  paiseToMoney,
  pool,
  withTransaction
} from "@quiz-app/db";
import {
  contestLifecycleJobNames,
  contestLifecycleQueue,
  payoutJobNames,
  payoutsQueue,
  type ContestLifecycleJobPayload,
  type PrizeCreditJobPayload,
  type RefundJobPayload
} from "@quiz-app/queues";
import {
  assertOrganizationId,
  contestAnsweredKey,
  contestChannel,
  contestMembersKey,
  contestQuestionKey,
  contestScoresKey,
  contestStateKey,
  createRedisClient
} from "@quiz-app/redis";
import { Job, Worker } from "bullmq";

process.on("unhandledRejection", (reason) => {
  console.error("[worker-server] Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[worker-server] Uncaught exception", error);
});

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379"
};
const workerPort = Number(process.env.WORKER_PORT ?? 4002);
const maxActiveJobsPerTenant = Math.max(1, Number(process.env.MAX_ACTIVE_JOBS_PER_TENANT ?? 3));
const staleContestRefundMinutes = Math.max(1, Number(process.env.STALE_CONTEST_REFUND_MINUTES ?? 5));
const recoverySweepIntervalMs = Math.max(15_000, Number(process.env.RECOVERY_SWEEP_INTERVAL_MS ?? 60_000));
const gameServerHealthUrl = process.env.GAME_SERVER_HEALTH_URL ?? `http://127.0.0.1:${process.env.GAME_PORT ?? 4001}/health`;

const redis = createRedisClient("worker-server");
await redis.connect();

const makeJobId = (...parts: Array<string | number>) => parts.join("__");
const activeJobsByTenant = new Map<string, number>();

function alertFailure(jobName: string, contestId: string, error: unknown) {
  console.error("ALERT: job failure", {
    jobName,
    contestId,
    error: error instanceof Error ? error.message : String(error)
  });
}

async function withTenantJobGuard<T>(organizationId: string, run: () => Promise<T>) {
  const tenantId = assertOrganizationId(organizationId);
  const active = activeJobsByTenant.get(tenantId) ?? 0;

  if (active >= maxActiveJobsPerTenant) {
    throw new Error(`Tenant ${tenantId} reached active job limit`);
  }

  activeJobsByTenant.set(tenantId, active + 1);

  try {
    return await run();
  } finally {
    const next = (activeJobsByTenant.get(tenantId) ?? 1) - 1;

    if (next <= 0) {
      activeJobsByTenant.delete(tenantId);
    } else {
      activeJobsByTenant.set(tenantId, next);
    }
  }
}

async function shouldTriggerRefundFallback(organizationId: string, contestId: string) {
  const contestResult = await pool.query<{
    status: string;
    current_q: number;
    ended_at: string | null;
  }>(
    `
      SELECT status, current_q, ended_at
      FROM contests
      WHERE id = $1
        AND organization_id = $2
      LIMIT 1
    `,
    [contestId, organizationId]
  );

  if (contestResult.rowCount !== 1) {
    return false;
  }

  const contest = contestResult.rows[0];
  if (contest.status !== "open" || contest.current_q > 0 || contest.ended_at) {
    return false;
  }

  const payoutResult = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM wallet_transactions
      WHERE organization_id = $1
        AND reference_id = $2
        AND reason IN ('prize', 'refund')
    `,
    [organizationId, contestId]
  );

  return Number(payoutResult.rows[0]?.count ?? "0") === 0;
}

async function contestHasSettledPayouts(organizationId: string, contestId: string) {
  const payoutResult = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM wallet_transactions
      WHERE organization_id = $1
        AND reference_id = $2
        AND reason IN ('prize', 'refund')
    `,
    [organizationId, contestId]
  );

  return Number(payoutResult.rows[0]?.count ?? "0") > 0;
}

async function updateContestLifecycle(
  contestId: string,
  organizationId: string,
  status: "open" | "live" | "ended" | "cancelled",
  lifecycleStatus: "PENDING" | "STARTED" | "COMPLETED" | "CANCELLED",
  options: {
    currentQ?: number;
    qStartedAtNow?: boolean;
    endedAtNow?: boolean;
    clearRuntimeState?: boolean;
  } = {}
) {
  const assignments = [
    `status = '${status}'`,
    `lifecycle_status = '${lifecycleStatus}'`,
    "updated_at = NOW()"
  ];

  if (typeof options.currentQ === "number") {
    assignments.push(`current_q = ${options.currentQ}`);
  }

  if (options.qStartedAtNow) {
    assignments.push("q_started_at = NOW()");
  }

  if (options.endedAtNow) {
    assignments.push("ended_at = NOW()");
  }

  if (options.clearRuntimeState) {
    assignments.push("current_q = 0");
    assignments.push("q_started_at = NULL");
  }

  await pool.query(
    `
      UPDATE contests
      SET ${assignments.join(",\n          ")}
      WHERE id = $1
        AND organization_id = $2
    `,
    [contestId, organizationId]
  );
}

async function updateEntryFeeTransactionStatus(
  organizationId: string,
  contestId: string,
  txStatus: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED",
  userId?: string
) {
  await pool.query(
    `
      UPDATE wallet_transactions
      SET tx_status = $4
      WHERE organization_id = $1
        AND reference_id = $2
        AND reason = 'entry_fee'
        AND ($3::uuid IS NULL OR user_id = $3)
    `,
    [organizationId, contestId, userId ?? null, txStatus]
  );
}

async function ensureGameServerReady() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(gameServerHealthUrl, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Game server health check returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelContestAndFlagPayments(contestId: string, organizationId: string) {
  // PostgreSQL stays the source of truth for failed starts and refund eligibility.
  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE contests
        SET status = 'cancelled',
            lifecycle_status = 'CANCELLED',
            current_q = 0,
            q_started_at = NULL,
            ended_at = COALESCE(ended_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
          AND organization_id = $2
      `,
      [contestId, organizationId]
    );

    await client.query(
      `
        UPDATE wallet_transactions
        SET tx_status = 'FAILED'
        WHERE organization_id = $1
          AND reference_id = $2
          AND reason = 'entry_fee'
          AND tx_status = 'PENDING'
      `,
      [organizationId, contestId]
    );
  });
}

async function ensureRefundContestJob(organizationId: string, contestId: string) {
  const jobId = makeJobId(organizationId, contestLifecycleJobNames.refundContest, contestId);
  const existing = await contestLifecycleQueue.getJob(jobId);

  if (!existing) {
    await contestLifecycleQueue.add(
      contestLifecycleJobNames.refundContest,
      { organizationId, contestId },
      { jobId }
    );
  }
}

async function recoverStaleRefunds() {
  const staleOpenContests = await pool.query<{
    id: string;
    organization_id: string;
  }>(
    `
      SELECT id, organization_id
      FROM contests
      WHERE status = 'open'
        AND current_q = 0
        AND ended_at IS NULL
        AND starts_at < NOW() - ($1::int * INTERVAL '1 minute')
    `,
    [staleContestRefundMinutes]
  );

  for (const contest of staleOpenContests.rows) {
    if (await shouldTriggerRefundFallback(contest.organization_id, contest.id)) {
      await ensureRefundContestJob(contest.organization_id, contest.id);
    }
  }

  const cancelledContests = await pool.query<{
    id: string;
    organization_id: string;
  }>(
    `
      SELECT id, organization_id
      FROM contests
      WHERE status = 'cancelled'
    `
  );

  for (const contest of cancelledContests.rows) {
    if (!(await contestHasSettledPayouts(contest.organization_id, contest.id))) {
      await ensureRefundContestJob(contest.organization_id, contest.id);
    }
  }
}

async function publishContestEvent(organizationId: string, contestId: string, payload: Record<string, unknown>) {
  assertOrganizationId(organizationId);
  await redis.publish(
    contestChannel(organizationId, contestId),
    JSON.stringify({
      ...payload,
      contest_id: contestId,
      organization_id: organizationId
    })
  );
}

async function getContestQuestions(contestId: string, organizationId: string) {
  const result = await pool.query<{
    id: string;
    seq: number;
    body: string;
    option_a: string;
    option_b: string;
    option_c: string;
    option_d: string;
    correct_option: string;
    time_limit_sec: number;
    revealed_at: string | null;
  }>(
    `
      SELECT q.id, q.seq, q.body, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.time_limit_sec, q.revealed_at
      FROM questions q
      JOIN contests c ON c.id = q.contest_id
      WHERE q.contest_id = $1
        AND q.organization_id = $2
        AND c.organization_id = $2
      ORDER BY seq ASC
    `,
    [contestId, organizationId]
  );

  return result.rows;
}

async function getContestOrganizationId(contestId: string) {
  const result = await pool.query<{ organization_id: string }>(
    `
      SELECT organization_id
      FROM contests
      WHERE id = $1
      LIMIT 1
    `,
    [contestId]
  );

  return result.rows[0]?.organization_id ?? null;
}

async function cacheContestState(organizationId: string, contestId: string, currentQ: number, qStartedAtMs: number) {
  assertOrganizationId(organizationId);
  await redis.hset(contestStateKey(organizationId, contestId), {
    organization_id: organizationId,
    current_q: String(currentQ),
    q_started_at: String(qStartedAtMs)
  });
}

async function cacheContestQuestions(
  organizationId: string,
  contestId: string,
  questions: Awaited<ReturnType<typeof getContestQuestions>>
) {
  assertOrganizationId(organizationId);
  const memberResult = await pool.query<{ user_id: string }>(
    `
      SELECT cm.user_id
      FROM contest_members cm
      JOIN contests c ON c.id = cm.contest_id
      WHERE cm.contest_id = $1
        AND cm.organization_id = $2
        AND c.organization_id = $2
      ORDER BY cm.joined_at ASC
    `,
    [contestId, organizationId]
  );
  const totalDurationMs =
    questions.reduce((total, question) => total + question.time_limit_sec * 1000 + 3000, 0) + 3600_000;
  const ttlSeconds = Math.ceil(totalDurationMs / 1000);
  const multi = redis.multi();

  multi.del(contestMembersKey(organizationId, contestId));
  if (memberResult.rows.length > 0) {
    multi.sadd(
      contestMembersKey(organizationId, contestId),
      ...memberResult.rows.map((member) => member.user_id)
    );
  }

  for (const question of questions) {
    multi.hset(contestQuestionKey(organizationId, contestId, question.seq), {
      organization_id: organizationId,
      id: question.id,
      seq: String(question.seq),
      body: question.body,
      option_a: question.option_a,
      option_b: question.option_b,
      option_c: question.option_c,
      option_d: question.option_d,
      correct_option: question.correct_option,
      time_limit_sec: String(question.time_limit_sec)
    });
    multi.expire(contestQuestionKey(organizationId, contestId, question.seq), ttlSeconds);
  }

  await multi.exec();
}

async function scheduleNextJobs(
  organizationId: string,
  contestId: string,
  questions: Awaited<ReturnType<typeof getContestQuestions>>,
  seq: number
) {
  const currentQuestion = questions.find((question) => question.seq === seq);

  if (!currentQuestion) {
    throw new Error(`Question ${seq} not found for contest ${contestId}`);
  }

  await contestLifecycleQueue.add(
    contestLifecycleJobNames.revealQuestion,
    { organizationId, contestId, seq },
    {
      jobId: makeJobId(organizationId, contestLifecycleJobNames.revealQuestion, contestId, seq),
      delay: currentQuestion.time_limit_sec * 1000
    }
  );

  const nextQuestion = questions.find((question) => question.seq === seq + 1);

  if (nextQuestion) {
    await contestLifecycleQueue.add(
      contestLifecycleJobNames.broadcastQuestion,
      { organizationId, contestId, seq: nextQuestion.seq },
      {
        jobId: makeJobId(organizationId, contestLifecycleJobNames.broadcastQuestion, contestId, nextQuestion.seq),
        delay: currentQuestion.time_limit_sec * 1000 + 3000
      }
    );
    return;
  }

  await contestLifecycleQueue.add(
    contestLifecycleJobNames.endContest,
    { organizationId, contestId },
    {
      jobId: makeJobId(organizationId, contestLifecycleJobNames.endContest, contestId),
      delay: currentQuestion.time_limit_sec * 1000 + 3000
    }
  );
}

async function startContest(contestId: string, organizationId: string) {
  await redis.ping();
  await ensureGameServerReady();

  const questions = await getContestQuestions(contestId, organizationId);

  if (questions.length === 0) {
    throw new Error("Cannot start contest without questions");
  }

  try {
    const contest = await withTransaction(async (client) => {
      const contestResult = await client.query<{
        status: string;
        current_q: number;
        q_started_at: string | null;
      }>(
        "SELECT status, current_q, q_started_at FROM contests WHERE id = $1 AND organization_id = $2 FOR UPDATE",
        [contestId, organizationId]
      );

      if (contestResult.rowCount !== 1) {
        throw new Error("Contest not found");
      }

      if (contestResult.rows[0].status === "live") {
        return contestResult.rows[0];
      }

      await client.query(
        `
          UPDATE contests
          SET status = 'live',
              lifecycle_status = 'STARTED',
              current_q = 1,
              q_started_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND organization_id = $2
        `,
        [contestId, organizationId]
      );

      return contestResult.rows[0];
    });

    const qStartedAtMs =
      contest.status === "live" && contest.q_started_at
        ? new Date(contest.q_started_at).getTime()
        : Date.now();
    await cacheContestQuestions(organizationId, contestId, questions);
    await cacheContestState(organizationId, contestId, 1, qStartedAtMs);

    const firstQuestion = questions[0];
    await publishContestEvent(organizationId, contestId, {
      type: "question",
      seq: firstQuestion.seq,
      body: firstQuestion.body,
      option_a: firstQuestion.option_a,
      option_b: firstQuestion.option_b,
      option_c: firstQuestion.option_c,
      option_d: firstQuestion.option_d,
      time_limit_sec: firstQuestion.time_limit_sec,
      server_time: qStartedAtMs
    });

    await scheduleNextJobs(organizationId, contestId, questions, 1);
    // Pending entry-fee debits become successful only after the contest really starts.
    await updateEntryFeeTransactionStatus(organizationId, contestId, "SUCCESS");

    return { success: true };
  } catch (error) {
    await cancelContestAndFlagPayments(contestId, organizationId);
    throw error;
  }
}

async function revealQuestion(contestId: string, organizationId: string, seq: number) {
  const question = await withTransaction(async (client) => {
    const contestResult = await client.query<{ current_q: number }>(
      "SELECT current_q FROM contests WHERE id = $1 AND organization_id = $2 FOR UPDATE",
      [contestId, organizationId]
    );

    if (contestResult.rowCount !== 1 || contestResult.rows[0].current_q < seq) {
      return null;
    }

    const questionResult = await client.query<{
      revealed_at: string | null;
      correct_option: string;
    }>(
      `
        SELECT q.revealed_at, q.correct_option
        FROM questions q
        JOIN contests c ON c.id = q.contest_id
        WHERE q.contest_id = $1
          AND q.seq = $2
          AND q.organization_id = $3
          AND c.organization_id = $3
        LIMIT 1
        FOR UPDATE
      `,
      [contestId, seq, organizationId]
    );

    if (questionResult.rowCount !== 1) {
      throw new Error("Question not found for reveal");
    }

    if (!questionResult.rows[0].revealed_at) {
      await client.query(
        `
          UPDATE questions
          SET revealed_at = NOW()
          WHERE contest_id = $1
            AND seq = $2
            AND revealed_at IS NULL
        `,
        [contestId, seq]
      );
    }

    return questionResult.rows[0];
  });

  if (!question) {
    return { skipped: true, reason: "already-revealed-or-not-live" };
  }

  let correctOption = question.correct_option;
  try {
    const cached = await redis.hget(contestQuestionKey(organizationId, contestId, seq), "correct_option");
    if (cached) {
      correctOption = cached;
    }
  } catch {
    // Fall back to Postgres value already loaded above.
  }

  await publishContestEvent(organizationId, contestId, {
    type: "reveal",
    seq,
    correct_option: correctOption
  });

  return { success: true };
}

async function broadcastQuestion(contestId: string, organizationId: string, seq: number) {
  const questions = await getContestQuestions(contestId, organizationId);
  const question = questions.find((item) => item.seq === seq);

  if (!question) {
    throw new Error("Question not found for broadcast");
  }

  const updated = await withTransaction(async (client) => {
    const contestResult = await client.query<{ current_q: number }>(
      "SELECT current_q FROM contests WHERE id = $1 AND organization_id = $2 FOR UPDATE",
      [contestId, organizationId]
    );

    if (contestResult.rowCount !== 1) {
      throw new Error("Contest not found");
    }

    if (contestResult.rows[0].current_q > seq) {
      return false;
    }

    if (contestResult.rows[0].current_q === seq) {
      const existingState = await client.query<{ q_started_at: string | null }>(
        "SELECT q_started_at FROM contests WHERE id = $1 AND organization_id = $2 LIMIT 1",
        [contestId, organizationId]
      );
      return {
        updated: true,
        qStartedAtMs: existingState.rows[0]?.q_started_at
          ? new Date(existingState.rows[0].q_started_at).getTime()
          : Date.now()
      };
    }

    await client.query(
      `
        UPDATE contests
        SET current_q = $2,
            q_started_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND organization_id = $3
      `,
      [contestId, seq, organizationId]
    );

    return {
      updated: true,
      qStartedAtMs: Date.now()
    };
  });

  if (!updated) {
    return { skipped: true, reason: "already-broadcast" };
  }

  await cacheContestState(organizationId, contestId, seq, updated.qStartedAtMs);

  await publishContestEvent(organizationId, contestId, {
    type: "question",
    seq: question.seq,
    body: question.body,
    option_a: question.option_a,
    option_b: question.option_b,
    option_c: question.option_c,
    option_d: question.option_d,
    time_limit_sec: question.time_limit_sec,
    server_time: updated.qStartedAtMs
  });

  await scheduleNextJobs(organizationId, contestId, questions, seq);

  return { success: true };
}

async function endContest(contestId: string, organizationId: string) {
  const contestResult = await withTransaction(async (client) => {
    const result = await client.query<{
      status: string;
      member_count: number;
      entry_fee: string;
      prize_rule: string;
    }>(
      `
        SELECT status, member_count, entry_fee, prize_rule
        FROM contests
        WHERE id = $1
          AND organization_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [contestId, organizationId]
    );

    if (result.rowCount !== 1) {
      throw new Error("Contest not found");
    }

    if (result.rows[0].status !== "ended") {
      await client.query(
        `
        UPDATE contests
        SET status = 'ended',
            lifecycle_status = 'COMPLETED',
            ended_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
            AND organization_id = $2
        `,
        [contestId, organizationId]
      );
    }

    return result.rows[0];
  });

  const contest = contestResult;
  const questions = await getContestQuestions(contestId, organizationId);
  const totalQuestions = questions.length;

  const leaderboardResult = await pool.query<{
    user_id: string;
    name: string;
    avatar_url: string | null;
    correct_count: string;
    joined_at: string;
    prize_amount: string;
  }>(
    `
      SELECT
        cm.user_id,
        u.name,
        u.avatar_url,
        COUNT(*) FILTER (WHERE a.is_correct = true)::text AS correct_count,
        cm.joined_at,
        cm.prize_amount
      FROM contest_members cm
      JOIN users u ON u.id = cm.user_id
        AND u.organization_id = $2
      JOIN contests c ON c.id = cm.contest_id
        AND c.organization_id = $2
      LEFT JOIN answers a
        ON a.contest_id = cm.contest_id
        AND a.user_id = cm.user_id
        AND a.organization_id = $2
      WHERE cm.contest_id = $1
        AND cm.organization_id = $2
      GROUP BY cm.user_id, u.name, u.avatar_url, cm.joined_at, cm.prize_amount
      ORDER BY
        COUNT(*) FILTER (WHERE a.is_correct = true) DESC,
        MAX(a.answered_at) ASC NULLS LAST,
        cm.joined_at ASC
    `,
    [contestId, organizationId]
  );

  const multi = redis.multi();
  multi.del(contestScoresKey(organizationId, contestId));
  for (const entry of leaderboardResult.rows) {
    multi.hset(contestScoresKey(organizationId, contestId), entry.user_id, entry.correct_count);
  }
  await multi.exec();

  const leaderboard = leaderboardResult.rows.map((row) => ({
    user_id: row.user_id,
    name: row.name,
    avatar_url: row.avatar_url,
    correct_count: Number(row.correct_count)
  }));

  let winners = leaderboardResult.rows.filter(
    (row) => Number(row.correct_count) === totalQuestions && totalQuestions > 0
  );

  if (contest.prize_rule === "top_scorer" || winners.length === 0) {
    const topScore = Math.max(...leaderboardResult.rows.map((row) => Number(row.correct_count)), 0);
    winners = leaderboardResult.rows.filter((row) => Number(row.correct_count) === topScore);
  }

  const prizePoolPaise =
    contest.member_count * moneyToPaise(contest.entry_fee);
  const winnerPrizeMap: Record<string, string> = {};

  await pool.query(
    "UPDATE contest_members SET is_winner = false, prize_amount = '0.00' WHERE contest_id = $1 AND organization_id = $2",
    [contestId, organizationId]
  );

  if (winners.length > 0 && prizePoolPaise > 0) {
    const basePrizePaise = Math.floor(prizePoolPaise / winners.length);
    let remainderPaise = prizePoolPaise - basePrizePaise * winners.length;

    for (const winner of winners) {
      const prizeAmountPaise = basePrizePaise + (remainderPaise > 0 ? remainderPaise : 0);
      remainderPaise = 0;
      const prizeAmount = paiseToMoney(prizeAmountPaise);
      winnerPrizeMap[winner.user_id] = prizeAmount;

      await pool.query(
        `
          UPDATE contest_members
          SET is_winner = true,
              prize_amount = $3
          WHERE contest_id = $1 AND user_id = $2 AND organization_id = $4
        `,
        [contestId, winner.user_id, prizeAmount, organizationId]
      );

      await payoutsQueue.add(
        payoutJobNames.prizeCredit,
        {
          organizationId,
          contestId,
          userId: winner.user_id
        },
        {
          jobId: makeJobId(organizationId, payoutJobNames.prizeCredit, contestId, winner.user_id)
        }
      );
    }
  }

  await publishContestEvent(organizationId, contestId, {
    type: "contest_ended",
    leaderboard: await pool
      .query<{
        user_id: string;
        name: string;
        avatar_url: string | null;
        correct_count: string;
        is_winner: boolean;
        prize_amount: string;
      }>(
        `
          SELECT
            cm.user_id,
            u.name,
            u.avatar_url,
            COUNT(*) FILTER (WHERE a.is_correct = true)::text AS correct_count,
            cm.is_winner,
            cm.prize_amount
          FROM contest_members cm
          JOIN users u ON u.id = cm.user_id
            AND u.organization_id = $2
          JOIN contests c ON c.id = cm.contest_id
            AND c.organization_id = $2
          LEFT JOIN answers a
            ON a.contest_id = cm.contest_id
            AND a.user_id = cm.user_id
            AND a.organization_id = $2
          WHERE cm.contest_id = $1
            AND cm.organization_id = $2
          GROUP BY cm.user_id, u.name, u.avatar_url, cm.is_winner, cm.prize_amount, cm.joined_at
          ORDER BY
            COUNT(*) FILTER (WHERE a.is_correct = true) DESC,
            MAX(a.answered_at) ASC NULLS LAST,
            cm.joined_at ASC
        `,
        [contestId, organizationId]
      )
      .then((result) => result.rows),
    winners: winnerPrizeMap
  });

  const cleanup = redis.multi();
  cleanup.del(contestStateKey(organizationId, contestId));
  cleanup.del(contestMembersKey(organizationId, contestId));
  cleanup.del(contestScoresKey(organizationId, contestId));
  for (const question of questions) {
    cleanup.del(contestQuestionKey(organizationId, contestId, question.seq));
    cleanup.del(contestAnsweredKey(organizationId, contestId, question.seq));
  }
  await cleanup.exec();

  return { success: true, winners: Object.keys(winnerPrizeMap).length };
}

async function refundContest(contestId: string, organizationId: string) {
  const contest = await withTransaction(async (client) => {
    const contestResult = await client.query<{ status: string }>(
      "SELECT status FROM contests WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE",
      [contestId, organizationId]
    );

    if (contestResult.rowCount !== 1) {
      throw new Error("Contest not found");
    }

    if (contestResult.rows[0].status !== "cancelled") {
      await client.query(
        `
          UPDATE contests
          SET status = 'cancelled',
              lifecycle_status = 'CANCELLED',
              ended_at = COALESCE(ended_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
            AND organization_id = $2
        `,
        [contestId, organizationId]
      );
    }

    return contestResult.rows[0];
  });

  const membersResult = await pool.query<{ user_id: string }>(
    `
      SELECT cm.user_id
      FROM contest_members cm
      JOIN contests c ON c.id = cm.contest_id
      WHERE cm.contest_id = $1
        AND cm.organization_id = $2
        AND c.organization_id = $2
    `,
    [contestId, organizationId]
  );

  for (const member of membersResult.rows) {
    await payoutsQueue.add(
      payoutJobNames.refund,
      {
        organizationId,
        contestId,
        userId: member.user_id
      },
      {
        jobId: makeJobId(organizationId, payoutJobNames.refund, contestId, member.user_id)
      }
    );
  }

  return { success: true };
}

async function prizeCredit(job: Job<PrizeCreditJobPayload>) {
  const { contestId, userId, organizationId } = job.data;

  const existingResult = await pool.query(
    `
      SELECT 1
      FROM wallet_transactions
      WHERE user_id = $1
        AND organization_id = $2
        AND reason = 'prize'
        AND reference_id = $3
      LIMIT 1
    `,
    [userId, organizationId, contestId]
  );

  if ((existingResult.rowCount ?? 0) > 0) {
    return { skipped: true, reason: "already-credited" };
  }

  const prizeResult = await pool.query<{ prize_amount: string }>(
    `
      SELECT prize_amount
      FROM contest_members cm
      JOIN contests c ON c.id = cm.contest_id
      WHERE cm.contest_id = $1
        AND cm.user_id = $2
        AND cm.organization_id = $3
        AND c.organization_id = $3
      LIMIT 1
    `,
    [contestId, userId, organizationId]
  );

  if (prizeResult.rowCount !== 1 || moneyToPaise(prizeResult.rows[0].prize_amount) <= 0) {
    return { skipped: true, reason: "no-prize" };
  }

  const contestResult = await pool.query<{ title: string }>(
    "SELECT title FROM contests WHERE id = $1 AND organization_id = $2 LIMIT 1",
    [contestId, organizationId]
  );

  return withTransaction(async (client) =>
    mutateWalletBalance(client, {
      userId,
      organizationId,
      amountPaise: moneyToPaise(prizeResult.rows[0].prize_amount),
      type: "credit",
      reason: "prize",
      referenceId: contestId,
      metadata: {
        source: "contest_prize",
        contestId,
        contestTitle: contestResult.rows[0]?.title ?? null
      }
    })
  );
}

async function refund(job: Job<RefundJobPayload>) {
  const { contestId, userId, organizationId } = job.data;

  if (!userId) {
    throw new Error("Refund job missing userId");
  }

  const existingResult = await pool.query(
    `
      SELECT 1
      FROM wallet_transactions
      WHERE user_id = $1
        AND organization_id = $2
        AND reason = 'refund'
        AND reference_id = $3
      LIMIT 1
    `,
    [userId, organizationId, contestId]
  );

  if ((existingResult.rowCount ?? 0) > 0) {
    return { skipped: true, reason: "already-refunded" };
  }

  const contestResult = await pool.query<{ entry_fee: string; title: string }>(
    "SELECT entry_fee, title FROM contests WHERE id = $1 AND organization_id = $2 LIMIT 1",
    [contestId, organizationId]
  );

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found for refund");
  }

  return withTransaction(async (client) => {
    const refundResult = await mutateWalletBalance(client, {
      userId,
      organizationId,
      amountPaise: moneyToPaise(contestResult.rows[0].entry_fee),
      type: "credit",
      reason: "refund",
      referenceId: contestId,
      metadata: {
        source: "contest_refund",
        contestId,
        contestTitle: contestResult.rows[0].title
      }
    });

    // Once the refund is written, the original entry-fee debit becomes fully refunded.
    await client.query(
      `
        UPDATE wallet_transactions
        SET tx_status = 'REFUNDED'
        WHERE user_id = $1
          AND organization_id = $2
          AND reason = 'entry_fee'
          AND reference_id = $3
      `,
      [userId, organizationId, contestId]
    );

    return refundResult;
  });
}

async function recoverJobsOnStartup() {
  const openContests = await pool.query<{ id: string; organization_id: string; starts_at: string }>(
    `
      SELECT id, organization_id, starts_at
      FROM contests
      WHERE status = 'open'
        AND starts_at BETWEEN NOW() AND NOW() + INTERVAL '10 minutes'
    `
  );

  for (const contest of openContests.rows) {
    const jobId = makeJobId(contest.organization_id, contestLifecycleJobNames.startContest, contest.id);
    const existing = await contestLifecycleQueue.getJob(jobId);
    if (!existing) {
      await contestLifecycleQueue.add(
        contestLifecycleJobNames.startContest,
        { organizationId: contest.organization_id, contestId: contest.id },
        {
          jobId,
          delay: Math.max(0, new Date(contest.starts_at).getTime() - Date.now()),
          attempts: 3
        }
      );
    }
  }

  const liveContests = await pool.query<{ id: string; organization_id: string; current_q: number; q_started_at: string | null }>(
    `
      SELECT id, organization_id, current_q, q_started_at
      FROM contests
      WHERE status = 'live'
    `
  );

  for (const contest of liveContests.rows) {
    const questions = await getContestQuestions(contest.id, contest.organization_id);
    await cacheContestQuestions(contest.organization_id, contest.id, questions);

    if (contest.current_q > 0 && contest.q_started_at) {
      await cacheContestState(
        contest.organization_id,
        contest.id,
        contest.current_q,
        new Date(contest.q_started_at).getTime()
      );
      const currentQuestion = questions.find((question) => question.seq === contest.current_q);
      if (!currentQuestion) {
        continue;
      }

      const elapsedMs = Date.now() - new Date(contest.q_started_at).getTime();
      const revealDelay = Math.max(0, currentQuestion.time_limit_sec * 1000 - elapsedMs);
      const revealJobId = makeJobId(
        contest.organization_id,
        contestLifecycleJobNames.revealQuestion,
        contest.id,
        contest.current_q
      );
      const existingReveal = await contestLifecycleQueue.getJob(revealJobId);
      if (!existingReveal && !currentQuestion.revealed_at) {
        await contestLifecycleQueue.add(
          contestLifecycleJobNames.revealQuestion,
          { organizationId: contest.organization_id, contestId: contest.id, seq: contest.current_q },
          { jobId: revealJobId, delay: revealDelay }
        );
      }

      const nextQuestion = questions.find((question) => question.seq === contest.current_q + 1);
      if (nextQuestion) {
        const nextJobId = makeJobId(
          contest.organization_id,
          contestLifecycleJobNames.broadcastQuestion,
          contest.id,
          nextQuestion.seq
        );
        const existingBroadcast = await contestLifecycleQueue.getJob(nextJobId);
        if (!existingBroadcast) {
          await contestLifecycleQueue.add(
            contestLifecycleJobNames.broadcastQuestion,
            { organizationId: contest.organization_id, contestId: contest.id, seq: nextQuestion.seq },
            { jobId: nextJobId, delay: revealDelay + 3000 }
          );
        }
      } else {
        const endJobId = makeJobId(contest.organization_id, contestLifecycleJobNames.endContest, contest.id);
        const existingEnd = await contestLifecycleQueue.getJob(endJobId);
        if (!existingEnd) {
          await contestLifecycleQueue.add(
            contestLifecycleJobNames.endContest,
            { organizationId: contest.organization_id, contestId: contest.id },
            { jobId: endJobId, delay: revealDelay + 3000 }
          );
        }
      }
    }
  }

  await recoverStaleRefunds();
}

const contestWorker = new Worker<ContestLifecycleJobPayload>(
  "contest-lifecycle",
  async (job) => {
    return withTenantJobGuard(job.data.organizationId, async () => {
      switch (job.name) {
        case contestLifecycleJobNames.startContest:
          return startContest(job.data.contestId, job.data.organizationId);
        case contestLifecycleJobNames.revealQuestion:
          return revealQuestion(job.data.contestId, job.data.organizationId, job.data.seq ?? 0);
        case contestLifecycleJobNames.broadcastQuestion:
          return broadcastQuestion(job.data.contestId, job.data.organizationId, job.data.seq ?? 0);
        case contestLifecycleJobNames.endContest:
          return endContest(job.data.contestId, job.data.organizationId);
        case contestLifecycleJobNames.refundContest:
          return refundContest(job.data.contestId, job.data.organizationId);
        default:
          throw new Error(`Unsupported contest lifecycle job ${job.name}`);
      }
    });
  },
  {
    connection,
    concurrency: 10
  }
);

const payoutWorker = new Worker<PrizeCreditJobPayload | RefundJobPayload>(
  "payouts",
  async (job) => {
    return withTenantJobGuard(job.data.organizationId, async () => {
      switch (job.name) {
        case payoutJobNames.prizeCredit:
          return prizeCredit(job as Job<PrizeCreditJobPayload>);
        case payoutJobNames.refund:
          return refund(job as Job<RefundJobPayload>);
        default:
          throw new Error(`Unsupported payout job ${job.name}`);
      }
    });
  },
  {
    connection,
    concurrency: 10
  }
);

for (const worker of [contestWorker, payoutWorker]) {
  worker.on("failed", async (job, error) => {
    if (!job) {
      return;
    }

    const data = job.data as ContestLifecycleJobPayload | RefundJobPayload;
    const contestId = String(data.contestId ?? "");
    const organizationId = String(data.organizationId ?? "");
    const finalAttemptReached = job.attemptsMade >= (job.opts.attempts ?? 1);

    if (!finalAttemptReached) {
      return;
    }

    alertFailure(job.name, contestId, error);

    if (
      worker === contestWorker &&
      job.name === contestLifecycleJobNames.startContest &&
      await shouldTriggerRefundFallback(organizationId, contestId)
    ) {
      await contestLifecycleQueue.add(
        contestLifecycleJobNames.refundContest,
        { organizationId, contestId },
        {
          jobId: makeJobId(organizationId, contestLifecycleJobNames.refundContest, contestId)
        }
      );
    }
  });
}

try {
  await recoverJobsOnStartup();
  console.log("[worker-server] Started");
} catch (error) {
  console.error("[worker-server] Failed during startup recovery", error);
  process.exit(1);
}

setInterval(() => {
  recoverStaleRefunds().catch((error) => {
    console.error("[worker-server] Refund recovery sweep failed", error);
  });
}, recoverySweepIntervalMs);

const healthServer = createServer(async (req, res) => {
  if (req.url !== "/health") {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  let db = false;
  let redisOk = false;

  try {
    await pool.query("SELECT 1");
    db = true;
  } catch {
    db = false;
  }

  try {
    redisOk = (await redis.ping()) === "PONG";
  } catch {
    redisOk = false;
  }

  const ok = db && redisOk;
  res.statusCode = ok ? 200 : 503;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    ok,
    service: "worker-server",
    checks: {
      db,
      redis: redisOk
    }
  }));
});

healthServer.listen(workerPort, "0.0.0.0", () => {
  console.log(`[worker-server] Health server listening on ${workerPort}`);
});
