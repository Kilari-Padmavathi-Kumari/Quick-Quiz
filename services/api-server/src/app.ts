import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import { pool } from "@quiz-app/db";

import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { contestRoutes } from "./routes/contests.js";
import { walletRoutes } from "./routes/wallet.js";
import { config } from "./env.js";
import { redis } from "./lib/redis.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  const allowedOrigins = new Set(config.frontendUrls);

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(origin)) {
        callback(null, origin);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    credentials: true
  });
  await app.register(cookie);

  app.get("/health", async (_request, reply) => {
    const checks = {
      db: false,
      redis: false
    };

    try {
      await pool.query("SELECT 1");
      checks.db = true;
    } catch {
      checks.db = false;
    }

    try {
      checks.redis = (await redis.ping()) === "PONG";
    } catch {
      checks.redis = false;
    }

    const ok = checks.db && checks.redis;

    return reply.code(ok ? 200 : 503).send({
      ok,
      service: "api-server",
      checks
    });
  });

  await app.register(authRoutes);
  await app.register(walletRoutes);
  await app.register(contestRoutes);
  await app.register(adminRoutes);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        message: "Validation failed",
        issues: error.issues
      });
    }

    if (error instanceof Error) {
      const maybeHttpError = error as Error & { statusCode?: number };

      if (typeof maybeHttpError.statusCode === "number") {
        return reply.code(maybeHttpError.statusCode).send({
          message: maybeHttpError.message
        });
      }
    }

    reply.log.error({ err: error }, "Unhandled API error");
    return reply.code(500).send({
      message: error instanceof Error ? error.message : "Internal server error"
    });
  });

  app.addHook("onClose", async () => {
    await redis.quit();
  });

  return app;
}
