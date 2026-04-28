// ─────────────────────────────────────────────────────────────────────────
// Generic ContentCodec — the engine replays an arbitrary T type. Here a
// shallow JSON object with set/delete patches.
// ─────────────────────────────────────────────────────────────────────────

import {
  type ContentCodec,
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap,
  InMemorySortedSet,
  SourceID,
  type Update,
} from '../index.js';

type ObjPatch = { op: 'set'; key: string; value: unknown } | { op: 'delete'; key: string };
type ObjState = Record<string, unknown>;

const ObjectCodec: ContentCodec<ObjState, ObjPatch> = {
  empty: () => ({}),
  applyPatches: (state, patches) => {
    const next: ObjState = { ...state };
    for (const p of patches) {
      if (p.op === 'set') next[p.key] = p.value;
      else delete next[p.key];
    }
    return next;
  },
  serialize: (state) => JSON.stringify(state),
  deserialize: (raw) => JSON.parse(raw),
  patchToJSON: (p) => p,
  patchFromJSON: (raw) => raw as ObjPatch,
};

function buildObjectView() {
  const updateDao = new Dao.Update.Default<ObjPatch>(
    new InMemoryPartitionMap<Update<ObjPatch>>(),
    new InMemorySortedSet<number>(),
  );
  const checkpointDao = new Dao.Checkpoint.Default<ObjState, ObjPatch>(
    new InMemoryBlobStore(),
    updateDao,
    ObjectCodec,
  );
  return {
    view: new Dao.Code.View.Checkpoint<ObjState, ObjPatch>(
      checkpointDao,
      updateDao,
      ObjectCodec,
      3,
      20,
    ),
    checkpointDao,
    updateDao,
  };
}

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('object codec replays set + delete across V1→V2→V3', async (validator: any) => {
    const { view } = buildObjectView();
    const path = 'cells/user-profile';
    const v1 = new SourceID(path, 1);
    await view.save({
      newVersion: v1,
      patches: [
        { op: 'set', key: 'name', value: 'Andrew' },
        { op: 'set', key: 'role', value: 'engineer' },
      ],
      labelChanges: [],
      workspace: 'main',
    });
    const v2 = new SourceID(path, 2);
    await view.save({
      priorVersion: v1,
      newVersion: v2,
      patches: [{ op: 'set', key: 'role', value: 'architect' }],
      labelChanges: [],
      workspace: 'main',
    });
    const v3 = new SourceID(path, 3);
    await view.save({
      priorVersion: v2,
      newVersion: v3,
      patches: [
        { op: 'delete', key: 'name' },
        { op: 'set', key: 'tier', value: 'senior' },
      ],
      labelChanges: [],
      workspace: 'main',
    });
    const loaded = await view.load(v3);
    return validator.expect({
      role: loaded.content.role,
      tier: loaded.content.tier,
      hasName: 'name' in loaded.content,
    }).toLookLike({ role: 'architect', tier: 'senior', hasName: false });
  });

  await test('object codec V2 replay reproduces intermediate state from a fresh view', async (validator: any) => {
    const { view, checkpointDao, updateDao } = buildObjectView();
    const path = 'cells/replay-test';
    const v1 = new SourceID(path, 1);
    await view.save({
      newVersion: v1,
      patches: [{ op: 'set', key: 'name', value: 'Andrew' }],
      labelChanges: [],
      workspace: 'main',
    });
    const v2 = new SourceID(path, 2);
    await view.save({
      priorVersion: v1,
      newVersion: v2,
      patches: [{ op: 'set', key: 'role', value: 'architect' }],
      labelChanges: [],
      workspace: 'main',
    });
    const fresh = new Dao.Code.View.Checkpoint<ObjState, ObjPatch>(
      checkpointDao,
      updateDao,
      ObjectCodec,
      3,
      20,
    );
    const loaded = await fresh.load(v2);
    return validator.expect({
      role: loaded.content.role,
      name: loaded.content.name,
    }).toLookLike({ role: 'architect', name: 'Andrew' });
  });
};
