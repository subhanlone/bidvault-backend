/**
 * BV-012: nothing reported whether the lifecycle worker was even running. A crashed worker
 * left every auction sitting ACTIVE past its end time forever, silently, with the API itself
 * giving no sign anything was wrong -- the reconcile sweep exists for exactly this failure
 * but only the worker process's own logs ever saw it fire.
 *
 * Lives here, not in src/workers/, so a service can import the key name without importing
 * anything that constructs a BullMQ Worker or connects to Redis on its own — the same reason
 * close-auction.ts stays apart from auction-lifecycle.worker.ts.
 */
export const WORKER_HEARTBEAT_KEY = 'worker:auction-lifecycle:heartbeat';
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
