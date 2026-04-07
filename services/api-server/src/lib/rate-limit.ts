import type { FastifyRequest } from "fastify";

import { redis } from "./redis.js";

function getRequestIp(request: FastifyRequest) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const candidate =
    typeof forwardedFor === "string"
      ? forwardedFor.split(",")[0]
      : Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : request.ip;

  return (candidate ?? request.ip ?? "unknown").trim();
}

export async function enforceRateLimit(
  request: FastifyRequest,
  options: {
    scope: string;
    limit: number;
    windowSec: number;
  }
) {
  const key = `rate-limit:${options.scope}:${getRequestIp(request)}`;
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.expire(key, options.windowSec);
  }

  if (current > options.limit) {
    throw Object.assign(new Error("Too many requests. Please try again later."), {
      statusCode: 429
    });
  }
}
