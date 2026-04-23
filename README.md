# @console-one/source

An event-sourced version-control engine **generic over content type**. Every save is a list of patches plus label metadata; every Nth save is a full-content checkpoint. Replay is deterministic, the update log is the source of truth, checkpoints are periodic snapshots for fast random-access reads. Ships with a `TextCodec` for character-index deltas over strings, but any `T` with a `ContentCodec<T, Patch>` works — JSON objects, Sets, whatever you can replay. Designed for collaborative editing on stateless runtimes (Lambda, Workers, etc.).

## What's interesting about it

**Content-type-agnostic engine.** The hot/cold tiering, lineage walk, and promise-dedup cache don't know what a "content" is — that's supplied by a `ContentCodec<TContent, TPatch>` with five operations (`empty`, `applyPatches`, `serialize`, `deserialize`, `patchToJSON`/`patchFromJSON`). The text path is just one codec; pair it with any patchkit `DataType` (or your own) and you get versioned objects, sets, arrays, counters, whatever.

**Character-index text mutations (via TextCodec).** A text patch is `{ index: 42, change: 'hello', type: ADDITION | DELETION, timestamp }`. Two users editing different positions in the same file don't conflict. The whole edit history of a document is a list of these tiny records.

**Two-tier storage by design.** The engine writes append-only update records to a fast "hot" store (originally Redis), and periodically compacts them by writing full-content checkpoints to a cheap "cold" store (originally S3). Reading version N finds the most recent checkpoint at or before N and replays the intermediate updates forward. `snapshotFrequency` controls the tradeoff between storage cost (fewer checkpoints) and read latency (more updates to replay).

**Promise-based request deduplication.** N concurrent callers asking for `load(v1)` share one storage round trip — the engine caches the in-flight `Promise<Checkpoint>`, not the resolved value. Critical for Lambda where cold starts cascade and you don't want to thundering-herd Redis.

**Vendor-neutral storage.** The engine operates against four small adapter interfaces (`PartitionMap`, `SortedSet`, `BlobStore`, `ColumnKey`). Back them with Redis + S3, Postgres + BYTEA, SQLite + filesystem, or in-memory (included). The original monorepo was Redis + S3; nothing in the logic required that.

**Claim:** this is a plausible 2022/2023 answer to "how do you do collaborative source editing on serverless?" It's not Git (coarse commits, line diffs, assumes local filesystem). Not Yjs/CRDT (assumes always-connected peers). Not Operational Transform (requires a central server doing OT). It's event sourcing + replayable patches + hot/cold tiering — a combination shaped by Lambda's constraints specifically, generalized to anything you can replay.

## Install

```bash
npm install @console-one/source @console-one/multimap heap-js
```

## Quick start — text

```ts
import {
  Change, Dao, InMemoryBlobStore, InMemoryPartitionMap, InMemorySortedSet,
  Label, LabelChange, Mutation, SourceID, TextCodec, Update
} from '@console-one/source'

// 1. Build adapters — swap these for Redis/S3/Postgres in production
const updateDao = new Dao.Update.Default<Change>(
  new InMemoryPartitionMap<Update<Change>>(),
  new InMemorySortedSet<number>()
)
const checkpointDao = new Dao.Checkpoint.Default<string, Change>(
  new InMemoryBlobStore(),
  updateDao,
  TextCodec
)

// 2. Configure the engine. snapshotFrequency=3 → every 3rd save writes a full checkpoint.
const view = new Dao.Code.View.Checkpoint<string, Change>(
  checkpointDao, updateDao, TextCodec, 3, 20
)

// 3. Save a version — the first save for a path must omit priorVersion.
const v1 = new SourceID('example/file.ts', 1)
await view.save({
  newVersion: v1,
  patches: [new Change(0, 'const a = 1;\n', Mutation.ADDITION, Date.now())],
  labelChanges: [new LabelChange(Date.now(), [Mutation.ADDITION, new Label('author', 'alice')])],
  workspace: 'main'
})

// 4. Save an increment — point priorVersion at the last one.
const v2 = new SourceID('example/file.ts', 2)
await view.save({
  priorVersion: v1,
  newVersion: v2,
  patches: [new Change(13, 'const b = 2;\n', Mutation.ADDITION, Date.now())],
  labelChanges: [],
  workspace: 'main'
})

// 5. Read back.
const checkpoint = await view.load(v2)
console.log(checkpoint.content)  // 'const a = 1;\nconst b = 2;\n'
console.log(checkpoint.labels)   // [Label { key: 'author', value: 'alice' }]
```

## Quick start — any content type

The same engine, driven by your own codec. Here a shallow JSON object versioned via set/delete patches:

```ts
import { ContentCodec, Dao, InMemoryBlobStore, InMemoryPartitionMap, InMemorySortedSet, SourceID, Update } from '@console-one/source'

type ObjPatch = { op: 'set', key: string, value: unknown } | { op: 'delete', key: string }
type ObjState = Record<string, unknown>

const ObjectCodec: ContentCodec<ObjState, ObjPatch> = {
  empty: () => ({}),
  applyPatches: (s, ps) => {
    const next = { ...s }
    for (const p of ps) p.op === 'set' ? (next[p.key] = p.value) : delete next[p.key]
    return next
  },
  serialize: s => JSON.stringify(s),
  deserialize: raw => JSON.parse(raw),
  patchToJSON: p => p,
  patchFromJSON: raw => raw as ObjPatch,
}

const updateDao = new Dao.Update.Default<ObjPatch>(
  new InMemoryPartitionMap<Update<ObjPatch>>(),
  new InMemorySortedSet<number>(),
)
const checkpointDao = new Dao.Checkpoint.Default<ObjState, ObjPatch>(
  new InMemoryBlobStore(), updateDao, ObjectCodec,
)
const view = new Dao.Code.View.Checkpoint<ObjState, ObjPatch>(
  checkpointDao, updateDao, ObjectCodec, 3, 20,
)

await view.save({
  newVersion: new SourceID('cells/user-profile', 1),
  patches: [{ op: 'set', key: 'name', value: 'Andrew' }],
  labelChanges: [],
  workspace: 'main',
})
```

See `@console-one/patchkit` for ready-made `DataType`s (Object / Array / Set / Number) you can wrap in a codec, and `@console-one/cell` for a glued composition that also adds namespace-based addressing on top.

## Public surface

**Versioning primitives**
- `Change` (alias for `SourceChange`) — text patch: `{ index, change, type, timestamp }`
- `Mutation` — `ADDITION | DELETION`
- `Label`, `LabelChange` — metadata with same add/delete semantics
- `SourceID` — `{ path, version }` addressing
- `Update<TPatch>` (alias for `SourceUpdate<TPatch>`) — one saved version's update record
- `Checkpoint<TContent>`, `CheckpointMetadata` — full snapshot at a version
- `Lineage`, `SourceArtifact`, `UpdateType`, `Version`, `SourceCommit`

**Content-type seam**
- `ContentCodec<TContent, TPatch>` — the five-operation interface the engine uses to replay any `TContent` via any `TPatch`
- `TextCodec` — the default specialization for `(string, Change)`; uses `Transformations.applyCodeChanges` internally

**Replay engine (text-specific utility, used by TextCodec)**
- `Transformations.applyCodeChanges(text, changes, direction)` — replay a mutation log against a source string
- `Transformations.applyLabelChanges(labels, changes, direction)` — same for labels

**DAO layer (engine + interfaces)**
- `Dao.Code.View.Checkpoint<TContent, TPatch>` — the event-sourced engine (hot updates, cold checkpoints, promise-based dedup)
- `Dao.Update<TPatch>` — interface + `Default` implementation
- `Dao.Checkpoint<TContent>` — interface + `Default` implementation
- `CodeChange<TPatch>` — input shape for `.save()`

**Storage-adapter primitives**
- `PartitionMap<V>`, `SortedSet<V>`, `BlobStore` — interfaces the DAOs operate against
- `ColumnKey` — multi-part key type
- `InMemoryPartitionMap`, `InMemorySortedSet`, `InMemoryBlobStore` — reference implementations

## Layout

```
src/
├── index.ts              # Public surface
├── smoke.ts              # End-to-end smoke test (text + non-text)
│
├── change.ts             # Mutation enum + SourceChange class (text patch)
├── codec.ts              # ContentCodec<T, P> interface + TextCodec default
├── label.ts              # Label + LabelChange
├── sourceid.ts           # SourceID (path, version)
├── version.ts            # Version wrapper
├── sourcecommit.ts       # SourceCommit
├── update.ts             # SourceUpdate<TPatch> + Lineage
├── checkpoint.ts         # Checkpoint<TContent> + CheckpointMetadata
├── transformations.ts    # Text-specific replay (used by TextCodec)
│
├── adapters/
│   ├── types.ts          # PartitionMap, SortedSet, BlobStore, ColumnKey
│   └── memory.ts         # In-memory reference impls
│
└── dao/
    ├── index.ts          # Re-exports
    ├── update.ts         # Update<TPatch> interface + Default
    ├── checkpoint.ts     # Checkpoint<TContent> interface + Default (takes codec)
    └── code.ts           # Code.View.Checkpoint<T, P> — the event-sourced engine
```

## Known limitations

- **`Transformations.applyCodeChanges` with `direction: 'BACKWARD'` is broken.** The algorithm treats change indices as referencing the text being operated on, but the indices are positions in the ORIGINAL text. Forward replay works because each change resolves against the pre-mutation state. Backward replay would need to compute the mutated-text position for each change (which depends on all prior additions/deletions), and that isn't done. A proper fix requires either (a) a position-mapping pre-pass, or (b) an index-tracking replay that walks the log in reverse. Forward-only replay is the supported path.
- **`addToWorkspaceCommit`** is a partial implementation. It finds the max version in a workspace's sorted set but the `// TODO: add labels to checkpoint` comment marks work that was never completed. Left as-is with its TODO.

## Smoke test

```bash
npm install
npm run build
npm run smoke
```

Asserts six end-to-end paths:

1. **Forward replay of character mutations** — adds/deletes at overlapping indices produce the expected output text.
2. **Determinism** — applying the same mutation log twice gives the same result.
3. **Label merge** — additions, deletions, and updates of a key all honor timestamp ordering.
4. **Full save / load roundtrip via TextCodec** through `InMemory{PartitionMap,SortedSet,BlobStore}`, including a mid-sequence checkpoint (snapshotFrequency=3, three saves).
5. **Promise-based dedup** — three concurrent `view.load(v1)` calls share the same resolved `Promise<Checkpoint>` and trigger at most 2 underlying DAO round trips.
6. **Generic ContentCodec** — a JSON-object content type with set/delete patches saves + loads through the same engine; intermediate-version replay works.

## License

MIT
