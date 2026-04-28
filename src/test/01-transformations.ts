// ─────────────────────────────────────────────────────────────────────────
// Transformations.applyCodeChanges (forward) and applyLabelChanges. The
// forward direction is deterministic on reapply; backward is documented as
// a known limitation in the package README.
// ─────────────────────────────────────────────────────────────────────────

import {
  Change,
  Label,
  LabelChange,
  Mutation,
  Transformations,
} from '../index.js';

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('forward applyCodeChanges executes ordered patches at the right indices', async (validator: any) => {
    const src = 'Sample\nSource\nCode';
    const changes = [
      new Change(0, 'Sample\n', Mutation.DELETION, 100),
      new Change(0, 'This is\n', Mutation.ADDITION, 101),
      new Change(7, 'Typescript\n', Mutation.ADDITION, 102),
    ];
    const result = Transformations.applyCodeChanges(src, changes, 'FORWARD');
    return validator.expect(result).toLookLike('This is\nTypescript\nSource\nCode');
  });

  await test('forward replay is deterministic on reapply', async (validator: any) => {
    const original = 'import "redis";\n\nlet x = new SourceCodeDao();';
    const changes = [
      new Change(0, 'import "redis";', Mutation.DELETION, 500),
      new Change(0, 'export "apple";', Mutation.ADDITION, 500),
      new Change(17, 'let y = new Mutation();\n\n', Mutation.ADDITION, 500),
    ];
    const a = Transformations.applyCodeChanges(original, changes, 'FORWARD');
    const b = Transformations.applyCodeChanges(original, changes, 'FORWARD');
    return validator.expect(a === b).toLookLike(true);
  });

  await test('label merge: deletion drops a key, repeated key takes most-recent value', async (validator: any) => {
    const initial = [
      new Label('note', 'first draft'),
      new Label('branch', 'mainline'),
    ];
    const changes: LabelChange[] = [
      new LabelChange(100, [Mutation.ADDITION, new Label('tag', 'review')]),
      new LabelChange(110, [Mutation.DELETION, 'branch']),
      new LabelChange(120, [Mutation.ADDITION, new Label('note', 'revised draft')]),
    ];
    const out = Transformations.applyLabelChanges(initial, changes);
    const keys = out.map((l) => l.key).sort();
    const note = out.find((l) => l.key === 'note');
    return validator.expect({
      keys,
      noteValue: note?.value,
    }).toLookLike({
      keys: ['note', 'tag'],
      noteValue: 'revised draft',
    });
  });
};
