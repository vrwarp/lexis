/**
 * Counts failed sign-in attempts in a sliding window. Two of these guard the
 * password: one per client address and one for everybody, so spreading a
 * guessing attack over many addresses does not get around it.
 */
export class FailureLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Seconds until `key` may try again, or 0 when it may try now. */
  retryAfter(key: string, now = Date.now()): number {
    const recent = this.recent(key, now);
    if (recent.length < this.max) return 0;
    return Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
  }

  fail(key: string, now = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.failures.set(key, recent);
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}
