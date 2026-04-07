import { pool } from "@quiz-app/db";

import { config } from "./env.js";

const PLATFORM_GLOBAL_ORG_ID = "00000000-0000-0000-0000-000000000000";

const demoUsers = [
  { email: "padmavathi.kilari@fissionlabs.com", name: "Quiz Admin", is_admin: true, balance: "500.00" },
  { email: "player.one@gmail.com", name: "Player One", is_admin: false, balance: "100.00" },
  { email: "player.two@gmail.com", name: "Player Two", is_admin: false, balance: "100.00" }
];

async function seed() {
  const organizationId = config.defaultOrganizationId;
  const organizationSlug = "quick-quiz-arena";
  const companyId = config.defaultCompanyId || organizationSlug;

  if (!organizationId) {
    throw new Error("DEFAULT_ORGANIZATION_ID must be set before seeding data");
  }

  await pool.query(
    `
      INSERT INTO organizations (id, name, slug, admin_email, company_id, status)
      VALUES ($1, 'Quick Quiz Arena', $2, $3, $4, 'active')
      ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          admin_email = EXCLUDED.admin_email,
          company_id = EXCLUDED.company_id,
          status = EXCLUDED.status,
          updated_at = NOW()
    `,
    [organizationId, organizationSlug, config.adminEmail, companyId]
  );

  for (const email of new Set([config.adminEmail, ...config.superAdminEmails])) {
    await pool.query(
      `
        INSERT INTO super_admins (email, is_active)
        VALUES ($1, TRUE)
        ON CONFLICT (email) DO UPDATE
        SET is_active = TRUE
      `,
      [email]
    );
  }

  for (const user of demoUsers) {
    const shouldStayGlobal = new Set([config.adminEmail, ...config.superAdminEmails]).has(user.email);
    const targetOrganizationId = shouldStayGlobal ? PLATFORM_GLOBAL_ORG_ID : organizationId;

    const userResult = await pool.query<{ id: string }>(
      `
        INSERT INTO users (organization_id, email, name, is_admin, wallet_balance)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT ((LOWER(email))) DO UPDATE
        SET name = EXCLUDED.name,
            organization_id = EXCLUDED.organization_id,
            is_admin = EXCLUDED.is_admin,
            wallet_balance = EXCLUDED.wallet_balance,
            status = 'active',
            updated_at = NOW()
        RETURNING id
      `,
      [targetOrganizationId, user.email, user.name, shouldStayGlobal ? false : user.is_admin, user.balance]
    );

    await pool.query(
      `
        INSERT INTO memberships (user_id, organization_id, role, employee_id, status, approved_at, updated_at)
        VALUES ($1, $2, $3, $4, 'approved', NOW(), NOW())
        ON CONFLICT (user_id, organization_id) DO UPDATE
        SET role = EXCLUDED.role,
            employee_id = EXCLUDED.employee_id,
            status = 'approved',
            approved_at = NOW(),
            updated_at = NOW()
      `,
      [
        userResult.rows[0].id,
        organizationId,
        user.is_admin ? "organization_admin" : "player",
        `seed-${user.email.split("@")[0].replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
      ]
    );
  }

  const existingContest = await pool.query<{ id: string }>(
    "SELECT id FROM contests WHERE title = 'General Knowledge Sprint' AND organization_id = $1 LIMIT 1",
    [organizationId]
  );

  const contestId =
    existingContest.rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `
          INSERT INTO contests (title, status, entry_fee, max_members, starts_at, prize_rule, organization_id)
          VALUES ('General Knowledge Sprint', 'draft', '10.00', 100, NOW() + INTERVAL '30 minutes', 'all_correct', $1)
          RETURNING id
        `,
        [organizationId]
      )
    ).rows[0].id;

  const existingQuestions = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM questions WHERE contest_id = $1",
    [contestId]
  );

  if (Number(existingQuestions.rows[0].count) === 0) {
    await pool.query(
      `
        INSERT INTO questions (
          contest_id, organization_id, seq, body, option_a, option_b, option_c, option_d, correct_option, time_limit_sec
        )
        VALUES
          ($1, $2, 1, 'What is the capital of India?', 'Mumbai', 'New Delhi', 'Chennai', 'Kolkata', 'b', 15),
          ($1, $2, 2, 'Which planet is known as the Red Planet?', 'Venus', 'Saturn', 'Mars', 'Mercury', 'c', 15),
          ($1, $2, 3, 'How many minutes are in one hour?', '45', '50', '55', '60', 'd', 15)
      `,
      [contestId, organizationId]
    );
  }

  console.log("Seed completed");
  await pool.end();
}

seed().catch((error) => {
  console.error("Seed failed", error);
  process.exitCode = 1;
});
