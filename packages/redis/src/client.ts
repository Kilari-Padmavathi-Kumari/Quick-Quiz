import { Redis } from "ioredis";

function getRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

export function createRedisClient(name: string): Redis {
  return new Redis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableReadyCheck: true,
    connectionName: name
  });
}
