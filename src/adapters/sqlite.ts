/**
 * SQLite-backed implementations of the storage-adapter primitives.
 *
 * The package itself does NOT depend on `better-sqlite3` (or any other
 * SQLite binding) — that would force every consumer to build native
 * code. Instead, the adapter accepts a `SqliteDatabaseLike` interface,
 * and consumers pass in their own DB instance. `better-sqlite3` already
 * conforms; `node:sqlite` (Node 22+) conforms; sql.js with a thin shim
 * conforms.
 *
 * Layout — three tables, all with PK on `(scope, key)`:
 *
 *   blobs(scope TEXT, key TEXT, data TEXT)
 *   partitions(scope TEXT, key TEXT, value TEXT)
 *   sortedsets(scope TEXT, key TEXT, value INTEGER)   -- composite PK includes value
 *
 * `scope` is a per-adapter identifier so multiple adapters can share
 * one DB connection without collision.
 */
import { ColumnKey, type PartitionMap, type SortedSet, type BlobStore } from "./types.js";

// ── Minimal SQLite interface ──────────────────────────────────────────────
//
// What better-sqlite3 / node:sqlite / sql.js (shimmed) all expose. The
// adapter only uses these methods.

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): unknown;
}

export interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ── Schema setup ──────────────────────────────────────────────────────────

export function ensureSqliteSchema(db: SqliteDatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      scope TEXT NOT NULL,
      key   TEXT NOT NULL,
      data  TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );

    CREATE TABLE IF NOT EXISTS partitions (
      scope TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );

    CREATE TABLE IF NOT EXISTS sortedsets (
      scope TEXT    NOT NULL,
      key   TEXT    NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (scope, key, value)
    );

    CREATE INDEX IF NOT EXISTS sortedsets_max_idx
      ON sortedsets(scope, key, value DESC);
  `);
}

// ── Adapters ──────────────────────────────────────────────────────────────

/**
 * Optional (de)serializer pair. See `filesystem.ts` for context — required
 * when V contains class instances that lose identity through plain JSON
 * (e.g., `SourceUpdate` with `SourceID` instances in its lineage).
 */
export type ValueSerializer<V> = {
  serialize(value: V): string;
  deserialize(raw: string): V;
};

const defaultSerializer: ValueSerializer<unknown> = {
  serialize: (v) => JSON.stringify(v),
  deserialize: (raw) => JSON.parse(raw),
};

export class SqlitePartitionMap<V> implements PartitionMap<V> {
  private setStmt: SqliteStatementLike;
  private getStmt: SqliteStatementLike;
  private hasStmt: SqliteStatementLike;
  private deleteStmt: SqliteStatementLike;
  private listAllStmt: SqliteStatementLike;
  private listPrefixStmt: SqliteStatementLike;
  private serializer: ValueSerializer<V>;

  constructor(
    db: SqliteDatabaseLike,
    private scope: string,
    serializer?: ValueSerializer<V>,
  ) {
    ensureSqliteSchema(db);
    this.serializer = serializer ?? (defaultSerializer as ValueSerializer<V>);
    this.setStmt = db.prepare(
      `INSERT INTO partitions(scope, key, value) VALUES (?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    );
    this.getStmt = db.prepare(
      `SELECT value FROM partitions WHERE scope = ? AND key = ?`,
    );
    this.hasStmt = db.prepare(
      `SELECT 1 FROM partitions WHERE scope = ? AND key = ? LIMIT 1`,
    );
    this.deleteStmt = db.prepare(
      `DELETE FROM partitions WHERE scope = ? AND key = ?`,
    );
    this.listAllStmt = db.prepare(
      `SELECT key FROM partitions WHERE scope = ?`,
    );
    this.listPrefixStmt = db.prepare(
      `SELECT key FROM partitions WHERE scope = ? AND key LIKE ?`,
    );
  }

  async set(key: ColumnKey, value: V): Promise<void> {
    this.setStmt.run(this.scope, key.toString(), this.serializer.serialize(value));
  }

  async get(key: ColumnKey): Promise<V | undefined> {
    const row = this.getStmt.get(this.scope, key.toString()) as
      | { value: string }
      | undefined;
    if (row === undefined) return undefined;
    return this.serializer.deserialize(row.value);
  }

  async getAll(keys: ColumnKey[]): Promise<Array<[ColumnKey, V]>> {
    const out: Array<[ColumnKey, V]> = [];
    for (const key of keys) {
      const v = await this.get(key);
      if (v !== undefined) out.push([key, v]);
    }
    return out;
  }

  async has(key: ColumnKey): Promise<boolean> {
    return this.hasStmt.get(this.scope, key.toString()) !== undefined;
  }

  async delete(key: ColumnKey): Promise<void> {
    this.deleteStmt.run(this.scope, key.toString());
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const rows =
      prefix === undefined
        ? (this.listAllStmt.all(this.scope) as Array<{ key: string }>)
        : (this.listPrefixStmt.all(
            this.scope,
            // Escape SQL LIKE wildcards in the prefix, then append %.
            prefix.replace(/[\\%_]/g, "\\$&") + "%",
          ) as Array<{ key: string }>);
    return rows.map((r) => r.key);
  }
}

export class SqliteSortedSet<V extends number> implements SortedSet<V> {
  private addStmt: SqliteStatementLike;
  private removeStmt: SqliteStatementLike;
  private maxStmt: SqliteStatementLike;

  constructor(db: SqliteDatabaseLike, private scope: string) {
    ensureSqliteSchema(db);
    this.addStmt = db.prepare(
      `INSERT OR IGNORE INTO sortedsets(scope, key, value) VALUES (?, ?, ?)`,
    );
    this.removeStmt = db.prepare(
      `DELETE FROM sortedsets WHERE scope = ? AND key = ? AND value = ?`,
    );
    this.maxStmt = db.prepare(
      `SELECT value FROM sortedsets WHERE scope = ? AND key = ? ORDER BY value DESC LIMIT 1`,
    );
  }

  async add(key: ColumnKey, value: V): Promise<void> {
    this.addStmt.run(this.scope, key.toString(), value);
  }

  async remove(key: ColumnKey, value: V): Promise<void> {
    this.removeStmt.run(this.scope, key.toString(), value);
  }

  async findMax(key: ColumnKey): Promise<V> {
    const row = this.maxStmt.get(this.scope, key.toString()) as
      | { value: number }
      | undefined;
    if (row === undefined) {
      throw new Error(`No values in sorted set for key ${key.toString()}`);
    }
    return row.value as V;
  }
}

export class SqliteBlobStore implements BlobStore {
  private readStmt: SqliteStatementLike;
  private hasStmt: SqliteStatementLike;
  private saveStmt: SqliteStatementLike;
  private deleteStmt: SqliteStatementLike;

  constructor(
    db: SqliteDatabaseLike,
    private scope: string,
    private bucketName: string = "sqlite",
    private partitionName: string = "default",
  ) {
    ensureSqliteSchema(db);
    this.readStmt = db.prepare(
      `SELECT data FROM blobs WHERE scope = ? AND key = ?`,
    );
    this.hasStmt = db.prepare(
      `SELECT 1 FROM blobs WHERE scope = ? AND key = ? LIMIT 1`,
    );
    this.saveStmt = db.prepare(
      `INSERT INTO blobs(scope, key, data) VALUES (?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET data = excluded.data`,
    );
    this.deleteStmt = db.prepare(
      `DELETE FROM blobs WHERE scope = ? AND key = ?`,
    );
  }

  bucket(): string {
    return this.bucketName;
  }

  partition(): string {
    return this.partitionName;
  }

  async read(path: string): Promise<string> {
    const row = this.readStmt.get(this.scope, path) as
      | { data: string }
      | undefined;
    if (row === undefined) throw new Error(`BlobStore: no blob at ${path}`);
    return row.data;
  }

  async has(path: string): Promise<boolean> {
    return this.hasStmt.get(this.scope, path) !== undefined;
  }

  async save(path: string, data: string): Promise<void> {
    this.saveStmt.run(this.scope, path, data);
  }

  async delete(path: string): Promise<void> {
    this.deleteStmt.run(this.scope, path);
  }
}
