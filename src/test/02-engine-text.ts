// ─────────────────────────────────────────────────────────────────────────
// Event-sourced store, text codec — save V1→V2→V3, load any version,
// labels merge across versions.
// ─────────────────────────────────────────────────────────────────────────

import {
  Change,
  type Checkpoint,
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap,
  InMemorySortedSet,
  Label,
  LabelChange,
  Mutation,
  SourceID,
  TextCodec,
  Update,
} from '../index.js';

function buildView() {
  const updateDao = new Dao.Update.Default<Change>(
    new InMemoryPartitionMap<Update<Change>>(),
    new InMemorySortedSet<number>(),
  );
  const checkpointDao = new Dao.Checkpoint.Default<string, Change>(
    new InMemoryBlobStore(),
    updateDao,
    TextCodec,
  );
  return new Dao.Code.View.Checkpoint<string, Change>(checkpointDao, updateDao, TextCodec, 3, 20);
}

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('V1→V2→V3 save/load reconstructs full content via TextCodec', async (validator: any) => {
    const view = buildView();
    const path = 'example/file.ts';
    const v1 = new SourceID(path, 1);
    await view.save({
      newVersion: v1,
      patches: [new Change(0, 'const a = 1;\n', Mutation.ADDITION, 1)],
      labelChanges: [new LabelChange(1, [Mutation.ADDITION, new Label('author', 'alice')])],
      workspace: 'main',
    });
    const v2 = new SourceID(path, 2);
    await view.save({
      priorVersion: v1,
      newVersion: v2,
      patches: [new Change(13, 'const b = 2;\n', Mutation.ADDITION, 2)],
      labelChanges: [],
      workspace: 'main',
    });
    const v3 = new SourceID(path, 3);
    await view.save({
      priorVersion: v2,
      newVersion: v3,
      patches: [new Change(26, 'const c = 3;\n', Mutation.ADDITION, 3)],
      labelChanges: [new LabelChange(3, [Mutation.ADDITION, new Label('tag', 'v3')])],
      workspace: 'main',
    });
    const loaded: Checkpoint<string> = await view.load(v3);
    const labels = loaded.labels.map((l) => l.key).sort();
    return validator.expect({
      content: loaded.content,
      labels,
    }).toLookLike({
      content: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
      labels: ['author', 'tag'],
    });
  });
};
