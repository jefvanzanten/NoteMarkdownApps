export type WorkPriority = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CancellationToken {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
}

export interface ScheduledWork<T> {
  key: string;
  workspaceId: string;
  generation: number;
  priority: WorkPriority;
  run(token: CancellationToken): Promise<T>;
}

export interface SchedulerOptions {
  concurrency?: number;
  now?: () => number;
  agingIntervalMs?: number;
  onQueueWait?: (milliseconds: number, priority: WorkPriority) => void;
}

interface QueueItem {
  work: ScheduledWork<unknown>;
  queuedAt: number;
  sequence: number;
  listeners: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }>;
  token: MutableCancellationToken;
}

class MutableCancellationToken implements CancellationToken {
  cancelled = false;

  /**
   * Throws when the scheduler generation has been cancelled.
   * @returns Nothing when work remains current.
   */
  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledWorkError();
  }
}

export class CancelledWorkError extends Error {
  /** Creates a stable cancellation error. */
  constructor() {
    super("Scheduled work was cancelled.");
    this.name = "CancelledWorkError";
  }
}

/**
 * Clamps scheduler concurrency to a safe bounded range.
 * @param value Requested concurrency.
 * @returns Integer concurrency between one and sixteen.
 */
function boundedConcurrency(value: number): number {
  return Math.max(1, Math.min(16, Math.floor(value)));
}

export class PriorityScheduler {
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly agingIntervalMs: number;
  private readonly onQueueWait?: SchedulerOptions["onQueueWait"];
  private readonly queue: QueueItem[] = [];
  private readonly items = new Map<string, QueueItem>();
  private readonly workspaceGenerations = new Map<string, number>();
  private running = 0;
  private sequence = 0;

  /**
   * Creates a bounded, deduplicating priority scheduler.
   * @param options Concurrency, clock, starvation aging, and diagnostics.
   */
  constructor(options: SchedulerOptions = {}) {
    this.concurrency = boundedConcurrency(options.concurrency ?? 3);
    this.now = options.now ?? Date.now;
    this.agingIntervalMs = Math.max(1, options.agingIntervalMs ?? 15_000);
    this.onQueueWait = options.onQueueWait;
  }

  /**
   * Enqueues work or joins an existing request with the same generation identity.
   * @param work Work descriptor and async operation.
   * @returns Shared operation result.
   */
  enqueue<T>(work: ScheduledWork<T>): Promise<T> {
    const identity = this.identity(work);
    const existing = this.items.get(identity);
    if (existing) {
      if (work.priority < existing.work.priority) existing.work = { ...existing.work, priority: work.priority };
      return new Promise<T>((resolve, reject) => existing.listeners.push({ resolve: resolve as (value: unknown) => void, reject }));
    }

    const currentGeneration = this.workspaceGenerations.get(work.workspaceId);
    if (currentGeneration !== undefined && work.generation < currentGeneration) return Promise.reject(new CancelledWorkError());
    this.workspaceGenerations.set(work.workspaceId, Math.max(currentGeneration ?? work.generation, work.generation));

    const item: QueueItem = {
      work: work as ScheduledWork<unknown>,
      queuedAt: this.now(),
      sequence: this.sequence++,
      listeners: [],
      token: new MutableCancellationToken(),
    };
    this.items.set(identity, item);
    this.queue.push(item);
    const result = new Promise<T>((resolve, reject) => item.listeners.push({ resolve: resolve as (value: unknown) => void, reject }));
    this.drain();
    return result;
  }

  /**
   * Cancels queued and running work older than a workspace generation.
   * @param workspaceId Stable workspace identity.
   * @param generation New active fencing generation.
   * @returns Nothing after stale tokens are fenced.
   */
  cancelOlderGenerations(workspaceId: string, generation: number): void {
    this.workspaceGenerations.set(workspaceId, generation);
    for (const item of this.items.values()) {
      if (item.work.workspaceId === workspaceId && item.work.generation < generation) item.token.cancelled = true;
    }
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (!item.token.cancelled) continue;
      this.queue.splice(index, 1);
      this.rejectItem(item, new CancelledWorkError());
    }
  }

  /**
   * Reports scheduler activity for lifecycle and test coordination.
   * @returns Queued and running work counts.
   */
  getActivity(): { queued: number; running: number } {
    return { queued: this.queue.length, running: this.running };
  }

  /**
   * Creates a deduplication identity from work scope and generation.
   * @param work Scheduled work.
   * @returns Stable in-memory identity.
   */
  private identity(work: ScheduledWork<unknown>): string {
    return `${work.workspaceId}:${work.generation}:${work.key}`;
  }

  /**
   * Starts queued items while bounded capacity is available.
   * @returns Nothing; completions continue draining asynchronously.
   */
  private drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.takeNext();
      if (!item) return;
      if (item.token.cancelled) {
        this.rejectItem(item, new CancelledWorkError());
        continue;
      }
      this.running += 1;
      this.onQueueWait?.(Math.max(0, this.now() - item.queuedAt), item.work.priority);
      void item.work.run(item.token).then(
        (value) => this.resolveItem(item, value),
        (error) => this.rejectItem(item, error),
      ).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  /**
   * Selects the best queued item with bounded starvation aging.
   * @returns Next queue item or null.
   */
  private takeNext(): QueueItem | null {
    if (this.queue.length === 0) return null;
    const currentTime = this.now();
    this.queue.sort((left, right) => {
      const leftPriority = Math.max(0, left.work.priority - Math.floor((currentTime - left.queuedAt) / this.agingIntervalMs));
      const rightPriority = Math.max(0, right.work.priority - Math.floor((currentTime - right.queuedAt) / this.agingIntervalMs));
      return leftPriority - rightPriority || left.sequence - right.sequence;
    });
    return this.queue.shift() ?? null;
  }

  /**
   * Resolves every caller joined to one deduplicated item.
   * @param item Completed item.
   * @param value Operation result.
   * @returns Nothing after listeners are notified.
   */
  private resolveItem(item: QueueItem, value: unknown): void {
    this.items.delete(this.identity(item.work));
    for (const listener of item.listeners) listener.resolve(value);
  }

  /**
   * Rejects every caller joined to one deduplicated item.
   * @param item Failed item.
   * @param reason Failure or cancellation reason.
   * @returns Nothing after listeners are notified.
   */
  private rejectItem(item: QueueItem, reason: unknown): void {
    this.items.delete(this.identity(item.work));
    for (const listener of item.listeners) listener.reject(reason);
  }
}
