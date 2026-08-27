export class KeyedSerialTaskQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Runs one task after all previously queued work for the same key.
   * A rejected predecessor never prevents later queued work from running.
   * @param key Stable serialization key.
   * @param task Deferred task that reads fresh state when it starts.
   * @returns The task result after preceding work settles.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.tails.set(key, current);
    void current.finally(() => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    }).catch(() => undefined);
    return current;
  }

  /**
   * Reports whether queued or active work exists for one key.
   * @param key Stable serialization key.
   * @returns Whether the queue still owns the key.
   */
  has(key: string): boolean {
    return this.tails.has(key);
  }
}
