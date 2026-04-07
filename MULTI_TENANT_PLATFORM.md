# Multi-Tenant Quiz Contest Platform

## Overview

This platform uses:

- `PostgreSQL` as the source of truth for tenants, users, contests, answers, wallet ledger, and reliability state
- `Redis` for low-latency contest state, membership caches, scoreboards, and Pub/Sub fan-out
- `JWT` access tokens carrying `organization_id` as the authenticated tenant context
- `BullMQ` workers for contest lifecycle, payouts, retries, and refunds

The browser uses the organization `slug`. The backend resolves slug to the internal `organization_id` and keeps that UUID out of the visible login flow.

## Tenant Context Per Request

Unauthenticated requests:

- The client sends `x-organization-slug` or `organization` query param
- The API resolves slug to `organization_id` using the `organizations` table

Authenticated requests:

- The access token includes `organization_id`
- The API authenticates the token and loads the user with `(user_id, organization_id)`
- If a slug is also sent, the API resolves it and rejects the request if it does not match the JWT tenant

This keeps the UI slug-based while keeping internal isolation UUID-based.

## Database Schema

Core tenant catalog:

- `organizations(id, slug, name, admin_email, created_at, updated_at)`

Tenant-scoped domain tables:

- `users(id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned, ...)`
- `oauth_accounts(id, user_id, organization_id, provider, provider_uid, email, ...)`
- `refresh_tokens(id, user_id, organization_id, token_hash, expires_at, revoked_at, ...)`
- `contests(id, organization_id, title, status, lifecycle_status, entry_fee, max_members, member_count, starts_at, current_q, q_started_at, ended_at, prize_rule, created_by, ...)`
- `questions(id, contest_id, organization_id, seq, body, option_a, option_b, option_c, option_d, correct_option, time_limit_sec, revealed_at, ...)`
- `contest_members(id, contest_id, user_id, organization_id, joined_at, is_winner, prize_amount, ...)`
- `answers(id, contest_id, question_id, user_id, organization_id, chosen_option, is_correct, answered_at, ...)`
- `wallet_transactions(id, user_id, organization_id, type, reason, tx_status, amount, balance_before, balance_after, reference_id, metadata, ...)`
- `wallet_topup_requests(id, user_id, organization_id, amount, status, requested_at, reviewed_at, reviewed_by, ...)`

Isolation controls:

- Every tenant-owned table has `organization_id`
- Composite foreign keys pin child rows to the same tenant
- All application queries filter by `organization_id`
- Same email is allowed across tenants via `UNIQUE (organization_id, email)`

Important indexes and uniqueness:

- `users (organization_id, email)` unique
- `oauth_accounts (organization_id, provider, provider_uid)` unique
- `wallet_transactions (organization_id, user_id, reason, reference_id)` unique for `entry_fee`, `prize`, and `refund`
- `contest_members (contest_id, user_id)` unique
- Tenant-first read indexes for contests, answers, wallet ledger, and requests

## API Design

Authentication:

- `GET /organizations/lookup?slug=...`
- `POST /organizations`
- `POST /auth/password-login`
- `POST /auth/request-code`
- `POST /auth/verify-code`
- `GET /auth/google`
- `GET /auth/google/callback`
- `POST /auth/google`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

Contest player APIs:

- `GET /contests`
- `GET /contests/all`
- `GET /contests/history`
- `POST /contests/:id/join`
- `GET /contests/:id/leaderboard`

Admin APIs:

- `GET /admin/users`
- `GET /admin/contests`
- `POST /admin/contests`
- `POST /admin/contests/:id/questions`
- `POST /admin/contests/:id/publish`
- `POST /admin/contests/:id/recover`
- `GET /admin/jobs`
- `POST /admin/jobs/:queue/:jobId/retry`

Gameplay:

- Socket authentication uses JWT
- Game server validates contest membership with tenant scope
- `submit_answer` writes `answers` with `organization_id`

## End-to-End Flow

1. User enters `organization slug + email + password`
2. API resolves `slug -> organization_id`
3. API authenticates the user inside that tenant only
4. JWT is issued with `organization_id`
5. User opens contests for that tenant only
6. User joins a contest, ₹10 is debited as a `PENDING` entry-fee transaction
7. Contest membership row is inserted inside the same DB transaction
8. Contest start worker moves the contest from `open` to `live`
9. Entry fee transaction status changes from `PENDING` to `SUCCESS`
10. Game server streams questions and records answers with tenant scope
11. Worker ends the contest, computes winners, credits prizes, and publishes results
12. User sees leaderboard and wallet ledger entries for the same tenant only

## Join Idempotency

Current protection is implemented at the ledger and membership layers:

- `contest_members (contest_id, user_id)` unique prevents duplicate membership
- `wallet_transactions` unique index for `reason = 'entry_fee'` and `reference_id = contest_id` prevents double debit
- The join flow locks the contest row with `FOR UPDATE`
- Duplicate join requests return the existing membership state instead of debiting again

Recommended client behavior:

- Send a stable idempotent action from the UI for retried joins
- Reuse the same request if the user retries after timeout

Recommended future hardening:

- Add a dedicated `idempotency_keys` table keyed by `(organization_id, user_id, key, route)`
- Store request hash, final response, status, and expiry
- Return the original response body for duplicate keys

## Retry and Refund Flow

Contest start:

- Worker retries contest start jobs with exponential backoff
- If Redis or game-server readiness fails across the configured attempts, the contest is cancelled
- Pending entry-fee transactions are marked `FAILED`
- A `refund-contest` job is enqueued

Refunds:

- Refund jobs run per `(organization_id, contest_id, user_id)`
- Refund credits are idempotent because `wallet_transactions` has a unique refund reference
- After refund succeeds, the original entry fee is marked `REFUNDED`

Prize payout:

- Prize credits are queued per winner
- Prize jobs are idempotent because prize transactions are unique per `(organization_id, user_id, contest_id)`

Recovery:

- Startup recovery recreates missing jobs for open and live contests
- A periodic sweep finds stale open contests and schedules refund jobs
- Admin can rebuild cache and recover jobs for a contest manually

## Failure Handling

Postgres down:

- Auth, join, wallet, and gameplay writes fail closed
- No tenant context is trusted without database-backed user validation
- No join completes unless both debit and membership insert commit together

Redis down:

- Gameplay and contest reads fall back to Postgres where supported
- Join succeeds from Postgres even if Redis lobby sync fails
- Worker start flow retries; if Redis remains unavailable at contest start, the contest is cancelled and refunded

Partial success scenarios:

- Debit succeeds but membership insert fails: the transaction rolls back, so no permanent debit remains
- Contest publish succeeds but queue add is missing: startup recovery and admin recovery recreate lifecycle jobs
- Contest start fails after pending debits exist: contest is cancelled and refund jobs are scheduled

## Preventing Cross-Tenant Data Leakage

Defense in depth:

- `organization_id` on every tenant-owned table
- Composite tenant foreign keys
- Tenant filter in every query
- JWT tenant binding
- Optional slug-to-token tenant consistency checks
- Tenant-prefixed Redis keys such as `org:{organizationId}:contest:{contestId}:...`
- Worker job payloads always include `organizationId`
- Admin job list filters jobs by tenant payload before returning them

## Edge Cases and Race Conditions

Handled:

- Same email in multiple tenants
- Duplicate join clicks
- Concurrent joins near `max_members`
- Duplicate answer submissions
- Retry after network timeout
- Worker restart during a live contest
- Redis cache miss with authoritative DB fallback

Still important operationally:

- Password auth in this repo is currently dev-friendly and should be swapped for real password hashing before production launch
- Public endpoints that require tenant context should prefer slug and avoid exposing UUIDs in URLs or visible forms
- A dedicated idempotency-key store would improve API replay behavior after client timeouts
- Consider Postgres row-level security as an additional enforcement layer if multiple services or analysts query the database directly

## Security Best Practices

- Keep `organization_id` only in backend state and JWT, not user-facing forms or URLs
- Validate tenant on every authenticated request
- Hash refresh tokens before storing them
- Use short-lived access tokens and rotating refresh tokens
- Never trust contest, user, or organization IDs from the browser without tenant revalidation
- Use parameterized SQL only
- Rate-limit login, join, and answer submission endpoints
- Add audit logs for admin actions and payout/refund actions
- Replace dev password auth with hashed passwords or SSO before production

## Scalability Notes for 100K+ Users

- Keep Postgres as source of truth and Redis as ephemeral runtime state
- Partition workload by tenant in queues and Redis keys
- Scale game servers horizontally with the Redis Socket.IO adapter
- Use BullMQ workers horizontally with tenant-aware concurrency guards
- Add read replicas for contest history, leaderboards, and admin analytics
- Consider table partitioning for `answers` and `wallet_transactions` by time or tenant volume
- Add caching for organization slug lookup and public contest lists
- Use connection pooling aggressively and keep DB transactions short

## Current Code Mapping

- Schema and migrations: [packages/db/migrations](/c:/Users/FL_LPT-622/Downloads/Quiz_code-main/packages/db/migrations)
- Tenant resolution: [tenant.ts](/c:/Users/FL_LPT-622/Downloads/Quiz_code-main/services/api-server/src/lib/tenant.ts)
- JWT auth: [auth.ts](/c:/Users/FL_LPT-622/Downloads/Quiz_code-main/services/api-server/src/lib/auth.ts)
- Contest join flow: [contests.ts](/c:/Users/FL_LPT-622/Downloads/Quiz_code-main/services/api-server/src/routes/contests.ts)
- Contest lifecycle, retry, payout, refund: [server.ts](/c:/Users/FL_LPT-622/Downloads/Quiz_code-main/services/worker-server/src/server.ts)
- Gameplay answer handling: [server.ts](/c:/Users/FL_LPT-622/Downloads/Quiz_code-main/services/game-server/src/server.ts)
