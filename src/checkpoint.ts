import { Label } from './label.js';
import { SourceID } from './sourceid.js';
import { Lineage, UpdateType } from './update.js';

export class CheckpointMetadata {
  constructor(
    public readonly lineage: Lineage,
    public readonly labels: Label[]
  ) {
    if (this.lineage.length <= 0) throw new Error(`Lineage for a checkpoint item must always terminate
      with the version of the item itself — this array cannot be empty. Got labels:
      ${JSON.stringify(this.labels, null, 2)}`);
  }
  static fromJSON(json: any) {
    return new CheckpointMetadata(
      json.lineage.map((m: any) => [SourceID.fromJSON(m[0]), UpdateType[m[1]], m[2]]),
      json.labels.map((m: any) => Label.fromJSON(m))
    );
  }

  static Converter = {
    atob: (update: CheckpointMetadata) => JSON.stringify(update),
    btoa: (str: string) => CheckpointMetadata.fromJSON(JSON.parse(str))
  }
}

/**
 * Full content snapshot at one version.
 *
 * Generic over `TContent` — the text engine uses `string`, but a JSON
 * object, a Set, or any other T works as long as a `ContentCodec<T, _>`
 * can round-trip it to and from a string. `content` used to be called
 * `source` (pre-0.2.0).
 */
export class Checkpoint<TContent = string> {

  constructor(
    public readonly lineage: Lineage,
    public readonly content: TContent,
    public readonly labels: Label[]
  ) {
  }

  metadata() {
    return new CheckpointMetadata(this.lineage, this.labels);
  }
}
