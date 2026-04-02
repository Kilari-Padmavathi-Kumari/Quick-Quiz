# Deployment Guide

## Services

This project runs as four separate services:

- `services/frontend`
- `services/api-server`
- `services/game-server`
- `services/worker-server`

## Required Infrastructure

- PostgreSQL
- Redis
- Node.js 24.x
- pnpm 10.x

## Environment Variables

Frontend:

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_GAME_URL`

Backend services:

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `JWT_ISSUER`
- `JWT_AUDIENCE`

API-specific:

- `FRONTEND_URL`
- `COOKIE_DOMAIN`
- `COOKIE_SECURE`
- `ADMIN_EMAIL`

## Deployment Order

1. Install dependencies with `pnpm install`.
2. Run database migrations with `pnpm db:migrate`.
3. Optionally seed demo data with `pnpm db:seed`.
4. Deploy the API server.
5. Deploy the game server.
6. Deploy the worker server.
7. Deploy the frontend with the public API and game URLs.

## Notes

- The frontend depends on the API and game server public URLs.
- The worker server must stay running for contest scheduling and payouts.
- Redis is required for queue processing and live contest state.
- Set `COOKIE_SECURE=true` in production.
