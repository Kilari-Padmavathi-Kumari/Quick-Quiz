import { mutateWalletBalance, pool, withTransaction } from "@quiz-app/db";
import {
  CONTEST_LIFECYCLE_QUEUE,
  contestLifecycleJobNames,
  contestLifecycleQueue,
  getQueueByName,
  PAYOUTS_QUEUE
} from "@quiz-app/queues";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticateAccessToken, requireAdmin } from "../lib/auth.js";
import { rebuildContestCache } from "../lib/contest-cache.js";
import { ensureContestJobs } from "../lib/contest-jobs.js";
import { requireOrganizationId } from "../lib/tenant.js";
import {
  closeWalletRequestEventSubscriber,
  registerWalletRequestStream
} from "../lib/wallet-request-events.js";

const makeJobId = (...parts: Array<string | number>) => parts.join("__");

const contestSchema = z.object({
  title: z.string().min(3).max(120),
  starts_at: z.iso.datetime(),
  entry_fee: z.number().positive(),
  max_members: z.number().int().positive().max(100),
  prize_rule: z.enum(["all_correct", "top_scorer"]).default("all_correct")
});

const questionSchema = z.object({
  seq: z.number().int().positive(),
  body: z.string().min(5),
  option_a: z.string().min(1),
  option_b: z.string().min(1),
  option_c: z.string().min(1),
  option_d: z.string().min(1),
  correct_option: z.enum(["a", "b", "c", "d"]),
  time_limit_sec: z.number().int().positive().max(120)
});

const amountSchema = z.object({
  amount: z.number().positive().max(100000)
});

function getContestPublishError(contest: { status: string; starts_at: string }, questionCount: number) {
  if (contest.status !== "draft") {
    return "Contest must be in draft status before publishing";
  }

  if (questionCount < 1) {
    return "Contest must have at least one question before publishing";
  }

  if (new Date(contest.starts_at).getTime() <= Date.now()) {
    return "Contest start time must be in the future before publishing";
  }

  return null;
}

export async function adminRoutes(app: FastifyInstance) {
  app.get("/admin/wallet-requests/stream", async (request, reply) => {
    const accessToken = String(((request.query as { access_token?: string })?.access_token) ?? "");
    const organizationId = requireOrganizationId(request);
    const authResult = await authenticateAccessToken(accessToken, organizationId);

    if (!authResult.user) {
      return reply.code(401).send({ message: authResult.error ?? "Invalid access token" });
    }

    if (!authResult.user.is_admin) {
      return reply.code(403).send({ message: "Admin access required" });
    }

    const currentUser = authResult.user;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
    }, 25000);

    const stream = await registerWalletRequestStream(currentUser.organization_id, (event) => {
      reply.raw.write(`event: wallet_request_created\ndata: ${JSON.stringify(event)}\n\n`);
    });

    reply.raw.write(`event: ready\ndata: {"ok":true}\n\n`);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      stream.close();
      reply.raw.end();
    });
  });

  app.get("/admin/users", { preHandler: requireAdmin }, async (request) => {
    const result = await pool.query<{
      id: string;
      email: string;
      name: string;
      avatar_url: string | null;
      wallet_balance: string;
      is_admin: boolean;
      is_banned: boolean;
      created_at: string;
    }>(
      `
        SELECT id, email, name, avatar_url, wallet_balance, is_admin, is_banned, created_at
        FROM users
        WHERE organization_id = $1
        ORDER BY created_at ASC
      `
      ,
      [request.user.organization_id]
    );

    return { users: result.rows };
  });

  app.get("/admin/contests", { preHandler: requireAdmin }, async (request) => {
    const result = await pool.query<{
      id: string;
      title: string;
      status: string;
      member_count: number;
      starts_at: string;
      prize_pool: string;
    }>(
      `
        SELECT
          id,
          title,
          status,
          member_count,
          starts_at,
          (member_count * entry_fee)::numeric(12, 2) AS prize_pool
        FROM contests
        WHERE organization_id = $1
        ORDER BY starts_at DESC
      `
      ,
      [request.user.organization_id]
    );

    return { contests: result.rows };
  });

  app.get("/admin/wallet-requests", { preHandler: requireAdmin }, async (request) => {
    const result = await pool.query<{
      id: string;
      user_id: string;
      amount: string;
      status: "pending" | "approved" | "rejected";
      requested_at: string;
      reviewed_at: string | null;
      user_name: string;
      user_email: string;
    }>(
      `
        SELECT
          wr.id,
          wr.user_id,
          wr.amount,
          wr.status,
          wr.requested_at,
          wr.reviewed_at,
          u.name AS user_name,
          u.email AS user_email
        FROM wallet_topup_requests wr
        JOIN users u ON u.id = wr.user_id
        WHERE wr.organization_id = $1
          AND u.organization_id = $1
        ORDER BY
          CASE WHEN wr.status = 'pending' THEN 0 ELSE 1 END,
          wr.requested_at DESC
      `,
      [request.user.organization_id]
    );

    return { requests: result.rows };
  });

  app.post("/admin/contests", { preHandler: requireAdmin }, async (request, reply) => {
    const body = contestSchema.parse(request.body);

    if (new Date(body.starts_at).getTime() <= Date.now()) {
      return reply.code(422).send({
        message: "Contest start time must be in the future"
      });
    }

    const result = await pool.query(
      `
        INSERT INTO contests (title, starts_at, entry_fee, max_members, prize_rule, created_by, organization_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, title, status, entry_fee, max_members, member_count, starts_at, prize_rule
      `,
      [
        body.title.trim(),
        body.starts_at,
        body.entry_fee.toFixed(2),
        body.max_members,
        body.prize_rule,
        request.user.id,
        request.user.organization_id
      ]
    );

    return { contest: result.rows[0] };
  });

  app.post("/admin/contests/:id/questions", { preHandler: requireAdmin }, async (request, reply) => {
    const contestId = String((request.params as { id: string }).id);
    const body = questionSchema.parse(request.body);

    try {
      const result = await pool.query(
        `
          INSERT INTO questions (
            contest_id,
            organization_id,
            seq,
            body,
            option_a,
            option_b,
            option_c,
            option_d,
            correct_option,
            time_limit_sec
          )
          SELECT
            c.id,
            c.organization_id,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9
          FROM contests c
          WHERE c.id = $1
            AND c.organization_id = $10
          RETURNING id, contest_id, seq
        `,
        [
          contestId,
          body.seq,
          body.body.trim(),
          body.option_a.trim(),
          body.option_b.trim(),
          body.option_c.trim(),
          body.option_d.trim(),
          body.correct_option,
          body.time_limit_sec,
          request.user.organization_id
        ]
      );

      if (result.rowCount !== 1) {
        return reply.code(404).send({ message: "Contest not found" });
      }

      return { question: result.rows[0] };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") {
        return reply.code(409).send({ message: "Question sequence already exists" });
      }

      throw error;
    }
  });

  app.post("/admin/contests/:id/publish", { preHandler: requireAdmin }, async (request, reply) => {
    const contestId = String((request.params as { id: string }).id);

    const contestResult = await pool.query<{
      status: string;
      starts_at: string;
    }>(
      "SELECT status, starts_at FROM contests WHERE id = $1 AND organization_id = $2 LIMIT 1",
      [contestId, request.user.organization_id]
    );

    if (contestResult.rowCount !== 1) {
      return reply.code(404).send({ message: "Contest not found" });
    }

    const questionCountResult = await pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM questions q
        JOIN contests c ON c.id = q.contest_id
        WHERE q.contest_id = $1
          AND q.organization_id = $2
          AND c.organization_id = $2
      `,
      [contestId, request.user.organization_id]
    );

    const contest = contestResult.rows[0];
    const questionCount = Number(questionCountResult.rows[0].count);

    const publishError = getContestPublishError(contest, questionCount);

    if (publishError) {
      return reply.code(422).send({
        message: publishError
      });
    }

    await pool.query(
      `
        UPDATE contests
        SET status = 'open',
            lifecycle_status = 'PENDING',
            updated_at = NOW()
        WHERE id = $1
          AND organization_id = $2
      `,
      [contestId, request.user.organization_id]
    );

    const delay = Math.max(0, new Date(contest.starts_at).getTime() - Date.now());
    await contestLifecycleQueue.add(
      contestLifecycleJobNames.startContest,
      { organizationId: request.user.organization_id, contestId },
      {
        jobId: makeJobId(request.user.organization_id, contestLifecycleJobNames.startContest, contestId),
        delay,
        // Contest start is retried a few times before we cancel and refund.
        attempts: 3
      }
    );

    return { success: true };
  });

  app.post("/admin/wallet-requests/:id/approve", { preHandler: requireAdmin }, async (request, reply) => {
    const requestId = String((request.params as { id: string }).id);

    const result = await withTransaction(async (client) => {
      const requestResult = await client.query<{
        id: string;
        user_id: string;
        amount: string;
        status: "pending" | "approved" | "rejected";
      }>(
        `
          SELECT id, user_id, amount, status
          FROM wallet_topup_requests
          WHERE id = $1
            AND organization_id = $2
          FOR UPDATE
        `,
        [requestId, request.user.organization_id]
      );

      if (requestResult.rowCount !== 1) {
        return null;
      }

      const walletRequest = requestResult.rows[0];

      if (walletRequest.status !== "pending") {
        return { status: "already-reviewed" as const };
      }

      const walletMutation = await mutateWalletBalance(client, {
        organizationId: request.user.organization_id,
        userId: walletRequest.user_id,
        amountPaise: Math.round(Number(walletRequest.amount) * 100),
        type: "credit",
        reason: "manual_topup",
        metadata: {
          approvedByAdminId: request.user.id,
          approvedWalletRequestId: requestId,
          source: "wallet_request_approval",
          organizationId: request.user.organization_id
        }
      });

      await client.query(
        `
          UPDATE wallet_topup_requests
          SET status = 'approved',
              reviewed_at = NOW(),
              reviewed_by = $2,
              updated_at = NOW()
          WHERE id = $1
            AND organization_id = $3
        `,
        [requestId, request.user.id, request.user.organization_id]
      );

      return {
        status: "approved" as const,
        walletBalance: (walletMutation.balanceAfterPaise / 100).toFixed(2)
      };
    });

    if (!result) {
      return reply.code(404).send({ message: "Wallet request not found" });
    }

    if (result.status === "already-reviewed") {
      return reply.code(409).send({ message: "Wallet request was already reviewed" });
    }

    return {
      success: true,
      wallet_balance: result.walletBalance
    };
  });

  app.post("/admin/wallet-requests/:id/reject", { preHandler: requireAdmin }, async (request, reply) => {
    const requestId = String((request.params as { id: string }).id);

    const result = await withTransaction(async (client) => {
      const requestResult = await client.query<{
        id: string;
        status: "pending" | "approved" | "rejected";
      }>(
        `
          SELECT id, status
          FROM wallet_topup_requests
          WHERE id = $1
            AND organization_id = $2
          FOR UPDATE
        `,
        [requestId, request.user.organization_id]
      );

      if (requestResult.rowCount !== 1) {
        return null;
      }

      const walletRequest = requestResult.rows[0];

      if (walletRequest.status !== "pending") {
        return { status: "already-reviewed" as const };
      }

      await client.query(
        `
          UPDATE wallet_topup_requests
          SET status = 'rejected',
              reviewed_at = NOW(),
              reviewed_by = $2,
              updated_at = NOW()
          WHERE id = $1
            AND organization_id = $3
        `,
        [requestId, request.user.id, request.user.organization_id]
      );

      return { status: "rejected" as const };
    });

    if (!result) {
      return reply.code(404).send({ message: "Wallet request not found" });
    }

    if (result.status === "already-reviewed") {
      return reply.code(409).send({ message: "Wallet request was already reviewed" });
    }

    return { success: true };
  });

  app.post("/admin/users/:id/wallet/credit", { preHandler: requireAdmin }, async (request) => {
    const userId = String((request.params as { id: string }).id);
    const body = amountSchema.parse(request.body);

    const result = await withTransaction(async (client) =>
      mutateWalletBalance(client, {
        organizationId: request.user.organization_id,
        userId,
        amountPaise: Math.round(body.amount * 100),
        type: "credit",
        reason: "manual_topup",
        metadata: {
          creditedByAdminId: request.user.id,
          source: "admin_wallet_credit",
          organizationId: request.user.organization_id
        }
      })
    );

    return {
      success: true,
      wallet_balance: (result.balanceAfterPaise / 100).toFixed(2)
    };
  });

  app.get("/admin/jobs", { preHandler: requireAdmin }, async (request) => {
    const states: Array<"active" | "delayed" | "waiting" | "failed"> = [
      "active",
      "delayed",
      "waiting",
      "failed"
    ];
    const queues = [
      { name: CONTEST_LIFECYCLE_QUEUE, queue: getQueueByName(CONTEST_LIFECYCLE_QUEUE) },
      { name: PAYOUTS_QUEUE, queue: getQueueByName(PAYOUTS_QUEUE) }
    ];

    const jobsByQueue = await Promise.all(
      queues.map(async ({ name, queue }) => {
        const jobs = await queue.getJobs(states);
        return jobs
          .filter((job) => (job.data as { organizationId?: string }).organizationId === request.user.organization_id)
          .map((job) => ({
            job_id: job.id,
            queue: name,
            job_name: job.name,
            data: job.data,
            status: job.failedReason
              ? "failed"
              : job.processedOn
                ? "active"
                : job.delay > 0
                  ? "delayed"
                  : "waiting",
            attempts: job.attemptsMade,
            failed_reason: job.failedReason ?? null,
            scheduled_for: new Date(job.timestamp + job.delay).toISOString()
          }));
      })
    );

    return { jobs: jobsByQueue.flat() };
  });

  app.post("/admin/jobs/:queue/:jobId/retry", { preHandler: requireAdmin }, async (request, reply) => {
    const { queue: queueName, jobId } = request.params as { queue: string; jobId: string };
    const queue = getQueueByName(queueName);
    const job = await queue.getJob(jobId);

    if (job) {
      if ((job.data as { organizationId?: string }).organizationId !== request.user.organization_id) {
        return reply.code(404).send({ message: "Job not found" });
      }

      if (job.failedReason) {
        await job.retry();
        return { success: true, mode: "retried_failed_job" };
      }

      return { success: true, mode: "job_already_exists" };
    }

    if (queueName !== CONTEST_LIFECYCLE_QUEUE) {
      return reply.code(404).send({ message: "Missing payout job cannot be reconstructed automatically" });
    }

    const [organizationId, jobName, contestId, seq] = jobId.split("__");

    if (!organizationId || !jobName || !contestId || organizationId !== request.user.organization_id) {
      return reply.code(400).send({ message: "Invalid job id format" });
    }

    await queue.add(
      jobName,
      { organizationId, contestId, seq: seq ? Number(seq) : undefined },
      { jobId }
    );

    return { success: true, mode: "recreated_missing_job" };
  });

  app.post("/admin/contests/:id/rebuild-cache", { preHandler: requireAdmin }, async (request) => {
    const contestId = String((request.params as { id: string }).id);
    return rebuildContestCache(contestId, request.user.organization_id);
  });

  app.post("/admin/contests/:id/recover", { preHandler: requireAdmin }, async (request) => {
    const contestId = String((request.params as { id: string }).id);
    const cache = await rebuildContestCache(contestId, request.user.organization_id);
    const jobs = await ensureContestJobs(contestId, request.user.organization_id);

    return {
      success: true,
      cache,
      jobs
    };
  });

  app.addHook("onClose", async () => {
    await closeWalletRequestEventSubscriber();
  });
}
