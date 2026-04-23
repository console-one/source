import { SourceChange } from './change.js'
import { Transformations } from './transformations.js'

/**
 * Content-type seam for the event-sourced engine.
 *
 * The engine in `Code.View.Checkpoint` is generic over two things:
 *   - TContent — the thing being versioned (text, a JSON object, a Set, ...)
 *   - TPatch   — the thing that describes a mutation
 *
 * The codec gives the engine the five operations it needs to work without
 * knowing what the content is: replay, start-from-empty, and a JSON-round-trip
 * for each of (content, patch).
 */
export interface ContentCodec<TContent, TPatch> {
  empty(): TContent
  applyPatches(content: TContent, patches: TPatch[]): TContent
  serialize(content: TContent): string
  deserialize(raw: string): TContent
  patchToJSON(patch: TPatch): unknown
  patchFromJSON(raw: any): TPatch
}

/**
 * The original text specialization — character-index deltas over UTF-8,
 * base64 on the wire. Pass this into `Code.View.Checkpoint` to get the
 * exact same behavior the engine had before the generalization.
 */
export const TextCodec: ContentCodec<string, SourceChange> = {
  empty: () => '',
  applyPatches: (s, ps) => Transformations.applyCodeChanges(s, ps, 'FORWARD'),
  serialize: (s) => Buffer.from(s, 'utf-8').toString('base64'),
  deserialize: (raw) => Buffer.from(raw, 'base64').toString('utf-8'),
  patchToJSON: (p) => p,
  patchFromJSON: (raw) => SourceChange.fromJSON(raw)
}
