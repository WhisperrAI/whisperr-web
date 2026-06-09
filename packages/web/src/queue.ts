import type { KVStore } from "./runtime.js";
import type { QueuedOp } from "./types.js";

const QUEUE_KEY = "whisperr.queue.v1";

/**
 * A durable, ordered outbound queue persisted to storage so events survive
 * reloads and crashes. Pre-identify track ops sit here with a null user id until
 * identify() backfills them (client-side anonymous→identified continuity).
 */
export class DurableQueue {
  private ops: QueuedOp[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: KVStore,
    private readonly maxSize: number,
  ) {
    this.restore();
  }

  get all(): readonly QueuedOp[] {
    return this.ops;
  }

  get size(): number {
    return this.ops.length;
  }

  enqueue(op: QueuedOp): void {
    this.ops.push(op);
    if (this.ops.length > this.maxSize) {
      this.ops.splice(0, this.ops.length - this.maxSize); // drop oldest
    }
    this.schedulePersist();
  }

  /** Remove the first `n` ops (the ones we just delivered). */
  removeFront(n: number): void {
    if (n <= 0) return;
    this.ops.splice(0, n);
    this.schedulePersist();
  }

  /** Assign a now-known user id to every still-anonymous track op. */
  backfillIdentity(externalUserId: string): void {
    let changed = false;
    for (const op of this.ops) {
      if (op.kind === "track" && op.externalUserId === null) {
        op.externalUserId = externalUserId;
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  clear(): void {
    this.ops = [];
    this.persistNow();
  }

  /** Force an immediate synchronous write (used on page unload). */
  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.store.set(QUEUE_KEY, JSON.stringify(this.ops));
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store.set(QUEUE_KEY, JSON.stringify(this.ops));
    }, 250);
  }

  private restore(): void {
    const raw = this.store.get(QUEUE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.ops = parsed as QueuedOp[];
    } catch {
      this.store.remove(QUEUE_KEY);
    }
  }
}
