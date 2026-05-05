// ─────────────────────────────────────────────────────────────────────────
// DirectedGraphStore — directional edges, sibling-isolation, traversal,
// idempotency, removeNode cleanup.
//
// Tests run against the InMemory implementation. The SQLite version
// shares the same interface contract; lens-desktop will exercise it
// with its own better-sqlite3 connection.
// ─────────────────────────────────────────────────────────────────────────

import { InMemoryDirectedGraphStore } from '../index.js';

export default async (
  test: (name: string, body: (validator: any) => any) => any,
) => {
  await test(
    'directionality: outgoing(A) and incoming(A) return DIFFERENT sets',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, undefined>();
      await g.addEdge('A', 'B', 'dependsOn');
      await g.addEdge('C', 'A', 'dependsOn');

      const aOut = await g.outgoing('A');
      const aIn = await g.incoming('A');

      return validator
        .expect({
          outFrom: aOut.map((e) => `${e.from}->${e.to}`).sort(),
          inTo: aIn.map((e) => `${e.from}->${e.to}`).sort(),
        })
        .toLookLike({
          outFrom: ['A->B'],
          inTo: ['C->A'],
        });
    },
  );

  await test(
    'edgeType filter restricts results',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, undefined>();
      await g.addEdge('A', 'B', 'dependsOn');
      await g.addEdge('A', 'B', 'references');
      await g.addEdge('A', 'C', 'dependsOn');

      const allOut = await g.outgoing('A');
      const dependsOnly = await g.outgoing('A', 'dependsOn');
      const referencesOnly = await g.outgoing('A', 'references');

      return validator
        .expect({
          allCount: allOut.length,
          dependsCount: dependsOnly.length,
          referencesCount: referencesOnly.length,
          dependsTargets: dependsOnly.map((e) => `${e.to}`).sort(),
        })
        .toLookLike({
          allCount: 3,
          dependsCount: 2,
          referencesCount: 1,
          dependsTargets: ['B', 'C'],
        });
    },
  );

  await test(
    'addEdge is idempotent: same (from, to, edgeType) twice is one edge',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, undefined>();
      await g.addEdge('A', 'B', 'rel');
      await g.addEdge('A', 'B', 'rel');
      await g.addEdge('A', 'B', 'rel');

      const out = await g.outgoing('A');

      return validator.expect(out.length).toLookLike(1);
    },
  );

  await test(
    'edge data is preserved through round-trip',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, { weight: number }>();
      await g.addEdge('A', 'B', 'rel', { weight: 42 });

      const [edge] = await g.outgoing('A');

      return validator
        .expect({
          from: edge.from,
          to: edge.to,
          weight: edge.data?.weight,
        })
        .toLookLike({ from: 'A', to: 'B', weight: 42 });
    },
  );

  await test(
    'traverse returns all reachable edges within depth N (cycle-safe)',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, undefined>();
      // A → B → C → D
      await g.addEdge('A', 'B', 'rel');
      await g.addEdge('B', 'C', 'rel');
      await g.addEdge('C', 'D', 'rel');
      // Cycle: D → A
      await g.addEdge('D', 'A', 'rel');

      const depth2 = await g.traverse('A', { depth: 2 });
      const depth4 = await g.traverse('A', { depth: 4 });

      return validator
        .expect({
          depth2Edges: depth2.map((e) => `${e.from}->${e.to}`).sort(),
          depth4Edges: depth4.map((e) => `${e.from}->${e.to}`).sort(),
        })
        .toLookLike({
          // depth=2: A->B (depth 0->1) and B->C (depth 1->2). C->D not visited.
          depth2Edges: ['A->B', 'B->C'],
          // depth=4: all four edges visited; cycle returns to A but the
          // visited-edges set keeps D->A from re-firing on more cycles.
          depth4Edges: ['A->B', 'B->C', 'C->D', 'D->A'],
        });
    },
  );

  await test(
    'removeNode cleans up all edges touching the node (both directions)',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, undefined>();
      await g.addEdge('A', 'B', 'rel');
      await g.addEdge('A', 'C', 'rel');
      await g.addEdge('D', 'A', 'rel');
      await g.addEdge('B', 'C', 'rel'); // doesn't touch A

      await g.removeNode('A');

      const aOut = await g.outgoing('A');
      const aIn = await g.incoming('A');
      const dOut = await g.outgoing('D'); // had A as target
      const bcStill = await g.outgoing('B'); // unrelated to A

      return validator
        .expect({
          aOutCount: aOut.length,
          aInCount: aIn.length,
          dOutCount: dOut.length,
          bcCount: bcStill.length,
        })
        .toLookLike({
          aOutCount: 0,
          aInCount: 0,
          dOutCount: 0, // D->A was removed
          bcCount: 1, // B->C survives
        });
    },
  );

  await test(
    'removeEdge removes only the specified directed edge',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, undefined>();
      await g.addEdge('A', 'B', 'rel');
      await g.addEdge('B', 'A', 'rel'); // reverse — separate edge

      await g.removeEdge('A', 'B', 'rel');

      const has1 = await g.hasEdge('A', 'B', 'rel');
      const has2 = await g.hasEdge('B', 'A', 'rel');

      return validator
        .expect({ aToB: has1, bToA: has2 })
        .toLookLike({ aToB: false, bToA: true });
    },
  );

  await test(
    'providers/consumers worked example (the load-bearing artifact case)',
    async (validator: any) => {
      const g = new InMemoryDirectedGraphStore<string, undefined>();
      // app depends on chat-kit; chat-kit depends on toolkit + llm-config
      await g.addEdge('app', 'chat-kit', 'dependsOn');
      await g.addEdge('chat-kit', 'toolkit', 'dependsOn');
      await g.addEdge('chat-kit', 'llm-config', 'dependsOn');
      // narrative also depends on chat-kit
      await g.addEdge('narrative', 'chat-kit', 'dependsOn');

      // getProviders(app) — what does app depend on?
      const appProviders = await g.outgoing('app', 'dependsOn');
      // getConsumers(chat-kit) — what depends on chat-kit?
      const chatKitConsumers = await g.incoming('chat-kit', 'dependsOn');
      // transitive: getProviders(app, depth=2) — full reachable depGraph
      const transitive = await g.traverse('app', {
        depth: 3,
        edgeType: 'dependsOn',
      });

      return validator
        .expect({
          providersOfApp: appProviders.map((e) => e.to).sort(),
          consumersOfChatKit: chatKitConsumers.map((e) => e.from).sort(),
          transitiveEdges: transitive.map((e) => `${e.from}->${e.to}`).sort(),
        })
        .toLookLike({
          providersOfApp: ['chat-kit'],
          consumersOfChatKit: ['app', 'narrative'],
          transitiveEdges: [
            'app->chat-kit',
            'chat-kit->llm-config',
            'chat-kit->toolkit',
          ],
        });
    },
  );
};
