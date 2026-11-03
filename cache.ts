/** Small TTL+LRU cache so a repeated identical call is not billed twice. */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  hits = 0;
  misses = 0;

  constructor(ttlMs: number, maxEntries = 64) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency for LRU ordering.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

export function cacheKey(parts: Record<string, unknown>): string {
  return JSON.stringify(parts, Object.keys(parts).sort());
}
