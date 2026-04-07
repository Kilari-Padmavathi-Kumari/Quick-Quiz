import { createRedisClient, walletRequestsChannel } from "@quiz-app/redis";

type WalletRequestCreatedEvent = {
  type: "wallet_request_created";
  request_id: string;
  user_id: string;
  organization_id: string;
  amount: string;
  requested_at: string;
};

type WalletRequestStream = {
  organizationId: string;
  send: (event: WalletRequestCreatedEvent) => void;
  close: () => void;
};

const streamsByOrganization = new Map<string, Set<WalletRequestStream>>();
const subscriber = createRedisClient("api-server-wallet-request-events");
let subscriberReady: Promise<void> | null = null;
const subscribedOrganizations = new Set<string>();

async function ensureSubscriber(organizationId: string) {
  if (!subscriberReady) {
    subscriberReady = (async () => {
      await subscriber.connect();
      subscriber.on("message", (_channel, payload) => {
        try {
          const event = JSON.parse(payload) as WalletRequestCreatedEvent;
          const streams = streamsByOrganization.get(event.organization_id);

          for (const stream of streams ?? []) {
            stream.send(event);
          }
        } catch {
          // Ignore malformed payloads so the stream stays alive.
        }
      });
    })();
  }

  await subscriberReady;

  if (!subscribedOrganizations.has(organizationId)) {
    await subscriber.subscribe(walletRequestsChannel(organizationId));
    subscribedOrganizations.add(organizationId);
  }
}

export async function publishWalletRequestCreated(event: WalletRequestCreatedEvent, publisher: { publish: (channel: string, message: string) => Promise<number> }) {
  await publisher.publish(walletRequestsChannel(event.organization_id), JSON.stringify(event));
}

export async function registerWalletRequestStream(organizationId: string, onEvent: WalletRequestStream["send"]) {
  await ensureSubscriber(organizationId);

  const scopedStreams = streamsByOrganization.get(organizationId) ?? new Set<WalletRequestStream>();
  const stream: WalletRequestStream = {
    organizationId,
    send: onEvent,
    close: () => {
      const activeStreams = streamsByOrganization.get(stream.organizationId);
      activeStreams?.delete(stream);

      if (activeStreams && activeStreams.size === 0) {
        streamsByOrganization.delete(stream.organizationId);
      }
    }
  };

  scopedStreams.add(stream);
  streamsByOrganization.set(organizationId, scopedStreams);
  return stream;
}

export async function closeWalletRequestEventSubscriber() {
  streamsByOrganization.clear();

  if (subscriber.status !== "end") {
    await subscriber.quit();
  }
}
