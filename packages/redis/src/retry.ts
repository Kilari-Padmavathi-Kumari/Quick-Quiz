const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runRedisWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await Promise.race<T>([
        operation(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("Redis command timeout after 200ms")), 200)
        )
      ]);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(attempt * 100);
      }
    }
  }

  throw lastError;
}
