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

const redis = createRedisClient("worker-server");
await redis.connect();

const makeJobId = (...parts: Array<string | number>) => parts.join("__");

function alertFailure(jobName: string, contestId: string, error: unknown) {
  console.error("ALERT: job failure", {
    jobName,
    contestId,
    error: error instanceof Error ? error.message : String(error)
  });
}

async function publishContestEvent(contestId: string, payload: Record<string, unknown>) {
  await redis.publish(
    contestChannel(contestId),
    JSON.stringify({
      ...payload,
      contest_id: contestId
    })
  );
}

async function getContestQuestions(contestId: string) {
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
      SELECT id, seq, body, option_a, option_b, option_c, option_d, correct_option, time_limit_sec, revealed_at
      FROM questions
      WHERE contest_id = $1
      ORDER BY seq ASC
    `,
    [contestId]
  );

  return result.rows;
}

async function cacheContestState(contestId: string, currentQ: number, qStartedAtMs: number) {
  await redis.hset(contestStateKey(contestId), {
    current_q: String(currentQ),
    q_started_at: String(qStartedAtMs)
  });
}

async function cacheContestQuestions(contestId: string, questions: Awaited<ReturnType<typeof getContestQuestions>>) {
  const memberResult = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM contest_members WHERE contest_id = $1 ORDER BY joined_at ASC",
    [contestId]
  );
  const totalDurationMs =
    questions.reduce((total, question) => total + question.time_limit_sec * 1000 + 3000, 0) + 3600_000;
  const ttlSeconds = Math.ceil(totalDurationMs / 1000);
  const multi = redis.multi();

  multi.del(contestMembersKey(contestId));
  if (memberResult.rows.length > 0) {
    multi.sadd(
      contestMembersKey(contestId),
      ...memberResult.rows.map((member) => member.user_id)
    );
  }

  for (const question of questions) {
    multi.hset(contestQuestionKey(contestId, question.seq), {
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
    multi.expire(contestQuestionKey(contestId, question.seq), ttlSeconds);
  }

  await multi.exec();
}

async function scheduleNextJobs(contestId: string, questions: Awaited<ReturnType<typeof getContestQuestions>>, seq: number) {
  const currentQuestion = questions.find((question) => question.seq === seq);

  if (!currentQuestion) {
    throw new Error(`Question ${seq} not found for contest ${contestId}`);
  }

  await contestLifecycleQueue.add(
    contestLifecycleJobNames.revealQuestion,
    { contestId, seq },
    {
      jobId: makeJobId(contestLifecycleJobNames.revealQuestion, contestId, seq),
      delay: currentQuestion.time_limit_sec * 1000
    }
  );

  const nextQuestion = questions.find((question) => question.seq === seq + 1);

  if (nextQuestion) {
    await contestLifecycleQueue.add(
      contestLifecycleJobNames.broadcastQuestion,
      { contestId, seq: nextQuestion.seq },
      {
        jobId: makeJobId(contestLifecycleJobNames.broadcastQuestion, contestId, nextQuestion.seq),
        delay: currentQuestion.time_limit_sec * 1000 + 3000
      }
    );
    return;
  }

  await contestLifecycleQueue.add(
    contestLifecycleJobNames.endContest,
    { contestId },
    {
      jobId: makeJobId(contestLifecycleJobNames.endContest, contestId),
      delay: currentQuestion.time_limit_sec * 1000 + 3000
    }
  );
}

async function startContest(contestId: string) {
  const contestResult = await pool.query<{
    status: string;
  }>("SELECT status FROM contests WHERE id = $1 LIMIT 1", [contestId]);

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found");
  }

  if (contestResult.rows[0].status === "live") {
    return { skipped: true, reason: "already-live" };
  }

  const questions = await getContestQuestions(contestId);

  if (questions.length === 0) {
    throw new Error("Cannot start contest without questions");
  }

  await pool.query(
    `
      UPDATE contests
      SET status = 'live',
          current_q = 1,
          q_started_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [contestId]
  );

  const qStartedAtMs = Date.now();
  await cacheContestQuestions(contestId, questions);
  await cacheContestState(contestId, 1, qStartedAtMs);

  const firstQuestion = questions[0];
  await publishContestEvent(contestId, {
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

  await scheduleNextJobs(contestId, questions, 1);

  return { success: true };
}

async function revealQuestion(contestId: string, seq: number) {
  const contestResult = await pool.query<{ current_q: number }>(
    "SELECT current_q FROM contests WHERE id = $1 LIMIT 1",
    [contestId]
  );

  if (contestResult.rowCount !== 1 || contestResult.rows[0].current_q < seq) {
    return { skipped: true, reason: "question-not-live-yet" };
  }

  const questionResult = await pool.query<{
    revealed_at: string | null;
    correct_option: string;
  }>(
    `
      SELECT revealed_at, correct_option
      FROM questions
      WHERE contest_id = $1 AND seq = $2
      LIMIT 1
    `,
    [contestId, seq]
  );

  if (questionResult.rowCount !== 1) {
    throw new Error("Question not found for reveal");
  }

  const question = questionResult.rows[0];
  if (question.revealed_at) {
    return { skipped: true, reason: "already-revealed" };
  }

  let correctOption = question.correct_option;
  try {
    const cached = await redis.hget(contestQuestionKey(contestId, seq), "correct_option");
    if (cached) {
      correctOption = cached;
    }
  } catch {
    // Fall back to Postgres value already loaded above.
  }

  await publishContestEvent(contestId, {
    type: "reveal",
    seq,
    correct_option: correctOption
  });

  await pool.query(
    "UPDATE questions SET revealed_at = NOW() WHERE contest_id = $1 AND seq = $2 AND revealed_at IS NULL",
    [contestId, seq]
  );

  return { success: true };
}

async function broadcastQuestion(contestId: string, seq: number) {
  const contestResult = await pool.query<{ current_q: number }>(
    "SELECT current_q FROM contests WHERE id = $1 LIMIT 1",
    [contestId]
  );

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found");
  }

  if (contestResult.rows[0].current_q >= seq) {
    return { skipped: true, reason: "already-broadcast" };
  }

  const questions = await getContestQuestions(contestId);
  const question = questions.find((item) => item.seq === seq);

  if (!question) {
    throw new Error("Question not found for broadcast");
  }

  await pool.query(
    `
      UPDATE contests
      SET current_q = $2,
          q_started_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [contestId, seq]
  );

  const qStartedAtMs = Date.now();
  await cacheContestState(contestId, seq, qStartedAtMs);

  await publishContestEvent(contestId, {
    type: "question",
    seq: question.seq,
    body: question.body,
    option_a: question.option_a,
    option_b: question.option_b,
    option_c: question.option_c,
    option_d: question.option_d,
    time_limit_sec: question.time_limit_sec,
    server_time: qStartedAtMs
  });

  await scheduleNextJobs(contestId, questions, seq);

  return { success: true };
}

async function endContest(contestId: string) {
  const contestResult = await pool.query<{
    status: string;
    member_count: number;
    entry_fee: string;
    prize_rule: string;
  }>(
    `
      SELECT status, member_count, entry_fee, prize_rule
      FROM contests
      WHERE id = $1
      LIMIT 1
    `,
    [contestId]
  );

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found");
  }

  if (contestResult.rows[0].status === "ended") {
    return { skipped: true, reason: "already-ended" };
  }

  await pool.query(
    `
      UPDATE contests
      SET status = 'ended',
          ended_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [contestId]
  );

  const questions = await getContestQuestions(contestId);
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
      LEFT JOIN answers a
        ON a.contest_id = cm.contest_id
        AND a.user_id = cm.user_id
      WHERE cm.contest_id = $1
      GROUP BY cm.user_id, u.name, u.avatar_url, cm.joined_at, cm.prize_amount
      ORDER BY
        COUNT(*) FILTER (WHERE a.is_correct = true) DESC,
        MAX(a.answered_at) ASC NULLS LAST,
        cm.joined_at ASC
    `,
    [contestId]
  );

  const multi = redis.multi();
  multi.del(contestScoresKey(contestId));
  for (const entry of leaderboardResult.rows) {
    multi.hset(contestScoresKey(contestId), entry.user_id, entry.correct_count);
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

  if (contestResult.rows[0].prize_rule === "top_scorer" || winners.length === 0) {
    const topScore = Math.max(...leaderboardResult.rows.map((row) => Number(row.correct_count)), 0);
    winners = leaderboardResult.rows.filter((row) => Number(row.correct_count) === topScore);
  }

  const prizePoolPaise =
    contestResult.rows[0].member_count * moneyToPaise(contestResult.rows[0].entry_fee);
  const winnerPrizeMap: Record<string, string> = {};

  await pool.query(
    "UPDATE contest_members SET is_winner = false, prize_amount = '0.00' WHERE contest_id = $1",
    [contestId]
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
          WHERE contest_id = $1 AND user_id = $2
        `,
        [contestId, winner.user_id, prizeAmount]
      );

      await payoutsQueue.add(
        payoutJobNames.prizeCredit,
        {
          contestId,
          userId: winner.user_id
        },
        {
          jobId: makeJobId(payoutJobNames.prizeCredit, contestId, winner.user_id)
        }
      );
    }
  }

  await publishContestEvent(contestId, {
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
          LEFT JOIN answers a
            ON a.contest_id = cm.contest_id
            AND a.user_id = cm.user_id
          WHERE cm.contest_id = $1
          GROUP BY cm.user_id, u.name, u.avatar_url, cm.is_winner, cm.prize_amount, cm.joined_at
          ORDER BY
            COUNT(*) FILTER (WHERE a.is_correct = true) DESC,
            MAX(a.answered_at) ASC NULLS LAST,
            cm.joined_at ASC
        `,
        [contestId]
      )
      .then((result) => result.rows),
    winners: winnerPrizeMap
  });

  const cleanup = redis.multi();
  cleanup.del(contestStateKey(contestId));
  cleanup.del(contestMembersKey(contestId));
  cleanup.del(contestScoresKey(contestId));
  for (const question of questions) {
    cleanup.del(contestQuestionKey(contestId, question.seq));
    cleanup.del(contestAnsweredKey(contestId, question.seq));
  }
  await cleanup.exec();

  return { success: true, winners: Object.keys(winnerPrizeMap).length };
}

async function refundContest(contestId: string) {
  const contestResult = await pool.query<{ status: string }>(
    "SELECT status FROM contests WHERE id = $1 LIMIT 1",
    [contestId]
  );

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found");
  }

  if (contestResult.rows[0].status === "cancelled") {
    return { skipped: true, reason: "already-cancelled" };
  }

  await pool.query(
    "UPDATE contests SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
    [contestId]
  );

  const membersResult = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM contest_members WHERE contest_id = $1",
    [contestId]
  );

  for (const member of membersResult.rows) {
    await payoutsQueue.add(
      payoutJobNames.refund,
      {
        contestId,
        userId: member.user_id
      },
      {
        jobId: makeJobId(payoutJobNames.refund, contestId, member.user_id)
      }
    );
  }

  return { success: true };
}

async function prizeCredit(job: Job<PrizeCreditJobPayload>) {
  const { contestId, userId } = job.data;
  const existingResult = await pool.query(
    `
      SELECT 1
      FROM wallet_transactions
      WHERE user_id = $1
        AND reason = 'prize'
        AND reference_id = $2
      LIMIT 1
    `,
    [userId, contestId]
  );

  if ((existingResult.rowCount ?? 0) > 0) {
    return { skipped: true, reason: "already-credited" };
  }

  const prizeResult = await pool.query<{ prize_amount: string }>(
    `
      SELECT prize_amount
      FROM contest_members
      WHERE contest_id = $1 AND user_id = $2
      LIMIT 1
    `,
    [contestId, userId]
  );

  if (prizeResult.rowCount !== 1 || moneyToPaise(prizeResult.rows[0].prize_amount) <= 0) {
    return { skipped: true, reason: "no-prize" };
  }

  const contestResult = await pool.query<{ title: string }>(
    "SELECT title FROM contests WHERE id = $1 LIMIT 1",
    [contestId]
  );

  return withTransaction(async (client) =>
    mutateWalletBalance(client, {
      userId,
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
  const { contestId, userId } = job.data;

  if (!userId) {
    throw new Error("Refund job missing userId");
  }

  const existingResult = await pool.query(
    `
      SELECT 1
      FROM wallet_transactions
      WHERE user_id = $1
        AND reason = 'refund'
        AND reference_id = $2
      LIMIT 1
    `,
    [userId, contestId]
  );

  if ((existingResult.rowCount ?? 0) > 0) {
    return { skipped: true, reason: "already-refunded" };
  }

  const contestResult = await pool.query<{ entry_fee: string; title: string }>(
    "SELECT entry_fee, title FROM contests WHERE id = $1 LIMIT 1",
    [contestId]
  );

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found for refund");
  }

  return withTransaction(async (client) =>
    mutateWalletBalance(client, {
      userId,
      amountPaise: moneyToPaise(contestResult.rows[0].entry_fee),
      type: "credit",
      reason: "refund",
      referenceId: contestId,
      metadata: {
        source: "contest_refund",
        contestId,
        contestTitle: contestResult.rows[0].title
      }
    })
  );
}

async function recoverJobsOnStartup() {
  const openContests = await pool.query<{ id: string; starts_at: string }>(
    `
      SELECT id, starts_at
      FROM contests
      WHERE status = 'open'
        AND starts_at BETWEEN NOW() AND NOW() + INTERVAL '10 minutes'
    `
  );

  for (const contest of openContests.rows) {
    const jobId = makeJobId(contestLifecycleJobNames.startContest, contest.id);
    const existing = await contestLifecycleQueue.getJob(jobId);
    if (!existing) {
      await contestLifecycleQueue.add(
        contestLifecycleJobNames.startContest,
        { contestId: contest.id },
        {
          jobId,
          delay: Math.max(0, new Date(contest.starts_at).getTime() - Date.now())
        }
      );
    }
  }

  const liveContests = await pool.query<{ id: string; current_q: number; q_started_at: string | null }>(
    `
      SELECT id, current_q, q_started_at
      FROM contests
      WHERE status = 'live'
    `
  );

  for (const contest of liveContests.rows) {
    const questions = await getContestQuestions(contest.id);
    await cacheContestQuestions(contest.id, questions);

    if (contest.current_q > 0 && contest.q_started_at) {
      await cacheContestState(
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
        contestLifecycleJobNames.revealQuestion,
        contest.id,
        contest.current_q
      );
      const existingReveal = await contestLifecycleQueue.getJob(revealJobId);
      if (!existingReveal && !currentQuestion.revealed_at) {
        await contestLifecycleQueue.add(
          contestLifecycleJobNames.revealQuestion,
          { contestId: contest.id, seq: contest.current_q },
          { jobId: revealJobId, delay: revealDelay }
        );
      }

      const nextQuestion = questions.find((question) => question.seq === contest.current_q + 1);
      if (nextQuestion) {
        const nextJobId = makeJobId(
          contestLifecycleJobNames.broadcastQuestion,
          contest.id,
          nextQuestion.seq
        );
        const existingBroadcast = await contestLifecycleQueue.getJob(nextJobId);
        if (!existingBroadcast) {
          await contestLifecycleQueue.add(
            contestLifecycleJobNames.broadcastQuestion,
            { contestId: contest.id, seq: nextQuestion.seq },
            { jobId: nextJobId, delay: revealDelay + 3000 }
          );
        }
      } else {
        const endJobId = makeJobId(contestLifecycleJobNames.endContest, contest.id);
        const existingEnd = await contestLifecycleQueue.getJob(endJobId);
        if (!existingEnd) {
          await contestLifecycleQueue.add(
            contestLifecycleJobNames.endContest,
            { contestId: contest.id },
            { jobId: endJobId, delay: revealDelay + 3000 }
          );
        }
      }
    }
  }
}

const contestWorker = new Worker<ContestLifecycleJobPayload>(
  "contest-lifecycle",
  async (job) => {
    switch (job.name) {
      case contestLifecycleJobNames.startContest:
        return startContest(job.data.contestId);
      case contestLifecycleJobNames.revealQuestion:
        return revealQuestion(job.data.contestId, job.data.seq ?? 0);
      case contestLifecycleJobNames.broadcastQuestion:
        return broadcastQuestion(job.data.contestId, job.data.seq ?? 0);
      case contestLifecycleJobNames.endContest:
        return endContest(job.data.contestId);
      case contestLifecycleJobNames.refundContest:
        return refundContest(job.data.contestId);
      default:
        throw new Error(`Unsupported contest lifecycle job ${job.name}`);
    }
  },
  {
    connection,
    concurrency: 10
  }
);

const payoutWorker = new Worker<PrizeCreditJobPayload | RefundJobPayload>(
  "payouts",
  async (job) => {
    switch (job.name) {
      case payoutJobNames.prizeCredit:
        return prizeCredit(job as Job<PrizeCreditJobPayload>);
      case payoutJobNames.refund:
        return refund(job as Job<RefundJobPayload>);
      default:
        throw new Error(`Unsupported payout job ${job.name}`);
    }
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

    const contestId = String((job.data as ContestLifecycleJobPayload | RefundJobPayload).contestId ?? "");
    const finalAttemptReached = job.attemptsMade >= (job.opts.attempts ?? 1);

    if (!finalAttemptReached) {
      return;
    }

    alertFailure(job.name, contestId, error);

    if (
      worker === contestWorker &&
      (job.name === contestLifecycleJobNames.startContest ||
        job.name === contestLifecycleJobNames.broadcastQuestion)
    ) {
      await contestLifecycleQueue.add(
        contestLifecycleJobNames.refundContest,
        { contestId },
        {
          jobId: makeJobId(contestLifecycleJobNames.refundContest, contestId)
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
