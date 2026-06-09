import type { KVStore } from "./runtime.js";
import type { QueuedOp } from "./types.js";

const QUEUE_KEY = "whisperr.queue.v1";

/**
 * A durable, ordered outbound queue. The backing store is the single source of
 * truth — every operation is a read-modify-write against it, so two browser
 * tabs sharing localStorage can't clobber each other's events (the classic
 * last-writer-wins bug). New events are appended; only the draining tab (holding
 * the cross-tab flush lock) removes from the front. Pre-identify track ops sit
 * here with a null user id until identify() backfills them.
 */
export class DurableQueue {
  constructor(
    private readonly store: KVStore,
    private readonly maxSize: number,
  ) {}

  get all(): QueuedOp[] {
    return this.read();
  }

  get size(): number {
    return this.read().length;
  }

  enqueue(op: QueuedOp): void {
    const ops = this.read();
    ops.push(op);
    if (ops.length > this.maxSize) {
      ops.splice(0, ops.length - this.maxSize); // drop oldest
    }
    this.write(ops);
  }

  /** Remove the first `n` ops (the ones we just delivered). */
  removeFront(n: number): void {
    if (n <= 0) return;
    const ops = this.read();
    ops.splice(0, n);
    this.write(ops);
  }

  /** Assign a now-known user id to every still-anonymous track op. */
  backfillIdentity(externalUserId: string): void {
    const ops = this.read();
    let changed = false;
    for (const op of ops) {
      if (op.kind === "track" && op.externalUserId === null) {
        op.externalUserId = externalUserId;
        changed = true;
      }
    }
    if (changed) this.write(ops);
  }

  clear(): void {
    this.write([]);
  }

  private read(): QueuedOp[] {
    const raw = this.store.get(QUEUE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedOp[]) : [];
    } catch {
      this.store.remove(QUEUE_KEY);
      return [];
    }
  }

  private write(ops: QueuedOp[]): void {
    this.store.set(QUEUE_KEY, JSON.stringify(ops));
  }
}
