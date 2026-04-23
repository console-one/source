/**
 * Smoke test: generic content-codec replay + hot/cold store + promise dedup.
 *
 * Exercised paths:
 *   - Transformations.applyCodeChanges (forward mutation, determinism)
 *   - Transformations.applyLabelChanges
 *   - Dao.Code.View.Checkpoint save/load with full lineage reconstruction,
 *     using both the built-in TextCodec AND a custom non-text codec
 *   - snapshotFrequency: updates vs. checkpoints
 *   - Promise-based dedup: concurrent .load() of same version shares one DAO call
 *   - All adapters: InMemory{PartitionMap,SortedSet,BlobStore}
 *
 * Exits non-zero on any assertion failure.
 */

import {
  Change,
  Checkpoint,
  ContentCodec,
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap,
  InMemorySortedSet,
  Label,
  LabelChange,
  Mutation,
  SourceID,
  TextCodec,
  Transformations,
  Update
} from './index.js'

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`[smoke] assertion failed: ${msg}`)
}

// ---------------------------------------------------------------------------
// Case 1: Transformations.applyCodeChanges — forward mutation
// ---------------------------------------------------------------------------
function caseForward() {
  const src = 'Sample\nSource\nCode'
  const changes = [
    new Change(0, 'Sample\n', Mutation.DELETION, 100),
    new Change(0, 'This is\n', Mutation.ADDITION, 101),
    new Change(7, 'Typescript\n', Mutation.ADDITION, 102)
  ]
  const result = Transformations.applyCodeChanges(src, changes, 'FORWARD')
  const expected = 'This is\nTypescript\nSource\nCode'
  assert(result === expected, `expected '${expected}', got '${result}'`)
  console.log(`[smoke] case1 OK — forward applyCodeChanges: '${src.replace(/\n/g, '\\n')}' → '${result.replace(/\n/g, '\\n')}'`)
}

// ---------------------------------------------------------------------------
// Case 2: deterministic forward replay over mixed add+delete at same index
// ---------------------------------------------------------------------------
function caseDeterministicForward() {
  const original = 'import "redis";\n\nlet x = new SourceCodeDao();'
  const changes = [
    new Change(0, 'import "redis";', Mutation.DELETION, 500),
    new Change(0, 'export "apple";', Mutation.ADDITION, 500),
    new Change(17, 'let y = new Mutation();\n\n', Mutation.ADDITION, 500)
  ]
  const mutated = Transformations.applyCodeChanges(original, changes, 'FORWARD')
  const expected = 'export "apple";\n\nlet y = new Mutation();\n\nlet x = new SourceCodeDao();'
  assert(mutated === expected, `mismatch: expected '${expected}', got '${mutated}'`)

  const mutatedAgain = Transformations.applyCodeChanges(original, changes, 'FORWARD')
  assert(mutated === mutatedAgain, 'forward replay is not deterministic')

  console.log(`[smoke] case2 OK — forward replay handles mixed add+delete at overlapping indices and is deterministic on reapply`)
}

// ---------------------------------------------------------------------------
// Case 3: Transformations.applyLabelChanges
// ---------------------------------------------------------------------------
function caseLabels() {
  const initial = [
    new Label('note', 'first draft'),
    new Label('branch', 'mainline')
  ]
  const changes: LabelChange[] = [
    new LabelChange(100, [Mutation.ADDITION, new Label('tag', 'review')]),
    new LabelChange(110, [Mutation.DELETION, 'branch']),
    new LabelChange(120, [Mutation.ADDITION, new Label('note', 'revised draft')])
  ]
  const out = Transformations.applyLabelChanges(initial, changes)
  const keys = new Set(out.map(l => l.key))
  assert(keys.has('note') && keys.has('tag') && !keys.has('branch'),
    `expected {note, tag} (no branch), got ${JSON.stringify([...keys])}`)
  const note = out.find(l => l.key === 'note')
  assert(note!.value === 'revised draft', `note should be most-recent-addition; got '${note!.value}'`)
  console.log(`[smoke] case3 OK — label merge: branch deleted, note updated, tag added`)
}

// ---------------------------------------------------------------------------
// Case 4: Event-sourced store (text codec) — save + load roundtrip with
//         mid-sequence checkpoint. Confirms the generalized engine still
//         behaves identically to the old text-only path when driven by
//         TextCodec.
// ---------------------------------------------------------------------------
async function caseStoreRoundtrip() {
  const updateDao = new Dao.Update.Default<Change>(
    new InMemoryPartitionMap<Update<Change>>(),
    new InMemorySortedSet<number>()
  )
  const checkpointDao = new Dao.Checkpoint.Default<string, Change>(
    new InMemoryBlobStore(),
    updateDao,
    TextCodec
  )
  const view = new Dao.Code.View.Checkpoint<string, Change>(checkpointDao, updateDao, TextCodec, 3, 20)

  const path = 'example/file.ts'

  const v1 = new SourceID(path, 1)
  await view.save({
    newVersion: v1,
    patches: [new Change(0, 'const a = 1;\n', Mutation.ADDITION, 1)],
    labelChanges: [new LabelChange(1, [Mutation.ADDITION, new Label('author', 'alice')])],
    workspace: 'main'
  })

  const v2 = new SourceID(path, 2)
  await view.save({
    priorVersion: v1,
    newVersion: v2,
    patches: [new Change(13, 'const b = 2;\n', Mutation.ADDITION, 2)],
    labelChanges: [],
    workspace: 'main'
  })

  const v3 = new SourceID(path, 3)
  await view.save({
    priorVersion: v2,
    newVersion: v3,
    patches: [new Change(26, 'const c = 3;\n', Mutation.ADDITION, 3)],
    labelChanges: [new LabelChange(3, [Mutation.ADDITION, new Label('tag', 'v3')])],
    workspace: 'main'
  })

  const loaded: Checkpoint<string> = await view.load(v3)
  const expected = 'const a = 1;\nconst b = 2;\nconst c = 3;\n'
  assert(loaded.content === expected, `V3 content mismatch:\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(loaded.content)}`)

  const labels = new Set(loaded.labels.map(l => l.key))
  assert(labels.has('author') && labels.has('tag'), `expected {author, tag}, got ${JSON.stringify([...labels])}`)

  console.log('[smoke] case4 OK — V1→V2→V3 (checkpoint at V3) saved + loaded via TextCodec; labels preserved across versions')
}

// ---------------------------------------------------------------------------
// Case 5: Promise-based dedup — two concurrent loads of the same version
//         share one DAO round trip.
// ---------------------------------------------------------------------------
async function caseDedup() {
  let getAllCalls = 0
  class CountingMap extends InMemoryPartitionMap<Update<Change>> {
    async getAll(keys: any) {
      getAllCalls += 1
      return super.getAll(keys)
    }
  }

  const updateDao = new Dao.Update.Default<Change>(
    new CountingMap(),
    new InMemorySortedSet<number>()
  )
  const checkpointDao = new Dao.Checkpoint.Default<string, Change>(
    new InMemoryBlobStore(),
    updateDao,
    TextCodec
  )
  const view = new Dao.Code.View.Checkpoint<string, Change>(checkpointDao, updateDao, TextCodec, 3, 20)

  const path = 'dedup/example.ts'
  const v1 = new SourceID(path, 10)
  await view.save({
    newVersion: v1,
    patches: [new Change(0, 'hello', Mutation.ADDITION, 10)],
    labelChanges: [],
    workspace: 'main'
  })

  const freshView = new Dao.Code.View.Checkpoint<string, Change>(checkpointDao, updateDao, TextCodec, 3, 20)
  getAllCalls = 0
  const [a, b, c] = await Promise.all([
    freshView.load(v1),
    freshView.load(v1),
    freshView.load(v1)
  ])

  assert(a === b && b === c, 'concurrent loads should return the same promise (===)')
  assert(a.content === 'hello', `expected content 'hello', got '${a.content}'`)
  assert(getAllCalls <= 2, `dedup failed: 3 concurrent loads triggered ${getAllCalls} DAO round trips`)

  console.log(`[smoke] case5 OK — 3 concurrent .load(v1) calls triggered ${getAllCalls} DAO calls (dedup working)`)
}

// ---------------------------------------------------------------------------
// Case 6: Non-text content — the engine replays arbitrary T through a
//         caller-provided ContentCodec. Here: a shallow JSON object where
//         each "patch" is a { op: 'set' | 'delete', key, value? } record.
//         Proves the generic seam end-to-end.
// ---------------------------------------------------------------------------
async function caseGenericObject() {
  type ObjPatch = { op: 'set', key: string, value: unknown } | { op: 'delete', key: string }
  type ObjState = Record<string, unknown>

  const ObjectCodec: ContentCodec<ObjState, ObjPatch> = {
    empty: () => ({}),
    applyPatches: (state, patches) => {
      const next: ObjState = { ...state }
      for (const p of patches) {
        if (p.op === 'set') next[p.key] = p.value
        else delete next[p.key]
      }
      return next
    },
    serialize: (state) => JSON.stringify(state),
    deserialize: (raw) => JSON.parse(raw),
    patchToJSON: (p) => p,
    patchFromJSON: (raw) => raw as ObjPatch
  }

  const updateDao = new Dao.Update.Default<ObjPatch>(
    new InMemoryPartitionMap<Update<ObjPatch>>(),
    new InMemorySortedSet<number>()
  )
  const checkpointDao = new Dao.Checkpoint.Default<ObjState, ObjPatch>(
    new InMemoryBlobStore(),
    updateDao,
    ObjectCodec
  )
  const view = new Dao.Code.View.Checkpoint<ObjState, ObjPatch>(checkpointDao, updateDao, ObjectCodec, 3, 20)

  const path = 'cells/user-profile'

  const v1 = new SourceID(path, 1)
  await view.save({
    newVersion: v1,
    patches: [{ op: 'set', key: 'name', value: 'Andrew' }, { op: 'set', key: 'role', value: 'engineer' }],
    labelChanges: [],
    workspace: 'main'
  })

  const v2 = new SourceID(path, 2)
  await view.save({
    priorVersion: v1,
    newVersion: v2,
    patches: [{ op: 'set', key: 'role', value: 'architect' }],
    labelChanges: [],
    workspace: 'main'
  })

  const v3 = new SourceID(path, 3)
  await view.save({
    priorVersion: v2,
    newVersion: v3,
    patches: [{ op: 'delete', key: 'name' }, { op: 'set', key: 'tier', value: 'senior' }],
    labelChanges: [],
    workspace: 'main'
  })

  const loadedV3 = await view.load(v3)
  assert(loadedV3.content.role === 'architect', `V3 role: expected 'architect', got ${JSON.stringify(loadedV3.content.role)}`)
  assert(loadedV3.content.tier === 'senior', `V3 tier: expected 'senior', got ${JSON.stringify(loadedV3.content.tier)}`)
  assert(!('name' in loadedV3.content), `V3 should not have 'name' key; got ${JSON.stringify(loadedV3.content)}`)

  // Back-query V2 — must replay from the v1 checkpoint (v1 was a checkpoint
  // since priorVersion was undefined) forward through v2's patch.
  // Use a fresh view to avoid the V2 load being satisfied from cache state
  // that was populated when V3 was written.
  const freshView = new Dao.Code.View.Checkpoint<ObjState, ObjPatch>(checkpointDao, updateDao, ObjectCodec, 3, 20)
  const loadedV2 = await freshView.load(v2)
  assert(loadedV2.content.role === 'architect', `V2 role: expected 'architect', got ${JSON.stringify(loadedV2.content.role)}`)
  assert(loadedV2.content.name === 'Andrew', `V2 name: expected 'Andrew', got ${JSON.stringify(loadedV2.content.name)}`)

  console.log('[smoke] case6 OK — generic object content: V1→V2→V3 saved + loaded via custom ContentCodec; intermediate V2 replay works')
}

async function main() {
  console.log('[smoke] @console-one/source')
  caseForward()
  caseDeterministicForward()
  caseLabels()
  await caseStoreRoundtrip()
  await caseDedup()
  await caseGenericObject()
  console.log('[smoke] ALL OK')
}

main().catch(err => {
  console.error('[smoke] FAIL', err)
  process.exit(1)
})
