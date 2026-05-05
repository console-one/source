/**
 * DirectedGraphStore — adapter for graph-shaped queries.
 *
 * Sibling primitive to BlobStore / PartitionMap / SortedSet. The other
 * three answer "what's the state at this address." This one answers
 * "what's CONNECTED to this address" — outgoing/incoming/traversal.
 *
 * Use cases this enables:
 *   - artifact's `getProviders` / `getConsumers` (outgoing/incoming edges)
 *   - dependency graphs across kits/blueprints
 *   - reachability queries for scoping (e.g. find all sessions a user owns)
 *   - any "what depends on this" or "what does this depend on" question
 *
 * Two implementations ship here:
 *   - `InMemoryDirectedGraphStore` for tests and dev (Map-based)
 *   - `SqliteDirectedGraphStore` against `SqliteDatabaseLike` for durable storage
 *
 * Direction is a primary concern: from/to are asymmetric. An edge added
 * `(A → B, "dependsOn")` is found via `outgoing(A)` and `incoming(B)`, NOT
 * via `outgoing(B)` or `incoming(A)`. Use `removeNode` to clean up all
 * edges touching a node when it's deleted (otherwise dangling edges
 * accumulate).
 */
import type { SqliteDatabaseLike, SqliteStatementLike } from "./sqlite.js";

export type DirectedEdge<NodeID = string, EdgeData = unknown> = {
  readonly from: NodeID;
  readonly to: NodeID;
  readonly edgeType: string;
  readonly data?: EdgeData;
};

export interface DirectedGraphStore<NodeID = string, EdgeData = unknown> {
  /** Idempotent: adding the same (from, to, edgeType) twice is a no-op. */
  addEdge(
    from: NodeID,
    to: NodeID,
    edgeType: string,
    data?: EdgeData,
  ): Promise<void>;

  /** Remove a specific edge. No-op if not present. */
  removeEdge(from: NodeID, to: NodeID, edgeType: string): Promise<void>;

  /** Outgoing edges from `from`, optionally filtered by edge type. */
  outgoing(
    from: NodeID,
    edgeType?: string,
  ): Promise<DirectedEdge<NodeID, EdgeData>[]>;

  /** Incoming edges to `to`, optionally filtered by edge type. */
  incoming(
    to: NodeID,
    edgeType?: string,
  ): Promise<DirectedEdge<NodeID, EdgeData>[]>;

  /**
   * Walk outgoing edges from `from` to depth N. Returns all edges
   * encountered during traversal (the path edges, not just terminal nodes).
   * Cycle-safe: each (from, to, edgeType) appears at most once.
   */
  traverse(
    from: NodeID,
    opts: { depth: number; edgeType?: string },
  ): Promise<DirectedEdge<NodeID, EdgeData>[]>;

  /** True iff the specific directed edge exists. */
  hasEdge(from: NodeID, to: NodeID, edgeType: string): Promise<boolean>;

  /**
   * Remove ALL edges touching `nodeID` (both as source and target).
   * Use when deleting a node to keep the graph clean.
   */
  removeNode(nodeID: NodeID): Promise<void>;
}

// ─── In-memory implementation ─────────────────────────────────────────────

type EdgeKey = string; // `${from}\x00${to}\x00${edgeType}`

function edgeKey(from: unknown, to: unknown, edgeType: string): EdgeKey {
  return `${String(from)}\x00${String(to)}\x00${edgeType}`;
}

export class InMemoryDirectedGraphStore<NodeID = string, EdgeData = unknown>
  implements DirectedGraphStore<NodeID, EdgeData>
{
  // Single source of truth: the edge set.
  private edges = new Map<EdgeKey, DirectedEdge<NodeID, EdgeData>>();
  // Inverse indexes for fast lookup.
  private byFrom = new Map<string, Set<EdgeKey>>(); // String(from) → keys
  private byTo = new Map<string, Set<EdgeKey>>(); // String(to)   → keys

  async addEdge(
    from: NodeID,
    to: NodeID,
    edgeType: string,
    data?: EdgeData,
  ): Promise<void> {
    const k = edgeKey(from, to, edgeType);
    if (this.edges.has(k)) return; // idempotent
    const edge: DirectedEdge<NodeID, EdgeData> = { from, to, edgeType };
    if (data !== undefined) (edge as any).data = data;
    this.edges.set(k, edge);
    const fromKey = String(from);
    const toKey = String(to);
    if (!this.byFrom.has(fromKey)) this.byFrom.set(fromKey, new Set());
    if (!this.byTo.has(toKey)) this.byTo.set(toKey, new Set());
    this.byFrom.get(fromKey)!.add(k);
    this.byTo.get(toKey)!.add(k);
  }

  async removeEdge(
    from: NodeID,
    to: NodeID,
    edgeType: string,
  ): Promise<void> {
    const k = edgeKey(from, to, edgeType);
    if (!this.edges.has(k)) return;
    this.edges.delete(k);
    this.byFrom.get(String(from))?.delete(k);
    this.byTo.get(String(to))?.delete(k);
  }

  async outgoing(
    from: NodeID,
    edgeType?: string,
  ): Promise<DirectedEdge<NodeID, EdgeData>[]> {
    const keys = this.byFrom.get(String(from));
    if (!keys) return [];
    const out: DirectedEdge<NodeID, EdgeData>[] = [];
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e) continue;
      if (edgeType !== undefined && e.edgeType !== edgeType) continue;
      out.push(e);
    }
    return out;
  }

  async incoming(
    to: NodeID,
    edgeType?: string,
  ): Promise<DirectedEdge<NodeID, EdgeData>[]> {
    const keys = this.byTo.get(String(to));
    if (!keys) return [];
    const out: DirectedEdge<NodeID, EdgeData>[] = [];
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e) continue;
      if (edgeType !== undefined && e.edgeType !== edgeType) continue;
      out.push(e);
    }
    return out;
  }

  async traverse(
    from: NodeID,
    opts: { depth: number; edgeType?: string },
  ): Promise<DirectedEdge<NodeID, EdgeData>[]> {
    const visitedEdges = new Set<EdgeKey>();
    const result: DirectedEdge<NodeID, EdgeData>[] = [];
    const queue: Array<{ node: NodeID; depth: number }> = [{ node: from, depth: 0 }];
    const visitedNodes = new Set<string>([String(from)]);

    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;
      if (depth >= opts.depth) continue;
      const outs = await this.outgoing(node, opts.edgeType);
      for (const e of outs) {
        const k = edgeKey(e.from, e.to, e.edgeType);
        if (visitedEdges.has(k)) continue;
        visitedEdges.add(k);
        result.push(e);
        const toKey = String(e.to);
        if (!visitedNodes.has(toKey)) {
          visitedNodes.add(toKey);
          queue.push({ node: e.to, depth: depth + 1 });
        }
      }
    }
    return result;
  }

  async hasEdge(
    from: NodeID,
    to: NodeID,
    edgeType: string,
  ): Promise<boolean> {
    return this.edges.has(edgeKey(from, to, edgeType));
  }

  async removeNode(nodeID: NodeID): Promise<void> {
    const k = String(nodeID);
    const outKeys = Array.from(this.byFrom.get(k) ?? []);
    const inKeys = Array.from(this.byTo.get(k) ?? []);
    for (const ek of outKeys) {
      const e = this.edges.get(ek);
      if (e) {
        this.edges.delete(ek);
        this.byTo.get(String(e.to))?.delete(ek);
      }
    }
    for (const ek of inKeys) {
      const e = this.edges.get(ek);
      if (e) {
        this.edges.delete(ek);
        this.byFrom.get(String(e.from))?.delete(ek);
      }
    }
    this.byFrom.delete(k);
    this.byTo.delete(k);
  }
}

// ─── SQLite implementation ────────────────────────────────────────────────

export function ensureGraphSchema(db: SqliteDatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_edges (
      scope     TEXT NOT NULL,
      from_node TEXT NOT NULL,
      to_node   TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      data_json TEXT,
      PRIMARY KEY (scope, from_node, to_node, edge_type)
    );

    CREATE INDEX IF NOT EXISTS graph_edges_from_idx
      ON graph_edges(scope, from_node, edge_type);

    CREATE INDEX IF NOT EXISTS graph_edges_to_idx
      ON graph_edges(scope, to_node, edge_type);
  `);
}

export class SqliteDirectedGraphStore<NodeID = string, EdgeData = unknown>
  implements DirectedGraphStore<NodeID, EdgeData>
{
  private addStmt: SqliteStatementLike;
  private removeStmt: SqliteStatementLike;
  private outgoingAllStmt: SqliteStatementLike;
  private outgoingTypedStmt: SqliteStatementLike;
  private incomingAllStmt: SqliteStatementLike;
  private incomingTypedStmt: SqliteStatementLike;
  private hasStmt: SqliteStatementLike;
  private removeNodeStmt: SqliteStatementLike;

  constructor(db: SqliteDatabaseLike, private scope: string) {
    ensureGraphSchema(db);
    this.addStmt = db.prepare(
      `INSERT OR IGNORE INTO graph_edges(scope, from_node, to_node, edge_type, data_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.removeStmt = db.prepare(
      `DELETE FROM graph_edges
       WHERE scope = ? AND from_node = ? AND to_node = ? AND edge_type = ?`,
    );
    this.outgoingAllStmt = db.prepare(
      `SELECT from_node, to_node, edge_type, data_json
       FROM graph_edges WHERE scope = ? AND from_node = ?`,
    );
    this.outgoingTypedStmt = db.prepare(
      `SELECT from_node, to_node, edge_type, data_json
       FROM graph_edges WHERE scope = ? AND from_node = ? AND edge_type = ?`,
    );
    this.incomingAllStmt = db.prepare(
      `SELECT from_node, to_node, edge_type, data_json
       FROM graph_edges WHERE scope = ? AND to_node = ?`,
    );
    this.incomingTypedStmt = db.prepare(
      `SELECT from_node, to_node, edge_type, data_json
       FROM graph_edges WHERE scope = ? AND to_node = ? AND edge_type = ?`,
    );
    this.hasStmt = db.prepare(
      `SELECT 1 FROM graph_edges
       WHERE scope = ? AND from_node = ? AND to_node = ? AND edge_type = ?
       LIMIT 1`,
    );
    this.removeNodeStmt = db.prepare(
      `DELETE FROM graph_edges
       WHERE scope = ? AND (from_node = ? OR to_node = ?)`,
    );
  }

  private rowToEdge(row: any): DirectedEdge<NodeID, EdgeData> {
    const edge: any = {
      from: row.from_node,
      to: row.to_node,
      edgeType: row.edge_type,
    };
    if (row.data_json !== null && row.data_json !== undefined) {
      edge.data = JSON.parse(row.data_json);
    }
    return edge as DirectedEdge<NodeID, EdgeData>;
  }

  async addEdge(
    from: NodeID,
    to: NodeID,
    edgeType: string,
    data?: EdgeData,
  ): Promise<void> {
    this.addStmt.run(
      this.scope,
      String(from),
      String(to),
      edgeType,
      data === undefined ? null : JSON.stringify(data),
    );
  }

  async removeEdge(
    from: NodeID,
    to: NodeID,
    edgeType: string,
  ): Promise<void> {
    this.removeStmt.run(this.scope, String(from), String(to), edgeType);
  }

  async outgoing(
    from: NodeID,
    edgeType?: string,
  ): Promise<DirectedEdge<NodeID, EdgeData>[]> {
    const rows = (
      edgeType === undefined
        ? this.outgoingAllStmt.all(this.scope, String(from))
        : this.outgoingTypedStmt.all(this.scope, String(from), edgeType)
    ) as any[];
    return rows.map((r) => this.rowToEdge(r));
  }

  async incoming(
    to: NodeID,
    edgeType?: string,
  ): Promise<DirectedEdge<NodeID, EdgeData>[]> {
    const rows = (
      edgeType === undefined
        ? this.incomingAllStmt.all(this.scope, String(to))
        : this.incomingTypedStmt.all(this.scope, String(to), edgeType)
    ) as any[];
    return rows.map((r) => this.rowToEdge(r));
  }

  async traverse(
    from: NodeID,
    opts: { depth: number; edgeType?: string },
  ): Promise<DirectedEdge<NodeID, EdgeData>[]> {
    // BFS layered by depth. Could be a recursive CTE; for simplicity
    // iterate with the prepared outgoing stmts.
    const visitedEdges = new Set<string>();
    const result: DirectedEdge<NodeID, EdgeData>[] = [];
    const queue: Array<{ node: NodeID; depth: number }> = [{ node: from, depth: 0 }];
    const visitedNodes = new Set<string>([String(from)]);

    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;
      if (depth >= opts.depth) continue;
      const outs = await this.outgoing(node, opts.edgeType);
      for (const e of outs) {
        const k = `${String(e.from)}\x00${String(e.to)}\x00${e.edgeType}`;
        if (visitedEdges.has(k)) continue;
        visitedEdges.add(k);
        result.push(e);
        const toKey = String(e.to);
        if (!visitedNodes.has(toKey)) {
          visitedNodes.add(toKey);
          queue.push({ node: e.to, depth: depth + 1 });
        }
      }
    }
    return result;
  }

  async hasEdge(
    from: NodeID,
    to: NodeID,
    edgeType: string,
  ): Promise<boolean> {
    return (
      this.hasStmt.get(this.scope, String(from), String(to), edgeType) !==
      undefined
    );
  }

  async removeNode(nodeID: NodeID): Promise<void> {
    const k = String(nodeID);
    this.removeNodeStmt.run(this.scope, k, k);
  }
}
