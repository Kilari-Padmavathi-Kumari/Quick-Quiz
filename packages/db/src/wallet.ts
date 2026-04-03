import type pg from "pg";

import { moneyToPaise, paiseToMoney } from "./money.js";

interface WalletMutationInput {
  organizationId: string;
  userId: string;
  amountPaise: number;
  type: "credit" | "debit";
  reason: "entry_fee" | "prize" | "refund" | "topup" | "manual_topup";
  transactionStatus?: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED";
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function mutateWalletBalance(
  client: pg.PoolClient,
  input: WalletMutationInput
) {
  if (input.amountPaise <= 0) {
    throw new Error("Wallet mutation amount must be greater than zero");
  }

  const userResult = await client.query<{ wallet_balance: string }>(
    "SELECT wallet_balance FROM users WHERE id = $1 AND organization_id = $2 FOR UPDATE",
    [input.userId, input.organizationId]
  );

  if (userResult.rowCount !== 1) {
    throw new Error("User not found while mutating wallet");
  }

  const balanceBeforePaise = moneyToPaise(userResult.rows[0].wallet_balance);
  const nextBalancePaise =
    input.type === "credit"
      ? balanceBeforePaise + input.amountPaise
      : balanceBeforePaise - input.amountPaise;

  if (nextBalancePaise < 0) {
    const error = new Error("Insufficient wallet balance");
    error.name = "INSUFFICIENT_BALANCE";
    throw error;
  }

  await client.query(
    `
      INSERT INTO wallet_transactions (
        user_id,
        organization_id,
        type,
        reason,
        tx_status,
        amount,
        balance_before,
        balance_after,
        reference_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    `,
    [
      input.userId,
      input.organizationId,
      input.type,
      input.reason,
      input.transactionStatus ?? "SUCCESS",
      paiseToMoney(input.amountPaise),
      paiseToMoney(balanceBeforePaise),
      paiseToMoney(nextBalancePaise),
      input.referenceId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  await client.query(
    "UPDATE users SET wallet_balance = $3, updated_at = NOW() WHERE id = $1 AND organization_id = $2",
    [input.userId, input.organizationId, paiseToMoney(nextBalancePaise)]
  );

  return {
    balanceBeforePaise,
    balanceAfterPaise: nextBalancePaise
  };
}
