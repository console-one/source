// ─────────────────────────────────────────────────────────────────────────
// Filesystem-backed adapters — durable across process restarts. The same
// shape that `Code.View.Checkpoint` already exercises against the
// InMemory adapters, but writing through the filesystem.
//
// Test strategy: spin up a temp directory; run a save/load cycle through
// `Code.View.Checkpoint`; tear down the in-memory state; reconstruct
// fresh adapters pointing at the SAME directory; verify the prior
// content loads correctly. That's the durability proof that InMemory
// can't give us.
// ─────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  Dao,
  SourceID,
  TextCodec,
  FilesystemBlobStore,
  FilesystemPartitionMap,
  FilesystemSortedSet,
  Update,
} from '../index.js';

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-one-source-fs-test-'));
  return dir;
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export default async (
  test: (name: string, body: (validator: any) => any) => any,
) => {
  await test(
    'filesystem adapters survive disposal: write → drop adapters → re-create at same root → read original content',
    async (validator: any) => {
      const root = makeTempDir();
      try {
        const blobRoot = path.join(root, 'blobs');
        const partitionRoot = path.join(root, 'partitions');
        const sortedRoot = path.join(root, 'sortedsets');

        // ── Phase 1: write through Code.View.Checkpoint ──
        {
          // SourceUpdate carries SourceID instances in its lineage; plain JSON
          // loses class identity. Provide a SourceUpdate-aware deserializer
          // so durable storage roundtrips correctly.
          const sourceUpdateSerializer = {
            serialize: (v: any) => JSON.stringify(v),
            deserialize: (raw: string) => Update.fromJSON(JSON.parse(raw), TextCodec.patchFromJSON),
          };
          const partitionMap = new FilesystemPartitionMap<any>(partitionRoot, sourceUpdateSerializer);
          const sortedSet = new FilesystemSortedSet<number>(sortedRoot);
          const blobStore = new FilesystemBlobStore(
            blobRoot,
            'fs-test',
            'phase1',
          );
          const updateDao = new Dao.Update.Default(partitionMap, sortedSet);
          const checkpointDao = new Dao.Checkpoint.Default(
            blobStore,
            updateDao,
            TextCodec,
          );
          const view = new Dao.Code.View.Checkpoint<string, any>(
            checkpointDao,
            updateDao,
            TextCodec,
            3,
            10,
          );

          const v1 = new SourceID('fs/durability', 1);
          await view.save({
            newVersion: v1,
            patches: [],
            labelChanges: [],
            workspace: 'main',
          });
          // (The TextCodec replays Change records; for the durability test
          // we just need ANY content to flow through and persist. Empty
          // patches into an empty initial content is the simplest case.)

          const loaded = await view.load(v1);
          // Sanity: we can read what we just wrote in this same view.
          if (loaded === undefined) {
            throw new Error('initial load failed');
          }
        }

        // ── Phase 2: re-create adapters pointing at SAME files ──
        // All in-memory state from Phase 1 is GONE. Only the filesystem
        // entries remain. Verify the prior version is still reachable.
        const sourceUpdateSerializer2 = {
          serialize: (v: any) => JSON.stringify(v),
          deserialize: (raw: string) => Update.fromJSON(JSON.parse(raw), TextCodec.patchFromJSON),
        };
        const partitionMap2 = new FilesystemPartitionMap<any>(partitionRoot, sourceUpdateSerializer2);
        const sortedSet2 = new FilesystemSortedSet<number>(sortedRoot);
        const blobStore2 = new FilesystemBlobStore(
          blobRoot,
          'fs-test',
          'phase2',
        );
        const updateDao2 = new Dao.Update.Default(partitionMap2, sortedSet2);
        const checkpointDao2 = new Dao.Checkpoint.Default(
          blobStore2,
          updateDao2,
          TextCodec,
        );
        const view2 = new Dao.Code.View.Checkpoint<string, any>(
          checkpointDao2,
          updateDao2,
          TextCodec,
          3,
          10,
        );

        const v1 = new SourceID('fs/durability', 1);
        const recovered = await view2.load(v1);

        return validator
          .expect({
            recoveredDefined: recovered !== undefined,
            hasContent: typeof recovered.content === 'string',
            workspace: recovered.lineage[0][2],
          })
          .toLookLike({
            recoveredDefined: true,
            hasContent: true,
            workspace: 'main',
          });
      } finally {
        rmDir(root);
      }
    },
  );

  await test(
    'FilesystemPartitionMap basic round-trip: set/get/has/delete across instances',
    async (validator: any) => {
      const root = makeTempDir();
      try {
        const { ColumnKey } = await import('../index.js');
        const k1 = ColumnKey.from('region-a', 'item-1');

        // Write with one instance.
        {
          const m = new FilesystemPartitionMap<{ data: string }>(root);
          await m.set(k1, { data: 'persisted' });
        }

        // Read with a fresh instance.
        const m2 = new FilesystemPartitionMap<{ data: string }>(root);
        const got = await m2.get(k1);
        const has = await m2.has(k1);

        // Delete; verify gone.
        await m2.delete(k1);
        const stillHas = await m2.has(k1);

        return validator
          .expect({
            gotData: got?.data,
            hadBeforeDelete: has,
            hasAfterDelete: stillHas,
          })
          .toLookLike({
            gotData: 'persisted',
            hadBeforeDelete: true,
            hasAfterDelete: false,
          });
      } finally {
        rmDir(root);
      }
    },
  );

  await test(
    'FilesystemSortedSet survives instance disposal; findMax returns latest',
    async (validator: any) => {
      const root = makeTempDir();
      try {
        const { ColumnKey } = await import('../index.js');
        const k = ColumnKey.from('versions', 'main');

        {
          const s = new FilesystemSortedSet<number>(root);
          await s.add(k, 1);
          await s.add(k, 5);
          await s.add(k, 3);
        }

        const s2 = new FilesystemSortedSet<number>(root);
        const max = await s2.findMax(k);

        return validator.expect(max).toLookLike(5);
      } finally {
        rmDir(root);
      }
    },
  );

  await test(
    'FilesystemBlobStore survives instance disposal; read returns saved content',
    async (validator: any) => {
      const root = makeTempDir();
      try {
        {
          const b = new FilesystemBlobStore(root, 'unit', 'test');
          await b.save('chats/test/v1', 'hello world');
        }

        const b2 = new FilesystemBlobStore(root, 'unit', 'test');
        const got = await b2.read('chats/test/v1');
        const has = await b2.has('chats/test/v1');

        return validator
          .expect({ got, has })
          .toLookLike({ got: 'hello world', has: true });
      } finally {
        rmDir(root);
      }
    },
  );
};
