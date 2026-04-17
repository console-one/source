# @console-one/source

An event-sourced version-control engine for source text, where mutations are **character-index deltas** — not line diffs, not patches, not Git blobs. Replay is deterministic; the update log is the source of truth; full-text checkpoints are periodic snapshots for fast random-access reads. Designed for collaborative editing on stateless runtimes (Lambda, Workers, etc.).

## What's interesting about it

**Character-index mutations, not line diffs.** A mutation is `{ index: 42, change: 'hello', type: ADDITION | DELETION, timestamp }`. Two users editing different positions in the same file don't conflict. The whole edit history of a document is a list of these tiny records.

**Two-tier storage by design.** The engine writes append-only update records to a fast "hot" store (originally Redis), and periodically compacts them by writing full-text checkpoints to a cheap "cold" store (originally S3). Reading version N finds the most recent checkpoint at or before N and replays the intermediate updates forward. `snapshotFrequency` controls the tradeoff between storage cost (fewer checkpoints) and read latency (more updates to replay).

**Promise-based request deduplication.** N concurrent callers asking for `load(v1)` share one storage round trip — the engine caches the in-flight `Promise<Checkpoint>`, not the resolved value. Critical for Lambda where cold starts cascade and you don't want to thundering-herd Redis.

**Vendor-neutral storage.** The engine operates against four small adapter interfaces (`PartitionMap`, `SortedSet`, `BlobStore`, `ColumnKey`). Back them with Redis + S3, Postgres + BYTEA, SQLite + filesystem, or in-memory (included). The original monorepo was Redis + S3; nothing in the logic required that.

**Claim:** this is a plausible 2022/2023 answer to "how do you do collaborative source editing on serverless?" It's not Git (coarse commits, line diffs, assumes local filesystem). Not Yjs/CRDT (assumes always-connected peers). Not Operational Transform (requires a central server doing OT). It's event sourcing + char-level deltas + hot/cold tiering — a combination shaped by Lambda's constraints specifically.

## Install

```bash
npm install @console-one/source @console-one/multimap heap-js
```

## Quick start

```ts
import {
  Change, Dao, InMemoryBlobStore, InMemoryPartitionMap, InMemorySortedSet,
  Label, LabelChange, Mutation, SourceID, Update
} from '@console-one/source'

// 1. Build adapters — swap these for Redis/S3/Postgres in production
const updateDao = new Dao.Update.Default(
  new InMemoryPartitionMap<Update>(),
  new InMemorySortedSet<number>()
)
const checkpointDao = new Dao.Checkpoint.Default(
  new InMemoryBlobStore(),
  updateDao
)

// 2. Configure the engine. snapshotFrequency=3 → every 3rd save writes a full checkpoint.
const view = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, 3, 20)

// 3. Save a version — the first save for a path must omit priorVersion.
const v1 = new SourceID('example/file.ts', 1)
await view.save({
  newVersion: v1,
  sourceChanges: [new Change(0, 'const a = 1;\n', Mutation.ADDITION, Date.now())],
  labelChanges: [new LabelChange(Date.now(), [Mutation.ADDITION, new Label('author', 'alice')])],
  workspace: 'main'
})

// 4. Save an increment — point priorVersion at the last one.
const v2 = new SourceID('example/file.ts', 2)
await view.save({
  priorVersion: v1,
  newVersion: v2,
  sourceChanges: [new Change(13, 'const b = 2;\n', Mutation.ADDITION, Date.now())],
  labelChanges: [],
  workspace: 'main'
})

// 5. Read back.
const checkpoint = await view.load(v2)
console.log(checkpoint.source)  // 'const a = 1;\nconst b = 2;\n'
console.log(checkpoint.labels)  // [Label { key: 'author', value: 'alice' }]
```

## Public surface

**Versioning primitives**
- `Change` (alias for `SourceChange`) — `{ index, change, type, timestamp }`
- `Mutation` — `ADDITION | DELETION`
- `Label`, `LabelChange` — metadata with same add/delete semantics
- `SourceID` — `{ path, version }` addressing
- `Update` (alias for `SourceUpdate`) — one saved version's update record
- `Checkpoint`, `CheckpointMetadata` — a full-text snapshot
- `Lineage`, `SourceArtifact`, `UpdateType`, `Version`, `SourceCommit`

**Replay engine**
- `Transformations.applyCodeChanges(text, changes, direction)` — replay a mutation log against a source string
- `Transformations.applyLabelChanges(labels, changes, direction)` — same for labels

**DAO layer (engine + interfaces)**
- `Dao.Code.View.Checkpoint` — the event-sourced engine (hot updates, cold checkpoints, promise-based dedup)
- `Dao.Update` — interface + `Default` implementation
- `Dao.Checkpoint` — interface + `Default` implementation
- `CodeChange` — input shape for `.save()`

**Storage-adapter primitives**
- `PartitionMap<V>`, `SortedSet<V>`, `BlobStore` — interfaces the DAOs operate against
- `ColumnKey` — multi-part key type
- `InMemoryPartitionMap`, `InMemorySortedSet`, `InMemoryBlobStore` — reference implementations

## Layout

```
src/
├── index.ts              # Public surface
├── smoke.ts              # End-to-end smoke test
│
├── change.ts             # Mutation enum + SourceChange class
├── label.ts              # Label + LabelChange
├── sourceid.ts           # SourceID (path, version)
├── version.ts            # Version wrapper
├── sourcecommit.ts       # SourceCommit
├── update.ts             # SourceUpdate + Lineage
├── checkpoint.ts         # Checkpoint + CheckpointMetadata
├── transformations.ts    # Pure replay engine
│
├── adapters/
│   ├── types.ts          # PartitionMap, SortedSet, BlobStore, ColumnKey
│   └── memory.ts         # In-memory reference impls
│
└── dao/
    ├── index.ts          # Re-exports
    ├── update.ts         # Update interface + Default (formerly RedisImpl)
    ├── checkpoint.ts     # Checkpoint interface + Default (formerly S3Redis)
    └── code.ts           # Code.View.Checkpoint — the event-sourced engine
```

## What was intentionally dropped during extraction

Source: `console-one-workspace/web-server/server/core/source/` (commit `2962816ed487df0a3c029401b94d7db32fc27ff2`).

### Vendor wiring

- **`Update.RedisImpl.Factory`** — constructed a `RedisImpl` from an `ioredis` client, passing through a Redis-specific `PartitionMapFactory` + `SortedSetFactory` with custom `atob`/`btoa` serializers. All of that lives in the `Generics.Awaited.Redis` layer. Dropped. Users who want Redis implement the four adapter interfaces directly — a ~100-line exercise, with the in-memory reference adapters in `adapters/memory.ts` as a template.
- **`Checkpoint.S3Redis`'s S3-specific wiring** — the class itself (renamed `Default`) ships, but it originally took an `S3Dao` interface that used a bucket/partition-addressed object store wrapper. That interface is now just `BlobStore`, and any blob-capable storage works.
- **`__load` functions** on all three DAO classes — DI registry glue (`Resources.Registry.Builder.create().ensure(...).set(...)`). The pattern was: each DAO published itself into a global registry at startup, and callers `await load('updateDao')` to get it. Ripped out entirely; callers wire DAOs via constructor now.

### Convention layers that aren't fundamental

- **`pushUpdateLabels`** (from `src/core/data/source`) — a pre-save hook that auto-added a `created_at` label on every source change. Dropped; that's a caller-level convention, not an engine concern.
- **`fresh.ts`** — helper that built an initial `CodeChange` from a `core/deployment.Context`. Pulled in the deployment framework as a type. Drop; calling `.save({ newVersion, sourceChanges: [...], labelChanges: [...], workspace })` directly is not much more code.
- **`templates/index.ts`** — loaded starter files from `./core/source/templates/starter/` via `fs.promises`. Console One-specific.
- **`logger`** / `logger.debug` calls — routed to the monorepo's `GlobalLogger` singleton that pulled in `aws-sdk` for CloudWatch on Lambda. Removed; the engine runs silent.

### Test fixtures and harness

- `__/__change.ts`, `__/__labels.ts`, `__/__checkpoint.ts`, `__/__update.ts`, `__/__index.ts` — fixture data for the old test suite. Cases ported into `smoke.ts` inline.
- `dao/__/*`, `dao/tests/*`, `tests/*` — the custom validator-based test harness. Not portable. The relevant assertions are in `smoke.ts`.

## Renamed during extraction

- `Update.RedisImpl` → `Update.Default` (matching the existing `// TODO - Change this implementation class name from 'RedisImpl' to Default since there is nothing redis specific outside its instance vars.` in the source)
- `Checkpoint.S3Redis` → `Checkpoint.Default` (same rationale)
- `S3Dao` interface → `BlobStore` interface (renamed for vendor neutrality; shape unchanged)
- `Generics.Awaited.PartitionMap<V>` → `PartitionMap<V>` (in `adapters/types.ts`)
- `Generics.Awaited.SortedSet<V>` → `SortedSet<V>` (same)
- `Generics.Table.Columns.Default` → `ColumnKey` (same shape: multi-part key with `.from()` + `.extend()`)

## Known limitations (carried over from source, not fixed)

- **`Transformations.applyCodeChanges` with `direction: 'BACKWARD'` is broken.** The algorithm treats change indices as referencing the text being operated on, but the indices are positions in the ORIGINAL text. Forward replay works because each change resolves against the pre-mutation state. Backward replay would need to compute the mutated-text position for each change (which depends on all prior additions/deletions), and that isn't done. The source repo's tests (`tests/transformations.ts`) only ever exercised `FORWARD`, so this was shipped-untested. Fixing requires either (a) a position-mapping pre-pass, or (b) an index-tracking replay that walks the log in reverse. Out of extraction scope. Forward-only replay is still the "killer" property — reversibility is a nice-to-have.
- **`addToWorkspaceCommit`** is a partial implementation. It finds the max version in a workspace's sorted set but the `// TODO: add labels to checkpoint` comment marks work that was never completed. Left as-is with its TODO.

## Smoke test

```bash
npm install
npm run build
npm run smoke
```

Asserts five end-to-end paths:

1. **Forward replay of character mutations** — adds/deletes at overlapping indices produce the expected output text.
2. **Determinism** — applying the same mutation log twice gives the same result.
3. **Label merge** — additions, deletions, and updates of a key all honor timestamp ordering.
4. **Full save / load roundtrip** through `InMemory{PartitionMap,SortedSet,BlobStore}`, including a mid-sequence checkpoint (snapshotFrequency=3, three saves).
5. **Promise-based dedup** — three concurrent `view.load(v1)` calls share the same resolved `Promise<Checkpoint>` and trigger at most 2 underlying DAO round trips.

## Origin

Source: `console-one-workspace/web-server/server/core/source/` at commit `2962816ed487df0a3c029401b94d7db32fc27ff2`. Associated source doc: `source-why.md` in the Console One docs.

## License

MIT
