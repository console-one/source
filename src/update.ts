import { LabelChange } from './label.js';
import { SourceID } from './sourceid.js';

export enum UpdateType {
  UPDATE = 0,
  CHECKPOINT = 1
}

export type SourceArtifact = [SourceID, UpdateType, string]

export type Lineage = [SourceArtifact, ...SourceArtifact[]];

/**
 * One saved version's update record.
 *
 * Generic over `TPatch` — the text engine uses `SourceChange`, but any
 * patch shape that round-trips through `ContentCodec.patchToJSON` /
 * `patchFromJSON` works. `patches` used to be called `sourceCodeChanges`
 * (pre-0.2.0).
 */
export class SourceUpdate<TPatch = unknown> {

  constructor(
    public readonly lineage: Lineage,
    public readonly patches: TPatch[],
    public readonly labelChanges: LabelChange[]) {

    if (this.lineage.length <= 0) throw new Error(`Lineage for an update item must always terminate
      with the version of the item itself — this array cannot be empty. Got patches:
      ${JSON.stringify(patches, null, 2)} and labels ${JSON.stringify(labelChanges, null, 2)}`);
  }

  get versionKey(): SourceID {
    return this.lineage[this.lineage.length - 1][0];
  }

  getVersionKey(): SourceID {
    return this.lineage[this.lineage.length - 1][0];
  }

  static fromJSON<TPatch>(
    json: any,
    patchFromJSON: (raw: any) => TPatch
  ): SourceUpdate<TPatch> {
    return new SourceUpdate<TPatch>(
      json.lineage.map((m: any) => [SourceID.fromJSON(m[0]), m[1] as keyof UpdateType, m[2]]),
      (json.patches ?? json.sourceCodeChanges ?? []).map((m: any) => patchFromJSON(m)),
      json.labelChanges.map((m: any) => LabelChange.fromJSON(m))
    );
  }
}
