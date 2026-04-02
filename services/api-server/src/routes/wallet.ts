import { pool } from "@quiz-app/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate } from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { publishWalletRequestCreated } from "../lib/wallet-request-events.js";

const walletAmountSchema = z.object({
  amount: z.number().positive().max(100000)
});

export async function walletRoutes(app: FastifyInstance) {
  app.get("/wallet/balance", { preHandler: authenticate }, async (request) => ({
    wallet_balance: request.user.wallet_balance
  }));

  app.get("/wallet/requests", { preHandler: authenticate }, async (request) => {
    const result = await pool.query<{
      id: string;
      amount: string;
      status: "pending" | "approved" | "rejected";
      requested_at: string;
      reviewed_at: string | null;
    }>(
      `
        SELECT id, amount, status, requested_at, reviewed_at
        FROM wallet_topup_requests
        WHERE user_id = $1
          AND organization_id = $2
        ORDER BY requested_at DESC
        LIMIT 20
      `,
      [request.user.id, request.user.organization_id]
    );

    return { requests: result.rows };
  });

  app.get("/wallet/transactions", { preHandler: authenticate }, async (request) => {
    const result = await pool.query<{
      id: string;
      type: "credit" | "debit";
      reason: "entry_fee" | "prize" | "refund" | "topup" | "manual_topup";
      amount: string;
      balance_before: string;
      balance_after: string;
      reference_id: string | null;
      metadata: Record<string, unknown>;
      created_at: string;
    }>(
      `
        SELECT
          id,
          type,
          reason,
          amount,
          balance_before,
          balance_after,
          reference_id,
          metadata,
          created_at
        FROM wallet_transactions
        WHERE user_id = $1
          AND organization_id = $2
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [request.user.id, request.user.organization_id]
    );

    return {
      transactions: result.rows
    };
  });

  app.post("/wallet/request-money", { preHandler: authenticate }, async (request, reply) => {
    const body = walletAmountSchema.parse(request.body);

    try {
      const createdRequest = (
        await pool.query<{
          id: string;
          amount: string;
          status: "pending";
          requested_at: string;
          reviewed_at: string | null;
        }>(
          `
            INSERT INTO wallet_topup_requests (user_id, organization_id, amount)
            VALUES ($1, $2, $3)
            RETURNING id, amount, status, requested_at, reviewed_at
          `,
          [request.user.id, request.user.organization_id, body.amount.toFixed(2)]
        )
      ).rows[0];

      try {
        await publishWalletRequestCreated(
          {
            type: "wallet_request_created",
            request_id: createdRequest.id,
            user_id: request.user.id,
            organization_id: request.user.organization_id,
            amount: createdRequest.amount,
            requested_at: createdRequest.requested_at
          },
          redis
        );
      } catch (publishError) {
        request.log.warn({ err: publishError }, "Failed to publish wallet request event");
      }

      return {
        success: true,
        request: createdRequest
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") {
        return reply.code(409).send({
          message: "You already have a pending wallet request. Wait for admin approval first."
        });
      }

      throw error;
    }
  });
}
