import { Queue } from "bullmq";

export interface ContestLifecycleJobPayload {
  organizationId: string;
  contestId: string;
  seq?: number;
}

export interface PrizeCreditJobPayload {
  organizationId: string;
  contestId: string;
  userId: string;
}

export interface RefundJobPayload {
  organizationId: string;
  contestId: string;
  userId?: string;
}

export const CONTEST_LIFECYCLE_QUEUE = "contest-lifecycle";
export const PAYOUTS_QUEUE = "payouts";

export const contestLifecycleJobNames = {
  startContest: "start-contest",
  revealQuestion: "reveal-question",
  broadcastQuestion: "broadcast-question",
  endContest: "end-contest",
  refundContest: "refund-contest"
} as const;

export const payoutJobNames = {
  prizeCredit: "prize-credit",
  refund: "refund"
} as const;

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379"
};

export const contestLifecycleQueue = new Queue<ContestLifecycleJobPayload>(CONTEST_LIFECYCLE_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000
    },
    removeOnComplete: 1000,
    removeOnFail: 1000
  }
});

export const payoutsQueue = new Queue<PrizeCreditJobPayload | RefundJobPayload>(PAYOUTS_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000
    },
    removeOnComplete: 1000,
    removeOnFail: 1000
  }
});

export function getQueueByName(name: string) {
  if (name === CONTEST_LIFECYCLE_QUEUE) {
    return contestLifecycleQueue;
  }

  if (name === PAYOUTS_QUEUE) {
    return payoutsQueue;
  }

  throw new Error(`Unsupported queue name: ${name}`);
}
