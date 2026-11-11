type Entry<T> = {
  value: T
  expiresAt: number
}

/**
 * 带 TTL 的 LRU。Map 的插入顺序即访问顺序：
 * 命中时先删再插，把该项移到队尾。
 */
export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>()

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined

    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key)
      return undefined
    }

    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    this.map.delete(key)
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })

    while (this.map.size > this.max) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
