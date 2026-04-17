// Core types — versioning primitives
export { Mutation, SourceChange as Change } from './change.js'
export { Checkpoint, CheckpointMetadata } from './checkpoint.js'
export { SourceID } from './sourceid.js'
export { SourceUpdate as Update, UpdateType } from './update.js'
export type { Lineage, SourceArtifact } from './update.js'
export { Label, LabelChange } from './label.js'
export { Version } from './version.js'
export { SourceCommit } from './sourcecommit.js'

// Replay engine
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
