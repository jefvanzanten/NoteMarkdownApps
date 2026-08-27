import { retryDelay, type RetryPolicy, type RetryableFailure } from "./retry";

export interface RetryOperationOptions {
  isRetryable: (error: unknown) => RetryableFailure | null;
  policy?: RetryPolicy;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  onRetry?: (event: { error: unknown; attempt: number; delayMs: number }) => void;
}

/** Waits before a retry attempt. @param milliseconds Delay duration. @returns Promise resolved after the delay. */
const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Runs an operation under a bounded, injectable retry policy.
 * @param operation Asynchronous operation to execute.
 * @param options Retry classification, timing, and observation options.
 * @returns Successful operation result.
 */
export async function retryOperation<T>(operation: () => Promise<T>, options: RetryOperationOptions): Promise<T> {
  let attempt = 0;
  while (true) {
    try { return await operation(); }
    catch (error) {
      const failure = options.isRetryable(error);
      const delayMs = failure ? retryDelay(attempt, failure, options.policy, options.random) : null;
      if (delayMs === null) throw error;
      attempt += 1;
      options.onRetry?.({ error, attempt, delayMs });
      await (options.sleep ?? defaultSleep)(delayMs);
    }
  }
}
