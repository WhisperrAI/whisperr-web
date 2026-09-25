import type { KVStore } from "./runtime.js";
import type { QueuedOp } from "./types.js";

const QUEUE_KEY = "whisperr.queue.v1";

/**
 * Stable identity of a queued op. Track ops carry their $message_id; an
 * identify is unique enough by user + timestamp. Used to settle deliveries by
 * identity rather than position — see DurableQueue.remove().
 */
export function opKey(op: QueuedOp): string {
  return op.kind === "track"
    ? `t:${op.messageId ?? `${op.occurredAt}:${op.eventType}`}`
    : `i:${op.externalUserId}:${op.occurredAt}`;
}

/**
 * A durable, ordered outbound queue. The backing store is the single source of
 * truth — every operation is a read-modify-write against it, so two browser
 * tabs sharing localStorage can't clobber each other's events (the classic
 * last-writer-wins bug). New events are appended; only the draining tab (holding
 * the cross-tab flush lock) removes from the front. Pre-identify track ops sit
 * here with a null user id and go out under the anonymous id; identify()
 * backfills the user id onto any still queued.
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

  /**
   * Remove delivered ops wherever they now sit. Positions aren't stable while a
   * request is in flight — an exit flush, another tab, or an overflow drop can
   * shift the queue — so removing "the first n" could drop unsent events.
   */
  remove(delivered: readonly QueuedOp[]): void {
    if (delivered.length === 0) return;
    const keys = new Set(delivered.map(opKey));
    const ops = this.read();
    const kept = ops.filter((op) => !keys.has(opKey(op)));
    if (kept.length !== ops.length) this.write(kept);
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
