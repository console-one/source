// ─────────────────────────────────────────────────────────────────────────
// SystemLogger — typed log-event stream. Patch + subscribe shape; default
// impl falls back to console when no subscriber is attached, otherwise
// dispatches events to subscribers.
//
// NOTE: assessable's `toLookLike` treats certain strings ('error', 'array',
// etc.) as TYPE ASSERTIONS rather than literal-value matches. So this test
// converts log levels to a non-colliding token (e.g. "L:error") before
// comparing, and asserts derived booleans/counts rather than raw level
// strings.
// ─────────────────────────────────────────────────────────────────────────

import {
  DefaultSystemLogger,
  log,
  setSystemLogger,
  getSystemLogger,
  type LogEvent,
  type SystemLogger,
} from '../index.js';

const tag = (lvl: string) => `L:${lvl}`;

export default async (
  test: (name: string, body: (validator: any) => any) => any,
) => {
  await test(
    'subscribers receive log events as patches; events stop after unsub',
    async (validator: any) => {
      const seen: LogEvent[] = [];
      const logger = new DefaultSystemLogger();
      const unsub = logger.subscribe((ev) => seen.push(ev));

      logger.log({ level: 'info', source: 'unit/test', message: 'hello' });
      logger.log({
        level: 'error',
        source: 'unit/test',
        message: 'boom',
        context: { code: 42 },
      });

      const beforeUnsub = seen.map((e) => ({
        levelTag: tag(e.level),
        source: e.source,
        message: e.message,
        contextCode: (e.context as any)?.code ?? null,
        hasTimestamp: typeof e.timestamp === 'number',
      }));

      unsub();
      logger.log({
        level: 'debug',
        source: 'unit/test',
        message: 'after unsub',
      });

      return validator
        .expect({ beforeUnsub, finalCount: seen.length })
        .toLookLike({
          beforeUnsub: [
            {
              levelTag: 'L:info',
              source: 'unit/test',
              message: 'hello',
              contextCode: null,
              hasTimestamp: true,
            },
            {
              levelTag: 'L:error',
              source: 'unit/test',
              message: 'boom',
              contextCode: 42,
              hasTimestamp: true,
            },
          ],
          finalCount: 2,
        });
    },
  );

  await test(
    'singleton swap: setSystemLogger routes log.* helpers to a custom logger',
    async (validator: any) => {
      const captured: Array<{
        levelTag: string;
        source: string;
        message: string;
        detail?: string;
      }> = [];
      const custom: SystemLogger = {
        log: (input) =>
          captured.push({
            levelTag: tag(input.level),
            source: input.source,
            message: input.message,
            detail: (input.context as any)?.detail,
          }),
        subscribe: () => () => undefined,
      };

      const previous = getSystemLogger();
      setSystemLogger(custom);
      try {
        log.warn('unit/test', 'a warning', { detail: 'extra' });
        log.error('unit/test', 'an issue');
      } finally {
        setSystemLogger(previous);
      }

      return validator.expect(captured).toLookLike([
        {
          levelTag: 'L:warn',
          source: 'unit/test',
          message: 'a warning',
          detail: 'extra',
        },
        {
          levelTag: 'L:error',
          source: 'unit/test',
          message: 'an issue',
          detail: undefined,
        },
      ]);
    },
  );
};
