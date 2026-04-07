# Quiz Master Architecture

## Overview

Quiz Master is a multi-tenant SaaS quiz platform with strict tenant isolation.

- Authentication: Google OAuth only
- Tenant identity: `organization_id` on all business tables
- Roles: `super_admin`, `organization_admin`, `player`
- Session model: short-lived JWT access token plus refresh token cookie
- Runtime stack:
  - Next.js frontend
  - Fastify API
  - PostgreSQL
  - Redis
  - BullMQ workers

## Core Flow

1. User clicks `Continue with Google`
2. API verifies Google identity and resolves the user by email
3. If email exists in `super_admins`, user is routed to `/super-admin`
4. Otherwise user is routed to `/join-organization`
5. User submits `organization_slug` and `employee_id`
6. API creates `memberships.status = pending`
7. Super admin or organization admin reviews the request
8. After approval, JWT contains:
   - `user_id`
   - `organization_id`
   - `role`
9. Tenant APIs enforce `organization_id` on every request

## Tenant Isolation

- Tenant-owned tables include `organization_id`
- Membership approvals bind a user to an organization
- Auth middleware rejects cross-tenant requests
- Tenant queries must always filter by `organization_id`
- Super admins use the global panel only and do not use tenant dashboards

## Main Tables

- `organizations`
- `users`
- `memberships`
- `super_admins`
- `audit_logs`
- `contests`
- `questions`
- `contest_members`
- `answers`
- `wallet_transactions`
- `wallet_topup_requests`
- `quiz_attempts`

## API Surface

### Auth

- `GET /auth/google`
- `GET /auth/google/callback`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

### Tenant Onboarding

- `POST /join-organization`

### Super Admin

- `GET /admin/pending-users`
- `POST /admin/approve-user`
- `POST /admin/create-organization`
- `GET /admin/organizations`
- `POST /admin/update-organization/:id`
- `POST /admin/toggle-organization`
- `DELETE /admin/organizations/:id`
- `GET /admin/system/users`
- `GET /admin/system/activity`

### Organization Admin / Player

Existing contest, wallet, and admin endpoints remain tenant-scoped.

## Deployment Notes

- Set `NODE_ENV=production`
- Set a strong `JWT_SECRET`
- Set `COOKIE_SECURE=true`
- Set `SUPER_ADMIN_EMAILS` to the approved platform admin emails
- Configure Google OAuth:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI`
- Run:
  - `pnpm install`
  - `pnpm db:migrate`
  - `pnpm db:seed`
  - `pnpm build:api-stack`
  - `pnpm --filter @quiz-app/frontend build`

## Production Hardening Status

Implemented:

- Google-only primary auth flow
- DB-backed roles
- DB-backed super admins
- pending approval onboarding
- organization activation/deactivation
- audit logging for login and review actions
- tenant-aware middleware and query isolation

Recommended next operational steps:

- wire email/notification jobs through BullMQ
- add managed secrets storage
- add dashboard analytics/metrics export
- add row-level security if direct SQL access must be hardened further
