import { createRedisClient } from "@quiz-app/redis";

type WalletRequestCreatedEvent = {
  type: "wallet_request_created";
  request_id: string;
  user_id: string;
  organization_id: string;
  amount: string;
  requested_at: string;
};

type WalletRequestStream = {
  send: (event: WalletRequestCreatedEvent) => void;
  close: () => void;
};

const streams = new Set<WalletRequestStream>();
const subscriber = createRedisClient("api-server-wallet-request-events");
let subscriberReady: Promise<void> | null = null;
const WALLET_REQUESTS_CHANNEL = "wallet:requests";

async function ensureSubscriber() {
  if (!subscriberReady) {
    subscriberReady = (async () => {
      await subscriber.connect();
      await subscriber.subscribe(WALLET_REQUESTS_CHANNEL);
      subscriber.on("message", (_channel, payload) => {
        try {
          const event = JSON.parse(payload) as WalletRequestCreatedEvent;

          for (const stream of streams) {
            stream.send(event);
          }
        } catch {
          // Ignore malformed payloads so the stream stays alive.
        }
      });
    })();
  }

  await subscriberReady;
}

export async function publishWalletRequestCreated(event: WalletRequestCreatedEvent, publisher: { publish: (channel: string, message: string) => Promise<number> }) {
  await publisher.publish(WALLET_REQUESTS_CHANNEL, JSON.stringify(event));
}

export async function registerWalletRequestStream(onEvent: WalletRequestStream["send"]) {
  await ensureSubscriber();

  const stream: WalletRequestStream = {
    send: onEvent,
    close: () => {
      streams.delete(stream);
    }
  };

  streams.add(stream);
  return stream;
}

export async function closeWalletRequestEventSubscriber() {
  streams.clear();

  if (subscriber.status !== "end") {
    await subscriber.quit();
  }
}
