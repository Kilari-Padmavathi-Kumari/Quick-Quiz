import { config } from "./env.js";
import { buildApp } from "./app.js";
import { redis } from "./lib/redis.js";

process.on("unhandledRejection", (reason) => {
  console.error("[api-server] Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[api-server] Uncaught exception", error);
});

try {
  const app = await buildApp();

  await redis.connect();
  await app.listen({
    host: "0.0.0.0",
    port: config.apiPort
  });

  console.log(`[api-server] Listening on ${config.apiPort}`);
} catch (error) {
  console.error("[api-server] Failed to start", error);
  process.exit(1);
}
