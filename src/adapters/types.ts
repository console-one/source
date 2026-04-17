/**
 * Storage-adapter primitives.
 *
 * The event-sourced VCS engine in `Code.View.Checkpoint` operates against
 * these interfaces — never against Redis, S3, or any specific vendor. The
 * original monorepo wired these to `Generics.Awaited.Redis.PartitionMap` /
 * `SortedSet` and an `S3Dao`, but as the source's own TODO comments noted:
 *
 *   "TODO - Change this implementation class name from 'RedisImpl' to Default
 *    since there is nothing redis specific outside its instance vars."
 *
 * So here they are, abstracted. Ship with the in-memory reference impl in
 * `adapters/memory.ts`; back them with Redis/S3/Postgres/SQLite/Dynamo by
 * implementing these four interfaces in ~30-50 lines apiece.
 */

/**
 * A multi-part key into a partitioned store. Supports chained extension
 * for e.g. `(namespace, version)` composite keys. Equality is defined by
 * `toString()` — implementations that want structural equality should
 * override it.
 */
export class ColumnKey {
  constructor(public readonly parts: string[]) {}

  static from(...parts: string[]): ColumnKey {
    return new ColumnKey(parts)
  }

  extend(...parts: string[]): ColumnKey {
    return new ColumnKey([...this.parts, ...parts])
  }

  toString(): string {
    return this.parts.join('/')
  }
}

/**
 * A partition map: key/value store addressed by `ColumnKey`.
 *
 * Implementations: Redis hash (HSET/HGET/HMGET), Postgres row (PK =
 * key.toString()), SQLite table, DynamoDB item, in-memory `Map`.
 */
export interface PartitionMap<V> {
  set(key: ColumnKey, value: V): Promise<void>
  get(key: ColumnKey): Promise<V | undefined>
  getAll(keys: ColumnKey[]): Promise<Array<[ColumnKey, V]>>
  has(key: ColumnKey): Promise<boolean>
  delete(key: ColumnKey): Promise<void>
}

/**
 * A sorted set of numeric values per `ColumnKey`.
 *
 * Implementations: Redis sorted set (ZADD/ZREM/ZREVRANGEBYSCORE),
 * Postgres table with an index on (key, value), in-memory sorted array.
 */
export interface SortedSet<V extends number> {
  add(key: ColumnKey, value: V): Promise<void>
  remove(key: ColumnKey, value: V): Promise<void>
  findMax(key: ColumnKey): Promise<V>
}

/**
 * A blob store: opaque string payloads keyed by a flat filepath-like string.
 *
 * Implementations: S3 bucket, local filesystem, Postgres BYTEA, in-memory
 * `Map<string, string>`.
 *
 * The engine only stores strings — base64 encoding of binary source is
 * done inside the Checkpoint DAO, not at this layer.
 */
export interface BlobStore {
  bucket(): string
  partition(): string
  read(path: string): Promise<string>
  has(path: string): Promise<boolean>
  save(path: string, data: string): Promise<void>
  delete(path: string): Promise<void>
}
