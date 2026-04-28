// ─────────────────────────────────────────────────────────────────────────
// Promise-based dedup: concurrent .load() of the same version share a
// single in-flight DAO call.
// ─────────────────────────────────────────────────────────────────────────

import {
  Change,
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap,
  InMemorySortedSet,
  Mutation,
  SourceID,
  TextCodec,
  type Update,
} from '../index.js';

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('three concurrent loads of the same version dedup to ≤2 DAO round-trips', async (validator: any) => {
    let getAllCalls = 0;
    class CountingMap extends InMemoryPartitionMap<Update<Change>> {
      override async getAll(keys: any) {
        getAllCalls += 1;
        return super.getAll(keys);
      }
    }
    const updateDao = new Dao.Update.Default<Change>(
      new CountingMap(),
      new InMemorySortedSet<number>(),
    );
    const checkpointDao = new Dao.Checkpoint.Default<string, Change>(
      new InMemoryBlobStore(),
      updateDao,
      TextCodec,
    );
    const view = new Dao.Code.View.Checkpoint<string, Change>(
      checkpointDao,
      updateDao,
      TextCodec,
      3,
      20,
    );
    const path = 'dedup/example.ts';
    const v1 = new SourceID(path, 10);
    await view.save({
      newVersion: v1,
      patches: [new Change(0, 'hello', Mutation.ADDITION, 10)],
      labelChanges: [],
      workspace: 'main',
    });
    const fresh = new Dao.Code.View.Checkpoint<string, Change>(
      checkpointDao,
      updateDao,
      TextCodec,
      3,
      20,
    );
    getAllCalls = 0;
    const [a, b, c] = await Promise.all([fresh.load(v1), fresh.load(v1), fresh.load(v1)]);
    return validator.expect({
      sameRef: a === b && b === c,
      content: a.content,
      atMostTwoCalls: getAllCalls <= 2,
    }).toLookLike({ sameRef: true, content: 'hello', atMostTwoCalls: true });
  });
};
