
import { SourceChange } from './change.js';
import { LabelChange } from './label.js';
import { SourceID } from './sourceid.js';

export enum UpdateType {
  UPDATE = 0,
  CHECKPOINT = 1
}

export type SourceArtifact = [SourceID, UpdateType, string]

export type Lineage = [SourceArtifact, ...SourceArtifact[]];

export class SourceUpdate {

  constructor(
    public readonly lineage: Lineage,
    public readonly sourceCodeChanges: SourceChange[],
    public readonly labelChanges: LabelChange[]) {

    if (this.lineage.length <= 0) throw new Error(`Lineage for an update item must always terminate
      with the version of the item iteself! Therefore this array cannot be empty. But it is, when 
      creating a source update with changes: ${JSON.stringify(sourceCodeChanges, null, 4)} and labels 
      ${JSON.stringify(labelChanges, null, 4)}`);
  }

  get versionKey(): SourceID {
    return this.lineage[this.lineage.length - 1][0];
  }

  getVersionKey(): SourceID {
    return this.lineage[this.lineage.length-1][0];
  }

  static fromJSON(json: any) {

    return new SourceUpdate(
      json.lineage.map(m => [SourceID.fromJSON(m[0]), m[1] as keyof UpdateType, m[2]]), 
      json.sourceCodeChanges.map(m => SourceChange.fromJSON(m)),
      json.labelChanges.map(m => LabelChange.fromJSON(m))
    );
  }

  static Converter = {
    atob: (update: SourceUpdate) => JSON.stringify(update),
    btoa: (str: string) => {
      let json: any = JSON.parse(str);
      return SourceUpdate.fromJSON(json);
    }
  }
}
