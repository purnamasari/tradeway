// Periodic-work scheduler with two interchangeable backends.
//
// The bot has a handful of recurring jobs: per-symbol scans, a funding/OI poll,
// outcome evaluation, and daily retention cleanup. These are expressed once as
// `PeriodicTask`s, then driven by whichever backend is available:
//
//   • BullMQ (when REDIS_URL is set) — durable repeatable jobs that survive
//     restarts, with concurrency control, retries, and failure visibility.
//   • setInterval fallback (no Redis) — keeps the keyless/dev path working with
//     zero external dependencies, exactly as before.
//
// Callers build the task list and call startScheduler(); they don't care which
// backend runs. bullmq/ioredis are imported dynamically so they stay optional.
import { logger } from "../logger.js";
// Type-only (erased at runtime, adds no dependency). BullMQ bundles its own copy
// of ioredis, so a connection built with the project's ioredis needs a cast to
// satisfy BullMQ's structurally-identical-but-nominally-different type.
import type { ConnectionOptions } from "bullmq";

export interface PeriodicTask {
  /** Stable unique name — also the BullMQ job name / repeatable id. */
  name: string;
  everyMs: number;
  run: () => Promise<void>;
  /** Also run once shortly after boot, not just after the first interval. */
  runAtBoot?: boolean;
  /** Max random startup delay (interval backend only) so tasks don't fire together. */
  jitterMs?: number;
}

export interface Scheduler {
  readonly kind: "bullmq" | "interval";
  stop(): Promise<void>;
}

/** Run a task, logging (never throwing) on failure so one bad run can't kill the loop. */
function safeRun(t: PeriodicTask): Promise<void> {
  return t.run().catch((e) => logger.error(`[sched] ${t.name} failed: ${(e as Error).message}`));
}

// ── Interval backend (no dependencies) ────────────────────────────────────────

export function startIntervalScheduler(tasks: PeriodicTask[]): Scheduler {
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];

  for (const t of tasks) {
    const begin = () => {
      if (t.runAtBoot) void safeRun(t);
      intervals.push(setInterval(() => void safeRun(t), t.everyMs));
    };
    const jitter = t.jitterMs ? Math.floor(Math.random() * t.jitterMs) : 0;
    if (jitter > 0) timeouts.push(setTimeout(begin, jitter));
    else begin();
  }

  logger.info(`[sched] interval scheduler · ${tasks.length} tasks`);
  return {
    kind: "interval",
    async stop() {
      intervals.forEach(clearInterval);
      timeouts.forEach(clearTimeout);
    },
  };
}

// ── BullMQ backend (requires Redis) ───────────────────────────────────────────

async function startBullScheduler(redisUrl: string, tasks: PeriodicTask[]): Promise<Scheduler | null> {
  let Queue: typeof import("bullmq").Queue;
  let Worker: typeof import("bullmq").Worker;
  let IORedis: typeof import("ioredis").default;
  try {
    ({ Queue, Worker } = await import("bullmq"));
    IORedis = (await import("ioredis")).default;
  } catch (err) {
    logger.warn(`[sched] bullmq/ioredis unavailable (${(err as Error).message}) — interval fallback`);
    return null;
  }

  const QUEUE = "tradeaway";
  const byName = new Map(tasks.map((t) => [t.name, t]));
  // BullMQ requires maxRetriesPerRequest: null on its blocking connection.
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const conn = connection as unknown as ConnectionOptions;

  // Fail fast if Redis is misconfigured rather than silently degrading.
  try {
    await connection.ping();
  } catch (err) {
    logger.warn(`[sched] redis ping failed (${(err as Error).message}) — interval fallback`);
    connection.disconnect();
    return null;
  }

  const queue = new Queue(QUEUE, { connection: conn });

  // Clear prior repeatables so changed intervals (across deploys) don't leave
  // stale schedules behind, then (re)register from the current task list.
  for (const r of await queue.getRepeatableJobs()) {
    await queue.removeRepeatableByKey(r.key);
  }
  for (const t of tasks) {
    await queue.add(
      t.name,
      {},
      { repeat: { every: t.everyMs }, jobId: t.name, removeOnComplete: true, removeOnFail: 50 },
    );
    if (t.runAtBoot) {
      await queue.add(t.name, {}, { removeOnComplete: true, removeOnFail: 50 });
    }
  }

  const worker = new Worker(
    QUEUE,
    async (job) => {
      const t = byName.get(job.name);
      if (t) await t.run(); // throwing here lets BullMQ record the failure
    },
    { connection: conn, concurrency: Math.max(4, tasks.length) },
  );
  worker.on("failed", (job, err) => logger.error(`[sched] job ${job?.name ?? "?"} failed: ${err.message}`));

  logger.info(`[sched] bullmq scheduler · ${tasks.length} tasks · redis`);
  return {
    kind: "bullmq",
    async stop() {
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}

// ── Selector ──────────────────────────────────────────────────────────────────

/**
 * Use BullMQ when a Redis URL is configured (and reachable); otherwise fall back
 * to the dependency-free interval scheduler. Always resolves to a working
 * scheduler — a Redis/BullMQ problem degrades rather than crashes.
 */
export async function startScheduler(
  redisUrl: string | undefined,
  tasks: PeriodicTask[],
): Promise<Scheduler> {
  if (redisUrl) {
    try {
      const bull = await startBullScheduler(redisUrl, tasks);
      if (bull) return bull;
    } catch (err) {
      logger.warn(`[sched] bullmq init error (${(err as Error).message}) — interval fallback`);
    }
  }
  return startIntervalScheduler(tasks);
}
