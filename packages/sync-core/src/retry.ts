export interface RetryPolicy {
  baseDelayMs: number;
  maximumDelayMs: number;
  maximumAttempts: number;
  jitterRatio: number;
}

export interface RetryableFailure {
  retryAfterMs?: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  baseDelayMs: 1_000,
  maximumDelayMs: 60_000,
  maximumAttempts: 8,
  jitterRatio: 0.2,
};

/**
 * Computes bounded exponential retry delay while respecting provider guidance.
 * @param attempt Zero-based failed attempt count.
 * @param failure Optional failure carrying a parsed Retry-After duration.
 * @param policy Retry bounds and jitter configuration.
 * @param random Random source injected for deterministic tests.
 * @returns Delay in milliseconds or null after the attempt limit.
 */
export function retryDelay(
  attempt: number,
  failure: RetryableFailure = {},
  policy: RetryPolicy = defaultRetryPolicy,
  random: () => number = Math.random,
): number | null {
  if (attempt >= policy.maximumAttempts) return null;
  if (failure.retryAfterMs !== undefined) return Math.min(policy.maximumDelayMs, Math.max(0, failure.retryAfterMs));
  const exponential = Math.min(policy.maximumDelayMs, policy.baseDelayMs * 2 ** attempt);
  const spread = exponential * Math.max(0, Math.min(1, policy.jitterRatio));
  return Math.max(0, Math.round(exponential - spread + random() * spread * 2));
}

/**
 * Parses an HTTP Retry-After header without retaining request details.
 * @param value Header value in seconds or HTTP-date form.
 * @param now Current epoch milliseconds.
 * @returns Non-negative delay or undefined for invalid input.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
