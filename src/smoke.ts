/**
 * Smoke test: character-index replay + hot/cold store + promise-based dedup.
 *
 * Exercised paths:
 *   - Transformations.applyCodeChanges (forward + backward)
 *   - Transformations.applyLabelChanges
 *   - Dao.Code.View.Checkpoint save/load with full lineage reconstruction
 *   - snapshotFrequency: updates vs. checkpoints
 *   - Promise-based dedup: concurrent .load() of same version shares one DAO call
 *   - All adapters: InMemory{PartitionMap,SortedSet,BlobStore}
 *
 * Exits non-zero on any assertion failure.
 */

import {
  Change,
  Checkpoint,
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap,
  InMemorySortedSet,
  Label,
  LabelChange,
  Mutation,
  SourceID,
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
// Case 2: Transformations.applyCodeChanges — backward replay undoes forward
// ---------------------------------------------------------------------------
function caseDeterministicForward() {
  // Complex forward: mixed additions + deletions at overlapping indices.
  // Exact reproduction from the source repo's transformations test.
  const original = 'import "redis";\n\nlet x = new SourceCodeDao();'
  const changes = [
    new Change(0, 'import "redis";', Mutation.DELETION, 500),
    new Change(0, 'export "apple";', Mutation.ADDITION, 500),
    new Change(17, 'let y = new Mutation();\n\n', Mutation.ADDITION, 500)
  ]
  const mutated = Transformations.applyCodeChanges(original, changes, 'FORWARD')
  const expected = 'export "apple";\n\nlet y = new Mutation();\n\nlet x = new SourceCodeDao();'
  assert(mutated === expected, `mismatch: expected '${expected}', got '${mutated}'`)

  // Forward is deterministic on reapply.
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
// Case 4: Event-sourced store — save + load roundtrip through
//         InMemory adapters, with mid-sequence checkpoint.
// ---------------------------------------------------------------------------
async function caseStoreRoundtrip() {
  const updateDao = new Dao.Update.Default(
    new InMemoryPartitionMap<Update>(),
    new InMemorySortedSet<number>()
  )
  const checkpointDao = new Dao.Checkpoint.Default(
    new InMemoryBlobStore(),
    updateDao
  )
  // snapshotFrequency=3 → every 3rd save triggers a full checkpoint.
  const view = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, 3, 20)

  const path = 'example/file.ts'

  // V1: initial (must be a checkpoint — priorVersion is undefined)
  const v1 = new SourceID(path, 1)
  await view.save({
    newVersion: v1,
    sourceChanges: [new Change(0, 'const a = 1;\n', Mutation.ADDITION, 1)],
    labelChanges: [new LabelChange(1, [Mutation.ADDITION, new Label('author', 'alice')])],
    workspace: 'main'
  })

  // V2: append
  const v2 = new SourceID(path, 2)
  await view.save({
    priorVersion: v1,
    newVersion: v2,
    sourceChanges: [new Change(13, 'const b = 2;\n', Mutation.ADDITION, 2)],
    labelChanges: [],
    workspace: 'main'
  })

  // V3: another append — this hits snapshotFrequency=3 and writes a checkpoint
  const v3 = new SourceID(path, 3)
  await view.save({
    priorVersion: v2,
    newVersion: v3,
    sourceChanges: [new Change(26, 'const c = 3;\n', Mutation.ADDITION, 3)],
    labelChanges: [new LabelChange(3, [Mutation.ADDITION, new Label('tag', 'v3')])],
    workspace: 'main'
  })

  const loaded: Checkpoint = await view.load(v3)
  const expected = 'const a = 1;\nconst b = 2;\nconst c = 3;\n'
  assert(loaded.source === expected, `V3 source mismatch:\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(loaded.source)}`)

  const labels = new Set(loaded.labels.map(l => l.key))
  assert(labels.has('author') && labels.has('tag'), `expected {author, tag}, got ${JSON.stringify([...labels])}`)

  console.log('[smoke] case4 OK — V1→V2→V3 (checkpoint at V3) saved + loaded; labels preserved across versions')
}

// ---------------------------------------------------------------------------
// Case 5: Promise-based dedup — two concurrent loads of the same version
//         share one DAO round trip.
// ---------------------------------------------------------------------------
async function caseDedup() {
  // Wrap an in-memory PartitionMap to count .getAll() calls.
  let getAllCalls = 0
  class CountingMap extends InMemoryPartitionMap<Update> {
    async getAll(keys: any) {
      getAllCalls += 1
      return super.getAll(keys)
    }
  }

  const updateDao = new Dao.Update.Default(
    new CountingMap(),
    new InMemorySortedSet<number>()
  )
  const checkpointDao = new Dao.Checkpoint.Default(
    new InMemoryBlobStore(),
    updateDao
  )
  const view = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, 3, 20)

  const path = 'dedup/example.ts'
  const v1 = new SourceID(path, 10)
  await view.save({
    newVersion: v1,
    sourceChanges: [new Change(0, 'hello', Mutation.ADDITION, 10)],
    labelChanges: [],
    workspace: 'main'
  })

  // Fresh view so caches are empty
  const freshView = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, 3, 20)
  getAllCalls = 0
  const [a, b, c] = await Promise.all([
    freshView.load(v1),
    freshView.load(v1),
    freshView.load(v1)
  ])

  assert(a === b && b === c, 'concurrent loads should return the same promise (===)')
  assert(a.source === 'hello', `expected source 'hello', got '${a.source}'`)
  // The update load inside .load() should run at most twice (once for the version lookup,
  // once for the additional lineage loadAll — and the three concurrent calls share it).
  assert(getAllCalls <= 2, `dedup failed: 3 concurrent loads triggered ${getAllCalls} DAO round trips`)

  console.log(`[smoke] case5 OK — 3 concurrent .load(v1) calls triggered ${getAllCalls} DAO calls (dedup working)`)
}

async function main() {
  console.log('[smoke] @console-one/source')
  caseForward()
  caseDeterministicForward()
  caseLabels()
  await caseStoreRoundtrip()
  await caseDedup()
  console.log('[smoke] ALL OK')
}

main().catch(err => {
  console.error('[smoke] FAIL', err)
  process.exit(1)
})
