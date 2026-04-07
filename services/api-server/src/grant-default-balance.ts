import { moneyToPaise, mutateWalletBalance, pool, withTransaction } from "@quiz-app/db";

const DEFAULT_BALANCE_PAISE = 10_000;

async function grantDefaultBalance() {
  const result = await pool.query<{
    id: string;
    organization_id: string;
    email: string;
    name: string;
    wallet_balance: string;
  }>(
    `
      SELECT id, organization_id, email, name, wallet_balance
      FROM users
      WHERE is_admin = false
      ORDER BY created_at ASC
    `
  );

  let updatedUsers = 0;

  for (const user of result.rows) {
    const currentBalancePaise = moneyToPaise(user.wallet_balance);

    if (currentBalancePaise >= DEFAULT_BALANCE_PAISE) {
      continue;
    }

    const topUpPaise = DEFAULT_BALANCE_PAISE - currentBalancePaise;

    await withTransaction(async (client) =>
      mutateWalletBalance(client, {
        organizationId: user.organization_id,
        userId: user.id,
        amountPaise: topUpPaise,
        type: "credit",
        reason: "manual_topup",
        metadata: {
          source: "one_time_default_balance_script",
          targetBalance: "100.00"
        }
      })
    );

    updatedUsers += 1;
    console.log(
      `[grant-default-balance] Credited ${user.email} (${user.name}) by Rs ${(topUpPaise / 100).toFixed(2)}`
    );
  }

  console.log(
    `[grant-default-balance] Completed. Updated ${updatedUsers} user(s). Checked ${result.rows.length} non-admin user(s).`
  );

  await pool.end();
}

grantDefaultBalance().catch((error) => {
  console.error("[grant-default-balance] Failed", error);
  process.exitCode = 1;
});
