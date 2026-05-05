// Core types — versioning primitives
export { Mutation, SourceChange as Change } from './change.js'
export { Checkpoint, CheckpointMetadata } from './checkpoint.js'
export { SourceID } from './sourceid.js'
export { SourceUpdate as Update, UpdateType } from './update.js'
export type { Lineage, SourceArtifact } from './update.js'
export { Label, LabelChange } from './label.js'
export { Version } from './version.js'
export { SourceCommit } from './sourcecommit.js'

// Content-type seam (generic engine) + text specialization
export { TextCodec } from './codec.js'
export type { ContentCodec } from './codec.js'

// Replay engine (text-only utility — wrapped by TextCodec)
export { Transformations } from './transformations.js'
export type { Direction } from './transformations.js'

// DAO layer (engine + adapter interfaces)
export * as Dao from './dao/index.js'
export type { CodeChange } from './dao/code.js'

// Storage-adapter primitives (what the DAOs operate against)
export { ColumnKey } from './adapters/types.js'
export type { PartitionMap, SortedSet, BlobStore } from './adapters/types.js'

// In-memory reference adapter impls (for tests + examples)
export {
  InMemoryPartitionMap,
  InMemorySortedSet,
  InMemoryBlobStore
} from './adapters/memory.js'

// Filesystem-backed adapters (durable across restarts; no external dep)
export {
  FilesystemPartitionMap,
  FilesystemSortedSet,
  FilesystemBlobStore
} from './adapters/filesystem.js'

// SQLite-backed adapters (consumer provides Database; better-sqlite3 / node:sqlite both work)
export {
  SqlitePartitionMap,
  SqliteSortedSet,
  SqliteBlobStore,
  ensureSqliteSchema
} from './adapters/sqlite.js'
export type { SqliteDatabaseLike, SqliteStatementLike } from './adapters/sqlite.js'

// Directed graph store — sibling primitive to BlobStore/PartitionMap/SortedSet.
// Answers "what's connected to this address" rather than "what's the state at this address."
// Used by artifact framework for providers/consumers, dependency edges, reachability.
export {
  InMemoryDirectedGraphStore,
  SqliteDirectedGraphStore,
  ensureGraphSchema
} from './adapters/graph.js'
export type { DirectedGraphStore, DirectedEdge } from './adapters/graph.js'

// SystemLogger — typed log-event stream. Same patch+subscribe shape as
// the rest of the package; production hosts wire subscribers to forward
// log events to a Source-backed log process.
export {
  log,
  DefaultSystemLogger,
  setSystemLogger,
  getSystemLogger,
} from './logger.js'
export type { SystemLogger, LogLevel, LogEvent } from './logger.js'
