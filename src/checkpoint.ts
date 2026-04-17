
import { Label } from './label.js';
import { SourceID } from './sourceid.js';
import { Lineage, UpdateType } from './update.js';

export class CheckpointMetadata {
  constructor(
    public readonly lineage: Lineage,
    public readonly labels: Label[]
  ) {
    if (this.lineage.length <= 0) throw new Error(`Lineage for a checkpoint item must always terminate
      with the version of the item iteself! Therefore this array cannot be empty. But it is, when 
      creating a checkpoint with labels: ${JSON.stringify(this.labels, null, 4)}`);
  }
  static fromJSON(json: any) {
    return new CheckpointMetadata(
      json.lineage.map(m => [SourceID.fromJSON(m[0]), UpdateType[m[1]], m[2]]),
      json.labels.map(m => Label.fromJSON(m))
    );
  }

  static Converter = {
    atob: (update: CheckpointMetadata) => {
      let stringified = JSON.stringify(update);
      return stringified;
    },
    btoa: (str: string) => {
      let json: any = JSON.parse(str);
      return CheckpointMetadata.fromJSON(json);
    }
  }
}

export class Checkpoint {

  constructor(
    public readonly lineage: Lineage,
    public readonly source: string,
    public readonly labels: Label[]
  ) {
  }

  metadata() {
    return new CheckpointMetadata(this.lineage, this.labels);
  }

  static fromJSON(json: any) {
    return new Checkpoint(
      json.lineage.map(m => [SourceID.fromJSON(m[0]), UpdateType[m[1]], m[2]]),
      json.source,
      json.labels.map(m => Label.fromJSON(m))
    );
  }

  static Converter = {
    atob: (update: Checkpoint) => JSON.stringify(update),
    btoa: (str: string) => {
      let json: any = JSON.parse(str);
      return Checkpoint.fromJSON(json);
    }
  }
}




