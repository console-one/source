import { ColumnKey, PartitionMap, SortedSet, BlobStore } from './types.js'

/**
 * In-memory reference implementations of the storage-adapter primitives.
 *
 * Used by the smoke test and as a worked example of what implementing
 * against Redis / S3 / Postgres looks like (~30-50 lines per interface).
 *
 * NOT thread-safe and NOT persistent. If your process dies so does your
 * history. For anything real, back the interfaces with durable storage.
 */

export class InMemoryPartitionMap<V> implements PartitionMap<V> {
  private store = new Map<string, V>()

  async set(key: ColumnKey, value: V): Promise<void> {
    this.store.set(key.toString(), value)
  }

  async get(key: ColumnKey): Promise<V | undefined> {
    return this.store.get(key.toString())
  }

  async getAll(keys: ColumnKey[]): Promise<Array<[ColumnKey, V]>> {
    const out: Array<[ColumnKey, V]> = []
    for (const key of keys) {
      const v = this.store.get(key.toString())
      if (v !== undefined) out.push([key, v])
    }
    return out
  }

  async has(key: ColumnKey): Promise<boolean> {
    return this.store.has(key.toString())
  }

  async delete(key: ColumnKey): Promise<void> {
    this.store.delete(key.toString())
  }
}

export class InMemorySortedSet<V extends number> implements SortedSet<V> {
  private buckets = new Map<string, V[]>()

  async add(key: ColumnKey, value: V): Promise<void> {
    const k = key.toString()
    const bucket = this.buckets.get(k) ?? []
    if (!bucket.includes(value)) {
      bucket.push(value)
      bucket.sort((a, b) => a - b)
      this.buckets.set(k, bucket)
    }
  }

  async remove(key: ColumnKey, value: V): Promise<void> {
    const bucket = this.buckets.get(key.toString())
    if (!bucket) return
    const idx = bucket.indexOf(value)
    if (idx >= 0) bucket.splice(idx, 1)
  }

  async findMax(key: ColumnKey): Promise<V> {
    const bucket = this.buckets.get(key.toString())
    if (!bucket || bucket.length === 0) {
      throw new Error(`No values in sorted set for key ${key.toString()}`)
    }
    return bucket[bucket.length - 1]
  }
}

export class InMemoryBlobStore implements BlobStore {
  private store = new Map<string, string>()

  constructor(private bucketName = 'memory', private partitionName = 'default') {}

  bucket(): string { return this.bucketName }
  partition(): string { return this.partitionName }

  async read(path: string): Promise<string> {
    const v = this.store.get(path)
    if (v === undefined) throw new Error(`BlobStore: no blob at ${path}`)
    return v
  }

  async has(path: string): Promise<boolean> {
    return this.store.has(path)
  }

  async save(path: string, data: string): Promise<void> {
    this.store.set(path, data)
  }

  async delete(path: string): Promise<void> {
    this.store.delete(path)
  }
}
