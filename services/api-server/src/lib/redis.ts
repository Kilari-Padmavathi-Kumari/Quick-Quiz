import { createRedisClient } from "@quiz-app/redis";

export const redis: ReturnType<typeof createRedisClient> = createRedisClient("api-server");
